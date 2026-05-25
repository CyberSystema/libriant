import * as React from 'react';

type Severity = 'info' | 'warning' | 'critical' | 'success';

type BannerProps = React.HTMLAttributes<HTMLDivElement> & {
  severity?: Severity;
  title?: React.ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
};

export function Banner({
  severity = 'info',
  title,
  onDismiss,
  dismissLabel = 'Dismiss',
  children,
  className,
  ...rest
}: BannerProps) {
  const classes = ['lbr-banner', `lbr-banner--${severity}`];
  if (className) classes.push(className);
  return (
    <div role="status" aria-live="polite" className={classes.join(' ')} {...rest}>
      <div className="lbr-banner__content">
        {title ? <strong className="lbr-banner__title">{title}</strong> : null}
        <div className="lbr-banner__body">{children}</div>
      </div>
      {onDismiss ? (
        <button
          type="button"
          className="lbr-banner__dismiss"
          aria-label={dismissLabel}
          onClick={onDismiss}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
