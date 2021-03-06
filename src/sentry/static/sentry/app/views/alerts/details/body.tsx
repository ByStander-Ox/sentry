import {RouteComponentProps} from 'react-router/lib/Router';
import React from 'react';
import styled from '@emotion/styled';

import {
  AlertRuleAggregations,
  AlertRuleThresholdType,
  Trigger,
} from 'app/views/settings/incidentRules/types';
import {NewQuery, Project} from 'app/types';
import {PageContent} from 'app/styles/organization';
import {defined} from 'app/utils';
import {getDisplayForAlertRuleAggregation} from 'app/views/alerts/utils';
import {getUtcDateString} from 'app/utils/dates';
import {t} from 'app/locale';
import Alert from 'app/components/alert';
import Duration from 'app/components/duration';
import EventView from 'app/utils/discover/eventView';
import Feature from 'app/components/acl/feature';
import Link from 'app/components/links/link';
import NavTabs from 'app/components/navTabs';
import Placeholder from 'app/components/placeholder';
import SeenByList from 'app/components/seenByList';
import {IconTelescope, IconWarning, IconLink} from 'app/icons';
import {SectionHeading} from 'app/components/charts/styles';
import Projects from 'app/utils/projects';
import space from 'app/styles/space';
import theme from 'app/utils/theme';

import {
  Incident,
  IncidentStats,
  AlertRuleStatus,
  IncidentStatus,
  IncidentStatusMethod,
} from '../types';
import Activity from './activity';
import Chart from './chart';

type Props = {
  incident?: Incident;
  stats?: IncidentStats;
} & RouteComponentProps<{alertId: string; orgId: string}, {}>;

export default class DetailsBody extends React.Component<Props> {
  getDiscoverUrl(projects: Project[]) {
    const {incident, params, stats} = this.props;
    const {orgId} = params;

    if (!projects || !projects.length || !incident || !stats) {
      return '';
    }

    const timeWindowString = `${incident.alertRule.timeWindow}m`;
    const start = getUtcDateString(stats.eventStats.data[0][0] * 1000);
    const end = getUtcDateString(
      stats.eventStats.data[stats.eventStats.data.length - 1][0] * 1000
    );

    const discoverQuery: NewQuery = {
      id: undefined,
      name: (incident && incident.title) || '',
      fields: ['issue', 'title', 'count(id)', 'count_unique(user.id)'],
      orderby:
        incident.alertRule.aggregation === AlertRuleAggregations.UNIQUE_USERS
          ? '-count_unique_user_id'
          : '-count_id',
      query: incident?.discoverQuery ?? '',
      projects: projects
        .filter(({slug}) => incident.projects.includes(slug))
        .map(({id}) => Number(id)),
      version: 2 as const,
      start,
      end,
    };

    const discoverView = EventView.fromSavedQuery(discoverQuery);
    const {query, ...toObject} = discoverView.getResultsViewUrlTarget(orgId);

    return {
      query: {...query, interval: timeWindowString},
      ...toObject,
    };
  }

  /**
   * Return a string describing the threshold based on the threshold and the type
   */
  getThresholdText(
    trigger: Trigger | undefined,
    key: 'alertThreshold' | 'resolveThreshold'
  ) {
    if (!trigger || typeof trigger[key] !== 'number') {
      return '';
    }

    const isAbove = trigger.thresholdType === AlertRuleThresholdType.ABOVE;
    const isAlert = key === 'alertThreshold';
    const direction = isAbove === isAlert ? '>' : '<';

    return `${direction} ${trigger[key]}`;
  }

  renderRuleDetails() {
    const {incident} = this.props;

    if (incident === undefined) {
      return <Placeholder height="200px" />;
    }

    const criticalTrigger = incident?.alertRule.triggers.find(
      ({label}) => label === 'critical'
    );
    const warningTrigger = incident?.alertRule.triggers.find(
      ({label}) => label === 'warning'
    );

    return (
      <RuleDetails>
        <span>{t('Metric')}</span>
        <span>
          {incident && getDisplayForAlertRuleAggregation(incident.alertRule?.aggregation)}
        </span>

        <span>{t('Critical Trigger')}</span>
        <span>{this.getThresholdText(criticalTrigger, 'alertThreshold')}</span>

        {defined(criticalTrigger?.resolveThreshold) && (
          <React.Fragment>
            <span>{t('Critical Resolution')}</span>
            <span>{this.getThresholdText(criticalTrigger, 'resolveThreshold')}</span>
          </React.Fragment>
        )}

        {defined(warningTrigger) && (
          <React.Fragment>
            <span>{t('Warning Trigger')}</span>
            <span>{this.getThresholdText(warningTrigger, 'alertThreshold')}</span>

            {defined(warningTrigger?.resolveThreshold) && (
              <React.Fragment>
                <span>{t('Warning Resolution')}</span>
                <span>{this.getThresholdText(warningTrigger, 'resolveThreshold')}</span>
              </React.Fragment>
            )}
          </React.Fragment>
        )}

        <span>{t('Time Window')}</span>
        <span>
          {incident && <Duration seconds={incident.alertRule.timeWindow * 60} />}
        </span>
      </RuleDetails>
    );
  }

