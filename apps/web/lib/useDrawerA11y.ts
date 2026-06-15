'use client';
import * as React from 'react';

/**
 * Accessibility behaviour shared by the off-canvas mobile nav drawers (tenant +
 * admin shells). When the drawer is open it:
 *   • closes on Escape;
 *   • locks background scroll;
 *   • moves keyboard focus into the panel, and TRAPS Tab/Shift+Tab inside it so
 *     focus can't wander to the (visually hidden, but still in the DOM) page
 *     behind the scrim — the WAI-ARIA dialog requirement the drawer was missing;
 *   • restores focus to whatever was focused before it opened (the hamburger)
 *     when it closes.
 *
 * Returns a ref to put on the drawer panel (`<aside>`). The panel should also
 * carry `role="dialog"` + `aria-modal="true"` while open so assistive tech
 * treats the rest of the page as inert.
 */
export function useDrawerA11y<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
): React.RefObject<T | null> {
  const panelRef = React.useRef<T | null>(null);
  // Keep the latest onClose without re-running the effect on every render.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] => {
      if (!panel) return [];
      return Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    };

    // Move focus into the panel (first focusable, else the panel itself).
    const first = focusables()[0];
    if (first) first.focus();
    else if (panel) {
      panel.setAttribute('tabindex', '-1');
      panel.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === firstItem || !panel?.contains(active)) {
          e.preventDefault();
          lastItem.focus();
        }
      } else if (active === lastItem || !panel?.contains(active)) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      // Restore focus to the trigger so keyboard users land where they left off.
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  return panelRef;
}
