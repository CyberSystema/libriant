import * as React from 'react';

type NavProps = React.HTMLAttributes<HTMLElement> & {
  /** Visible label for screen readers ("Main navigation"). */
  ariaLabel: string;
};

export function Nav({ ariaLabel, className, children, ...rest }: NavProps) {
  const classes = ['lbr-nav'];
  if (className) classes.push(className);
  return (
    <nav aria-label={ariaLabel} className={classes.join(' ')} {...rest}>
      {children}
    </nav>
  );
}

type NavLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  /** Whether this is the currently active route. */
  active?: boolean;
  /** Optional leading icon — usually an `<Asset>` instance. */
  icon?: React.ReactNode;
};

/**
 * Plain `<a>` styled as a nav row. Server-component-friendly. Consumers
 * supply their own `href` and `active` flag (which they compute from the
 * current path in their layout).
 */
export function NavLink({ active, icon, className, children, ...rest }: NavLinkProps) {
  const classes = ['lbr-nav__link'];
  if (active) classes.push('lbr-nav__link--active');
  if (className) classes.push(className);
  return (
    <a {...rest} className={classes.join(' ')} aria-current={active ? 'page' : undefined}>
      {icon ? <span className="lbr-nav__link-icon">{icon}</span> : null}
      <span className="lbr-nav__link-label">{children}</span>
    </a>
  );
}
