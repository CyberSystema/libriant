import * as React from 'react';
import { Banner } from './Banner';

/**
 * A form's error slot, mounted whether or not there is an error.
 *
 * frontend-20's other half. Every form in this product wrote
 * `{error ? <Banner severity="critical">{error}</Banner> : null}`, which looks
 * correct and announces nothing: a live region has to EXIST before its content
 * changes for a screen reader to notice the change. Creating the region and its
 * text in the same render is the one arrangement that is reliably silent. So a
 * librarian using a screen reader submitted the login form, was refused, and
 * heard nothing at all — the page simply sat there.
 *
 * The wrapper below is always in the tree. Only its CONTENTS change, which is
 * the mutation assistive technology is watching for.
 *
 * `role="alert"` sits on the wrapper, and the inner Banner is given
 * `role="none"` so the same text is not announced twice by nested live regions.
 * A form error is assertive on purpose: it is the direct consequence of the
 * action the reader just took, and waiting for a pause means waiting past the
 * moment they were listening.
 *
 * Renders nothing visible when empty, so it costs no layout.
 */
export function FormError({
  children,
  className,
  style,
}: {
  /** The message, or null/undefined/'' when the form is clean. */
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const hasError =
    children !== null && children !== undefined && children !== false && children !== '';
  return (
    <div role="alert" aria-live="assertive" className={className} style={style}>
      {hasError ? (
        // role="none": the wrapper above is already the live region. Nesting a
        // second one makes some screen readers read the message twice.
        <Banner severity="critical" role="none">
          {children}
        </Banner>
      ) : null}
    </div>
  );
}
