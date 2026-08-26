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
 * Renders nothing visible when empty, so it costs no layout — which is why
 * `className`/`style` are applied only when there IS an error. Every call site
 * passes a `marginBottom`, and an always-mounted empty div wearing that margin
 * left a permanent gap above the first field of every form it guarded.
 *
 * Dropping its OWN margin was not enough, because a parent's `gap` is not the
 * empty div's to drop: four call sites (the import wizard, the library-request
 * queue, account recovery, the email outbox) put this as a child of
 * `display: grid; gap: var(--sp-4)`, and an empty div is still a grid item — it
 * takes a track, and the track takes a gap. Measured in the browser on that
 * exact shape: the first field started 32px lower and the grid was 144px tall
 * instead of 112px, with nothing in the space.
 *
 * So when it is empty it is taken out of flow entirely and lays out nothing.
 * `display: contents` measures identically (also 0px / 112px) and was the
 * obvious candidate, but it is the one option that risks the whole point of
 * this component: an element that generates no box has a history of being
 * dropped from the accessibility tree, and this region has to EXIST, in that
 * tree, before it has anything to say. An absolutely-positioned empty box
 * generates no track and no gap while staying an ordinary, rendered element.
 */
/**
 * The empty state's only style. Module-level so React sees the same object on
 * every render of every instance rather than a fresh one each time.
 */
const OUT_OF_FLOW: React.CSSProperties = { position: 'absolute' };

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
    <div
      role="alert"
      aria-live="assertive"
      className={hasError ? className : undefined}
      style={hasError ? style : OUT_OF_FLOW}
    >
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
