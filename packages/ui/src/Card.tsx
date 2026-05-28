import * as React from 'react';

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  /** Visual emphasis. `outlined` is the default; `elevated` adds a shadow. */
  variant?: 'outlined' | 'elevated';
};

export function Card({ variant = 'outlined', className, ...rest }: CardProps) {
  const classes = ['lbr-card', `lbr-card--${variant}`];
  if (className) classes.push(className);
  return <div className={classes.join(' ')} {...rest} />;
}

type CardHeaderProps = React.HTMLAttributes<HTMLDivElement> & {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
};

export function CardHeader({ title, subtitle, actions, className, ...rest }: CardHeaderProps) {
  const classes = ['lbr-card__header'];
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')} {...rest}>
      <div className="lbr-card__header-text">
        <h2 className="lbr-card__title">{title}</h2>
        {subtitle ? <p className="lbr-card__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="lbr-card__actions">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={['lbr-card__body', className].filter(Boolean).join(' ')} {...rest} />;
}
