import React from 'react';
import styled from '@emotion/styled';
import {css, ClassNames} from '@emotion/core';

import space from 'app/styles/space';
import {t} from 'app/locale';
import Button from 'app/components/button';
import {IconChevron} from 'app/icons';

import RulesList from './rulesList';
import {Rule} from './types';

type Props = {
  rules: Array<Rule>;
};

type State = {
  isCollapsed: boolean;
  contentHeight?: string;
};

class OrgRules extends React.Component<Props, State> {
  state: State = {
    isCollapsed: true,
  };

  componentDidMount() {
    this.loadContentHeight();
  }

  rulesListRef = React.createRef<HTMLUListElement>();

  loadContentHeight = () => {
    const contentHeight = this.rulesListRef.current?.offsetHeight;
    if (contentHeight) {
      this.setState({
        contentHeight: `${contentHeight}px`,
      });
    }
  };

  handleToggleCollapsed = () => {
    this.setState(prevState => ({
      isCollapsed: !prevState.isCollapsed,
    }));
  };

  render() {
    const {rules} = this.props;
    const {isCollapsed, contentHeight} = this.state;

    return (
      <ClassNames>
        {({css: classNamesCss}) => (
          <Wrapper isCollapsed={isCollapsed} contentHeight={contentHeight}>
            <Header>
              <div>{t('Organization Level Rules')}</div>
              <Button
                icon={<IconChevron size="xs" direction={isCollapsed ? 'down' : 'up'} />}
                size="xsmall"
                onClick={this.handleToggleCollapsed}
                labelClassName={classNamesCss`
                  padding: ${space(0.25)} ${space(0.5)};
                `}
              />
            </Header>
            <Content>
              <RulesList rules={rules} ref={this.rulesListRef} />
            </Content>
          </Wrapper>
        )}
      </ClassNames>
    );
  }
}

export default OrgRules;

const Header = styled('div')`
  padding: ${space(1)} ${space(2)};
  display: grid;
  grid-template-columns: auto 1fr;
  justify-items: flex-end;
  border-bottom: 1px solid ${p => p.theme.borderDark};
  align-items: center;
  color: ${p => p.theme.gray2};
  background: ${p => p.theme.offWhite};
  font-size: ${p => p.theme.fontSizeMedium};
`;

const Content = styled('div')`
  transition: height 300ms cubic-bezier(0.4, 0, 0.2, 1) 0ms;
  height: 0;
  overflow: hidden;
`;

const Wrapper = styled('div')<{isCollapsed: boolean; contentHeight?: string}>`
  font-size: ${p => p.theme.fontSizeMedium};
  color: ${p => p.theme.gray1};
  background: ${p => p.theme.offWhite};
  ${p =>
    !p.isCollapsed &&
    css`
      border-bottom: 1px solid ${p.theme.borderDark};
      ${p.contentHeight &&
        css`
          ${Content} {
            height: ${p.contentHeight};
          }
        `}
    `}
`;
