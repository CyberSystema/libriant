'use client';
import * as React from 'react';

type Step = {
  /** URL-shaped slug for the step ("welcome" / "member" / "book"). */
  key: string;
  /** Plain-language label shown next to / under the number. */
  label: string;
  done: boolean;
};

type Props = {
  steps: Step[];
  current: string;
};

/** Numbered progress strip above the wizard. */
export function StepIndicator({ steps, current }: Props) {
  return (
    <ol
      aria-label="Onboarding progress"
      style={{
        display: 'flex',
        gap: 'var(--sp-2)',
        listStyle: 'none',
        margin: '0 0 var(--sp-6) 0',
        padding: 0,
      }}
    >
      {steps.map((s, ix) => {
        const isCurrent = s.key === current;
        const palette = s.done
          ? {
              bg: 'var(--color-success)',
              fg: 'var(--color-primary-fg)',
              border: 'var(--color-success)',
            }
          : isCurrent
            ? {
                bg: 'var(--color-primary)',
                fg: 'var(--color-primary-fg)',
                border: 'var(--color-primary)',
              }
            : {
                bg: 'var(--color-surface)',
                fg: 'var(--color-text-muted)',
                border: 'var(--color-border)',
              };
        return (
          <li
            key={s.key}
            aria-current={isCurrent ? 'step' : undefined}
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--sp-2)',
              padding: 'var(--sp-2) var(--sp-3)',
              background: palette.bg,
              color: palette.fg,
              border: `1px solid ${palette.border}`,
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--fs-sm)',
              fontWeight: isCurrent ? 600 : 400,
            }}
          >
            <span
              aria-hidden
              style={{
                width: '1.5rem',
                height: '1.5rem',
                borderRadius: '50%',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(255,255,255,0.2)',
                fontWeight: 700,
              }}
            >
              {s.done ? '✓' : ix + 1}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
