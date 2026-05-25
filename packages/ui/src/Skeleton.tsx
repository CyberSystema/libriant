import * as React from 'react';

type SkeletonProps = React.HTMLAttributes<HTMLDivElement> & {
  width?: number | string;
  height?: number | string;
  radius?: 'sm' | 'md' | 'lg' | 'full';
};

export function Skeleton({
  width = '100%',
  height = '1em',
  radius = 'sm',
  style,
  className,
  ...rest
}: SkeletonProps) {
  const classes = ['lbr-skeleton', `lbr-skeleton--r-${radius}`];
  if (className) classes.push(className);
  return (
    <div
      aria-hidden="true"
      className={classes.join(' ')}
      style={{ width, height, ...style }}
      {...rest}
    />
  );
}