  render() {
    const {params, incident, stats} = this.props;

    return (
      <StyledPageContent>
        {incident &&
          incident.status === IncidentStatus.CLOSED &&
          incident.statusMethod === IncidentStatusMethod.RULE_UPDATED && (
            <AlertWrapper>
              <Alert type="warning" icon={<IconWarning size="sm" />}>
                {t(
                  'This alert has been auto-resolved because the rule that triggered it has been modified or deleted'
                )}
              </Alert>
            </AlertWrapper>
          )}
        <ChartWrapper>
          {incident && stats ? (
            <Chart
              aggregation={incident.alertRule.aggregation}
              data={stats.eventStats.data}
              detected={incident.dateDetected}
              closed={incident.dateClosed}
            />
          ) : (
            <Placeholder height="200px" />
          )}
        </ChartWrapper>

        <Main>
          <ActivityPageContent>
            <StyledNavTabs underlined>
              <li className="active">
                <Link to="">{t('Activity')}</Link>
              </li>

              <SeenByTab>
                {incident && (
                  <StyledSeenByList
                    iconPosition="right"
                    seenBy={incident.seenBy}
                    iconTooltip={t('People who have viewed this alert')}
                  />
                )}
              </SeenByTab>
            </StyledNavTabs>
            <Activity
              incident={incident}
              params={params}
              incidentStatus={!!incident ? incident.status : null}
            />
          </ActivityPageContent>
          <Sidebar>
            <SidebarHeading>
              <span>{t('Alert Rule')}</span>
              {incident?.alertRule?.status !== AlertRuleStatus.SNAPSHOT && (
                <SideHeaderLink
                  to={{
                    pathname: `/settings/${params.orgId}/projects/${incident?.projects[0]}/alerts/metric-rules/${incident?.alertRule?.id}/`,
                  }}
                >
                  {t('View Rule')}
                  <IconLink size="xs" />
                </SideHeaderLink>
              )}
            </SidebarHeading>
            {this.renderRuleDetails()}

            <SidebarHeading>
              <span>{t('Query')}</span>
              <Feature features={['discover-basic']}>
                <Projects slugs={incident?.projects} orgId={params.orgId}>
                  {({initiallyLoaded, fetching, projects}) => (
                    <SideHeaderLink
                      disabled={!incident || fetching || !initiallyLoaded}
                      to={this.getDiscoverUrl(
                        ((initiallyLoaded && projects) as Project[]) || []
                      )}
                    >
                      {t('View in Discover')}
                      <IconTelescope size="xs" />
                    </SideHeaderLink>
                  )}
                </Projects>
              </Feature>
            </SidebarHeading>
            {incident ? (
              <Query>{incident?.alertRule.query || '""'}</Query>
            ) : (
              <Placeholder height="30px" />
            )}
          </Sidebar>
        </Main>
      </StyledPageContent>
    );
  }
}

const Main = styled('div')`
  display: flex;
  flex: 1;
  border-top: 1px solid ${p => p.theme.borderLight};
  background-color: ${p => p.theme.white};

  @media (max-width: ${p => p.theme.breakpoints[0]}) {
    flex-direction: column-reverse;
  }
`;

const ActivityPageContent = styled(PageContent)`
  @media (max-width: ${theme.breakpoints[0]}) {
    width: 100%;
    margin-bottom: 0;
  }
`;

const Sidebar = styled(PageContent)`
  width: 400px;
  flex: none;
  padding-top: ${space(3)};

  @media (max-width: ${theme.breakpoints[0]}) {
    width: 100%;
    padding-top: ${space(3)};
    margin-bottom: 0;
    border-bottom: 1px solid ${p => p.theme.borderLight};
  }
`;

const SidebarHeading = styled(SectionHeading)`
  display: flex;
  justify-content: space-between;
`;

const SideHeaderLink = styled(Link)`
  display: grid;
  grid-auto-flow: column;
  align-items: center;
  grid-gap: ${space(0.5)};
  font-weight: normal;
`;

const StyledPageContent = styled(PageContent)`
  padding: 0;
  flex-direction: column;
`;

const ChartWrapper = styled('div')`
  padding: ${space(2)};
`;

const AlertWrapper = styled('div')`
  padding: ${space(2)} ${space(4)} 0;
`;

const StyledNavTabs = styled(NavTabs)`
  display: flex;
`;

const SeenByTab = styled('li')`
  flex: 1;
  margin-left: ${space(2)};
  margin-right: 0;

  .nav-tabs > & {
    margin-right: 0;
  }
`;

const StyledSeenByList = styled(SeenByList)`
  margin-top: 0;
`;

const RuleDetails = styled('div')`
  display: grid;
  font-size: ${p => p.theme.fontSizeSmall};
  grid-template-columns: auto max-content;
  margin-bottom: ${space(2)};

  & > span {
    padding: ${space(0.5)} ${space(1)};
  }

  & > span:nth-child(2n + 2) {
    text-align: right;
  }

  & > span:nth-child(4n + 1),
  & > span:nth-child(4n + 2) {
    background-color: ${p => p.theme.offWhite};
  }
`;

const Query = styled('div')`
  font-family: ${p => p.theme.text.familyMono};
  font-size: ${p => p.theme.fontSizeSmall};
  background-color: ${p => p.theme.offWhite};
  padding: ${space(0.5)} ${space(1)};
  color: ${p => p.theme.gray4};
`;
