import * as React from 'react';

type PageHeaderProps = {
  /** Page name (h1). Plain language. */
  title: React.ReactNode;
  /** One-sentence description rendered below the title. */
  subtitle?: React.ReactNode;
  /** Trailing actions — buttons, dropdowns, etc. Right-aligned on wide screens. */
  actions?: React.ReactNode;
  /** Breadcrumb-like trail. Optional; rendered above the title. */
  trail?: React.ReactNode;
  className?: string;
};

/**
 * Shared header for every tenant-scoped page. Holds the page title, a
 * one-sentence subtitle, optional breadcrumb trail, and primary actions.
 */
export function PageHeader({ title, subtitle, actions, trail, className }: PageHeaderProps) {
  const classes = ['lbr-page-header'];
  if (className) classes.push(className);
  return (
    <header className={classes.join(' ')}>
      {trail ? <div className="lbr-page-header__trail">{trail}</div> : null}
      <div className="lbr-page-header__row">
        <div className="lbr-page-header__text">
          <h1 className="lbr-page-header__title">{title}</h1>
          {subtitle ? <p className="lbr-page-header__subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="lbr-page-header__actions">{actions}</div> : null}
      </div>
    </header>
  );
}
