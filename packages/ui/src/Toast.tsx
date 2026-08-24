'use client';
import * as React from 'react';
import { openModalCount, resolveToastLayer, subscribeToModalLayer } from './layers';
import {
  liveRegionRoleFor,
  pauseTimer,
  remainingMs,
  resolveDuration,
  resumeTimer,
  startTimer,
  type ToastSeverity,
  type ToastTimer,
} from './toast-policy';
import { useUiStrings } from './ui-strings';

export type ToastItem = {
  id: string;
  severity: ToastSeverity;
  title?: React.ReactNode;
  body?: React.ReactNode;
  /**
   * Optional inline action — most commonly an "Undo" button. Survives the
   * dismissal timer so the user has a real chance to click it.
   */
  action?: { label: React.ReactNode; onClick: () => void };
  /**
   * ms before auto-dismiss. `null` keeps it sticky until manually closed.
   * Omit to take the severity's default from `toast-policy` — which is sticky
   * for `critical`, so errors do not expire unread.
   */
  durationMs?: number | null;
  /** Overrides the shared "Dismiss" label for this one toast. */
  dismissLabel?: string;
};

type ToastContextValue = {
  show: (toast: Omit<ToastItem, 'id'>) => string;
  dismiss: (id: string) => void;
};

const Ctx = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    throw new Error('useToast must be used inside a <ToastProvider>.');
  }
  return ctx;
}

type TimerEntry = { state: ToastTimer; handle: ReturnType<typeof setTimeout> | null };

/**
 * Stacks toasts in a corner of the screen.
 *
 * Timing (frontend-22, WCAG 2.1 SC 2.2.1). Durations come from
 * `toast-policy`: confirmations expire, `critical` toasts are sticky and wait
 * to be dismissed. Pointing at or tabbing into the stack pauses every running
 * timer and leaving resumes it with the time it had left — not a fresh 5 s and
 * not a lost one. The previous version's doc comment promised this pause and
 * the code had no hover handler at all; it does now.
 *
 * Stacking (frontend-05). A `<dialog>` opened with `showModal()` lives in the
 * browser's top layer, above every z-index, so a critical toast fired from
 * inside a modal was painted under the backdrop and the librarian saw nothing
 * happen. The stack promotes itself into the top layer as a `popover` and
 * re-promotes whenever a dialog joins after it — see `layers.ts` for the
 * measurements. It is still *inert* while a modal is open (the platform
 * blocks hit-testing outside the dialog), so a failure that happens with a
 * dialog up belongs in `Modal`'s `error` slot, not only in a toast.
 *
 * `prefers-reduced-motion` disables the slide animation but keeps the stack
 * semantics intact.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const ui = useUiStrings();

  const timersRef = React.useRef(new Map<string, TimerEntry>());
  const pausedRef = React.useRef(false);

  const dismiss = React.useCallback((id: string) => {
    const entry = timersRef.current.get(id);
    if (entry) {
      if (entry.handle !== null) clearTimeout(entry.handle);
      timersRef.current.delete(id);
    }
    setItems((current) => current.filter((t) => t.id !== id));
  }, []);

  /** (Re)schedule one toast's dismissal for whatever time it has left. */
  const arm = React.useCallback(
    (id: string) => {
      const entry = timersRef.current.get(id);
      if (!entry) return;
      if (entry.handle !== null) {
        clearTimeout(entry.handle);
        entry.handle = null;
      }
      const left = remainingMs(entry.state, Date.now());
      if (left === null) return; // sticky
      entry.handle = setTimeout(() => dismiss(id), left);
    },
    [dismiss],
  );

  const setPaused = React.useCallback(
    (paused: boolean) => {
      if (pausedRef.current === paused) return;
      pausedRef.current = paused;
      const now = Date.now();
      for (const [id, entry] of timersRef.current) {
        if (paused) {
          if (entry.handle !== null) {
            clearTimeout(entry.handle);
            entry.handle = null;
          }
          entry.state = pauseTimer(entry.state, now);
        } else {
          entry.state = resumeTimer(entry.state, now);
          arm(id);
        }
      }
    },
    [arm],
  );

  const show = React.useCallback<ToastContextValue['show']>(
    (toast) => {
      const id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const durationMs = resolveDuration(toast.severity, toast.durationMs);
      const item: ToastItem = { ...toast, id, durationMs };
      setItems((current) => [...current, item]);

      const now = Date.now();
      let state = startTimer(durationMs, now);
      // A toast that arrives while the user is already reading the stack must
      // not start counting down behind their back.
      if (pausedRef.current) state = pauseTimer(state, now);
      timersRef.current.set(id, { state, handle: null });
      if (!pausedRef.current) arm(id);
      return id;
    },
    [arm],
  );

  React.useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const entry of timers.values()) {
        if (entry.handle !== null) clearTimeout(entry.handle);
      }
      timers.clear();
    };
  }, []);

  const value = React.useMemo(() => ({ show, dismiss }), [show, dismiss]);

  const stackRef = React.useRef<HTMLDivElement>(null);
  const promotedRef = React.useRef(false);
  // Bumped by `layers.ts` whenever a dialog enters or leaves the top layer.
  const [modalGeneration, setModalGeneration] = React.useState(0);
  React.useEffect(() => subscribeToModalLayer(() => setModalGeneration((g) => g + 1)), []);

  React.useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const action = resolveToastLayer({
      supportsTopLayer: typeof el.showPopover === 'function',
      hasToasts: items.length > 0,
      promoted: promotedRef.current,
      openModals: openModalCount(),
      focusWithinStack: el.contains(document.activeElement),
    });
    if (action === 'none') return;

    const hide = () => {
      try {
        el.hidePopover();
      } catch {
        // Not currently showing; nothing to leave.
      }
    };
    try {
      if (action === 'demote') {
        hide();
        el.removeAttribute('popover');
        promotedRef.current = false;
        return;
      }
      if (action === 'repromote') hide();
      if (!el.hasAttribute('popover')) el.setAttribute('popover', 'manual');
      el.showPopover();
      promotedRef.current = true;
    } catch {
      // A browser that advertises showPopover but refuses to show must not be
      // left carrying the attribute: `[popover]` that is not open is
      // `display: none`, which would hide the stack completely. Drop back to
      // the plain `--lbr-z-toast` fallback.
      el.removeAttribute('popover');
      promotedRef.current = false;
    }
  }, [items, modalGeneration]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        ref={stackRef}
        className="lbr-toast-stack"
        role="region"
        aria-label={ui.notifications}
        aria-live="polite"
        aria-atomic="false"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={`lbr-toast lbr-toast--${t.severity}`}
            // Only errors carry their own role — see `liveRegionRoleFor`.
            role={liveRegionRoleFor(t.severity)}
          >
            <div className="lbr-toast__content">
              {t.title ? <strong className="lbr-toast__title">{t.title}</strong> : null}
              {t.body ? <div className="lbr-toast__body">{t.body}</div> : null}
            </div>
            {t.action ? (
              <button
                type="button"
                className="lbr-toast__action"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="lbr-toast__close"
              aria-label={t.dismissLabel ?? ui.dismiss}
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
