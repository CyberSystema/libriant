import * as React from 'react';
import { Asset } from './Asset';
import type { AssetName } from './asset-manifest';

type EmptyStateProps = {
  illustration?: AssetName;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
};

/**
 * Empty states are tutorials, not voids. Always pair the illustration with
 * a clear next step the user can take.
 */
export function EmptyState({ illustration, title, description, action }: EmptyStateProps) {
  return (
    <div className="lbr-empty">
      {illustration ? (
        <Asset name={illustration} className="lbr-empty__illustration" />
      ) : null}
      <h2 className="lbr-empty__title">{title}</h2>
      {description ? <p className="lbr-empty__description">{description}</p> : null}
      {action ? <div className="lbr-empty__action">{action}</div> : null}
    </div>
  );
}
