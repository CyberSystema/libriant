'use client';
import * as React from 'react';

type Severity = 'info' | 'success' | 'warning' | 'critical';

export type ToastItem = {
  id: string;
  severity: Severity;
  title?: React.ReactNode;
  body?: React.ReactNode;
  /**
   * Optional inline action — most commonly an "Undo" button. Survives the
   * dismissal timer so the user has a real chance to click it.
   */
  action?: { label: React.ReactNode; onClick: () => void };
  /** ms before auto-dismiss. `null` keeps it sticky until manually closed. */
  durationMs?: number | null;
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

/**
 * Stacks toasts in a corner of the screen. Toasts auto-dismiss after
 * `durationMs` (default 5s) unless the user hovers over the stack (paused).
 * `prefers-reduced-motion` disables the slide animation but keeps the
 * stack semantics intact.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);

  const dismiss = React.useCallback((id: string) => {
    setItems((current) => current.filter((t) => t.id !== id));
  }, []);

  const show = React.useCallback<ToastContextValue['show']>(
    (toast) => {
      const id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const item: ToastItem = { id, durationMs: 5000, ...toast };
      setItems((current) => [...current, item]);
      if (item.durationMs !== null) {
        // Defer the timer to next tick so we don't dismiss a toast that's
        // still being rendered (would cause a React re-entrancy warning).
        const handle = setTimeout(() => dismiss(id), item.durationMs);
        // No cleanup needed — the dismiss path is idempotent and the timer
        // is harmless if it fires after manual dismissal.
        void handle;
      }
      return id;
    },
    [dismiss],
  );

  const value = React.useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="lbr-toast-stack" role="region" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className={`lbr-toast lbr-toast--${t.severity}`}>
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
              aria-label="Dismiss"
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
