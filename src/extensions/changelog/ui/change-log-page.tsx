import React, { HTMLAttributes, useContext } from 'react';
import classNames from 'classnames';
import { H1 } from '@bit/bit.evangelist.elements.heading';
import { Separator } from '@bit/bit.test-scope.ui.separator';
import { VersionBlock } from '../../stage-components/workspace-sections/version-block';
// TODO - @oded replace hard coded type once we get real data
import { Version } from '../../stage-components/workspace-sections/version-block/change-log.data';
import styles from './change-log-page.module.scss';
import { ComponentContext } from '../../component/ui';

type ChangeLogPageProps = {
  versions: Version[];
} & HTMLAttributes<HTMLDivElement>;

// @graphqlConnector()
export function ChangeLogPage({ versions, className }: ChangeLogPageProps) {
  const component = useContext(ComponentContext);
  if (!versions) return <div>No tags yet</div>;
  const tags = component.tags.toArray();

  return (
    <div className={classNames(styles.changeLogPage, className)}>
      <H1 className={styles.title}>History</H1>
      <Separator className={styles.separator} />
      {versions.map((version, index) => (
        <VersionBlock key={index} version={version} />
      ))}
    </div>
  );
}
