from __future__ import absolute_import

import six

from collections import namedtuple, defaultdict
from django.utils.translation import ugettext_lazy as _

from sentry.identity.pipeline import IdentityProviderPipeline
from sentry.integrations import (
    IntegrationFeatures,
    IntegrationMetadata,
    IntegrationProvider,
    FeatureDescription,
    IntegrationInstallation,
)

from sentry.models import Integration, Rule, RuleStatus
from sentry.pipeline import NestedPipelineView, PipelineView
from sentry.utils.http import absolute_uri
from sentry.shared_integrations.exceptions import ApiError, IntegrationError
from sentry.integrations.slack import post_migration

from .client import SlackClient
from .utils import logger

from sentry.web.helpers import render_to_response


Channel = namedtuple("Channel", ["name", "id"])

DESCRIPTION = """
Connect your Sentry organization to one or more Slack workspaces, and start
getting errors right in front of you where all the action happens in your
office!
"""

FEATURES = [
    FeatureDescription(
        """
        Unfurls Sentry URLs directly within Slack, providing you context and
        actionability on issues right at your fingertips. Resolve, ignore, and assign issues with minimal context switching.
        """,
        IntegrationFeatures.CHAT_UNFURL,
    ),
    FeatureDescription(
        """
        Configure rule based Slack notifications to automatically be posted into a
        specific channel. Want any error that's happening more than 100 times a
        minute to be posted in `#critical-errors`? Setup a rule for it!
        """,
        IntegrationFeatures.ALERT_RULE,
    ),
]

setup_alert = {
    "type": "info",
    "text": "The Slack integration adds a new Alert Rule action to all projects. To enable automatic notifications sent to Slack you must create a rule using the slack workspace action in your project settings.",
}

reauthentication_alert = {
    "alertText": "Upgrade Slack to avoid any disruption to service. It'll be worth it, we promise.",
}

metadata = IntegrationMetadata(
    description=_(DESCRIPTION.strip()),
    features=FEATURES,
    author="The Sentry Team",
    noun=_("Workspace"),
    issue_url="https://github.com/getsentry/sentry/issues/new?title=Slack%20Integration:%20&labels=Component%3A%20Integrations",
    source_url="https://github.com/getsentry/sentry/tree/master/src/sentry/integrations/slack",
    aspects={"alerts": [setup_alert], "reauthentication_alert": reauthentication_alert},
)


class SlackIntegration(IntegrationInstallation):
    def get_config_data(self):
        metadata = self.model.metadata
        # classic bots had a user_access_token in the metadata
        default_installation = "classic_bot" if "user_access_token" in metadata else "workspace_app"
        return {"installationType": metadata.get("installation_type", default_installation)}


class SlackIntegrationProvider(IntegrationProvider):
    key = "slack"
    name = "Slack"
    metadata = metadata
    features = frozenset([IntegrationFeatures.CHAT_UNFURL, IntegrationFeatures.ALERT_RULE])
    integration_cls = SlackIntegration

    # some info here: https://api.slack.com/authentication/quickstart
    identity_oauth_scopes = frozenset(
        [
            "channels:read",
            "groups:read",
            "users:read",
            "chat:write",
            "links:read",
            "links:write",
            "team:read",
            "im:read",
            "chat:write.public",
            "chat:write.customize",
        ]
    )

    setup_dialog_config = {"width": 600, "height": 900}

    def get_pipeline_views(self):
        identity_pipeline_config = {
            "oauth_scopes": self.identity_oauth_scopes,
            "user_scopes": frozenset(["links:read"]),
            "redirect_url": absolute_uri("/extensions/slack/setup/"),
        }

        identity_pipeline_view = NestedPipelineView(
            bind_key="identity",
            provider_key="slack",
            pipeline_cls=IdentityProviderPipeline,
            config=identity_pipeline_config,
        )

        return [SlackReAuthIntro(), SlackReAuthChannels(), identity_pipeline_view]

    def get_team_info(self, access_token):
        payload = {"token": access_token}

        client = SlackClient()
        try:
            resp = client.get("/team.info", params=payload)
        except ApiError as e:
            logger.error("slack.team-info.response-error", extra={"error": six.text_type(e)})
            raise IntegrationError("Could not retrieve Slack team information.")

        return resp["team"]

    def build_integration(self, state):
        data = state["identity"]["data"]
        assert data["ok"]

        access_token = data["access_token"]
        # bot apps have a different response format
        # see: https://api.slack.com/authentication/quickstart#installing
        user_id_slack = data["authed_user"]["id"]
        team_name = data["team"]["name"]
        team_id = data["team"]["id"]

        scopes = sorted(self.identity_oauth_scopes)
        team_data = self.get_team_info(access_token)

        metadata = {
            "access_token": access_token,
            "scopes": scopes,
            "icon": team_data["icon"]["image_132"],
            "domain_name": team_data["domain"] + ".slack.com",
            "installation_type": "born_as_bot",
        }

        integration = {
            "name": team_name,
            "external_id": team_id,
            "metadata": metadata,
            "user_identity": {
                "type": "slack",
                "external_id": user_id_slack,
                "scopes": [],
                "data": {},
            },
        }

        # if we have the integration_id then we need to set the
        # information for the migration, the user_id and channels
        # are using in post_install to send messages to slack
        if state.get("integration_id"):
            metadata["installation_type"] = "migrated_to_bot"

            post_install_data = {
                "user_id": state["user_id"],
                "private_channels": state["private_channels"],
                "missing_channels": state["missing_channels"],
            }

            integration["integration_id"] = state.get("integration_id")
            integration["post_install_data"] = post_install_data

        return integration

    def post_install(self, integration, organization, extra=None):
        # normal installtions don't have extra, quit immediately
        if extra is None:
            return

        private_channels = extra.get("private_channels")
        missing_channels = extra.get("missing_channels")
        run_args = {
            "integration_id": integration.id,
            "organization_id": organization.id,
            "user_id": extra.get("user_id"),
            "private_channels": private_channels,
            "missing_channels": missing_channels,
        }
        if private_channels or missing_channels:
            post_migration.run_post_migration.apply_async(kwargs=run_args)
        else:
            # if we don't have channels, log it so we know we skipped this
            logger.info("slack.integration.skipped_post_migration", extra=run_args)


