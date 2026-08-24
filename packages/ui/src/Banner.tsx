import * as React from 'react';

type Severity = 'info' | 'warning' | 'critical' | 'success';

type BannerBaseProps = React.HTMLAttributes<HTMLDivElement> & {
  severity?: Severity;
  title?: React.ReactNode;
};

/**
 * A dismiss button with no accessible name is worse than no dismiss button.
 * `dismissLabel` used to default to the English "Dismiss" and had zero call
 * sites passing it (frontend-13); pairing the two in the type means the
 * compiler asks for the label exactly when — and only when — one is needed.
 * Banner renders inside server components, so it cannot read the label from
 * `UiStringsProvider` the way the client-only dialogs do.
 */
type BannerProps = BannerBaseProps &
  (
    | { onDismiss: () => void; dismissLabel: string }
    | { onDismiss?: undefined; dismissLabel?: undefined }
  );

export function Banner({
  severity = 'info',
  title,
  onDismiss,
  dismissLabel,
  children,
  className,
  role,
  ...rest
}: BannerProps) {
  const classes = ['lbr-banner', `lbr-banner--${severity}`];
  if (className) classes.push(className);
  // `status` waits for a pause in whatever the screen reader is saying, which
  // is right for "saved" and wrong for "your checkout was refused". Critical
  // banners interrupt (frontend-20). A caller can still override.
  const resolvedRole = role ?? (severity === 'critical' ? 'alert' : 'status');
  return (
    <div role={resolvedRole} className={classes.join(' ')} {...rest}>
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