class SlackReAuthIntro(PipelineView):
    """
        This pipeline step handles rendering the migration
        intro with context about the migration.

        If the `integration_id` is not present in the request
        then we can fast forward through the pipeline to move
        on to installing the integration as normal.

    """

    def dispatch(self, request, pipeline):
        if "integration_id" in request.GET:
            pipeline.bind_state("integration_id", request.GET["integration_id"])
            pipeline.bind_state("user_id", request.user.id)

            try:
                all_channels = _get_channels_from_rules(pipeline)
            except IntegrationError as error:
                return pipeline.error(error)

            pipeline.bind_state("all_channels", all_channels)

            next_param = "?show_verification_results"

            return render_to_response(
                template="sentry/integrations/slack-reauth-introduction.html",
                context={
                    "next_url": "%s%s" % (absolute_uri("/extensions/slack/setup/"), next_param),
                },
                request=request,
            )

        if "show_verification_results" in request.GET:
            return pipeline.next_step()

        # if we dont have the integration_id we dont care about the
        # migration path, skip straight to install
        pipeline.state.step_index = 2
        return pipeline.current_step()


class SlackReAuthChannels(PipelineView):
    """
        This pipeline step handles making requests to Slack and
        displaying the channels (if any) that are problematic:

        1. private
        2. removed
        3. unauthorized

        Any private channels in alert rules will also be binded
        to the pipeline state to be used later.

    """

    def dispatch(self, request, pipeline):
        if "start_migration" in request.GET:
            return pipeline.next_step()

        next_url_param = "?start_migration"

        try:
            channels = _request_channel_info(pipeline)
        except IntegrationError as error:
            return pipeline.error(error)

        return render_to_response(
            template="sentry/integrations/slack-reauth-details.html",
            context={
                "next_url": "%s%s" % (absolute_uri("/extensions/slack/setup/"), next_url_param),
                "private": channels["private"],
                "no_permission": channels["no_permission"],
                "not_found": channels["channel_not_found"],
            },
            request=request,
        )


def _request_channel_info(pipeline):
    channels = pipeline.fetch_state("all_channels")
    integration_id = pipeline.fetch_state("integration_id")

    try:
        integration = Integration.objects.get(id=integration_id, provider="slack",)
    except Integration.DoesNotExist:
        raise IntegrationError("Could not find Slack integration.")

    channel_responses = defaultdict(lambda: set())
    for channel in channels:
        payload = {
            "token": integration.metadata["access_token"],
            "channel": channel["id"],
        }
        client = SlackClient()
        try:
            resp = client.post("/conversations.info", data=payload)
            # TODO(meredith): subclass the ApiError and make a SlackApiError so we can
            # reraise the other errors
        except ApiError as e:
            logger.info(
                "slack.request_channel_info.response-error",
                extra={
                    "error": six.text_type(e),
                    "channel": channel["id"],
                    "integration_id": integration.id,
                },
            )
            # regardless of the type of error, we are going to group the channels together
            # when showing this to the user to make things a bit simpler
            channel_responses["not_found"].add(Channel(channel["name"], channel["id"]))
            continue

        if resp["channel"]["is_private"]:
            channel_responses["private"].add(Channel(channel["name"], channel["id"]))

    pipeline.bind_state("private_channels", channel_responses["private"])
    pipeline.bind_state("missing_channels", channel_responses["not_found"])
    return channel_responses


def _get_channels_from_rules(pipeline):
    organization = pipeline.organization
    integration_id = pipeline.fetch_state("integration_id")

    try:
        integration = Integration.objects.get(id=integration_id, provider="slack",)
    except Integration.DoesNotExist:
        raise IntegrationError("Could not find Slack integration.")

    rules = Rule.objects.filter(
        project__in=organization.project_set.all(), status=RuleStatus.ACTIVE,
    )

    channels = set()
    for rule in rules:
        # try and see if its used for slack
        for rule_action in rule.data["actions"]:
            rule_integration_id = rule_action.get("workspace")
            if rule_integration_id and rule_integration_id == six.text_type(integration.id):

                channel_id = rule_action["channel_id"]
                channel_name = rule_action["channel"]

                # don't care if its a user
                if channel_name[0] == "@":
                    continue

                channels.add(Channel(channel_name, channel_id))

    return channels
