'use client';
import * as React from 'react';

type FormFieldProps = {
  /** Stable id used by the label `for` and the input `id`. */
  id: string;
  /** What this field is for, in plain language. */
  label: React.ReactNode;
  /**
   * Pre-render help text shown below the field when no error is active.
   * Use to describe constraints in friendly terms ("at least 12 characters").
   */
  hint?: React.ReactNode;
  /**
   * Field-level error. When set, the field is announced as invalid and the
   * hint is hidden — we don't want to compete with the actionable error.
   */
  error?: React.ReactNode;
  /** Mark visually as required. Server-side validation is still the source of truth. */
  required?: boolean;
  /**
   * The actual input. We inject `id`, `aria-describedby`, and `aria-invalid`
   * via `React.cloneElement` so the consumer doesn't have to keep them in sync.
   */
  children: React.ReactElement<{
    id?: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean | 'true' | 'false';
    invalid?: boolean;
  }>;
  className?: string;
};

/**
 * Composable form field. Wraps an `<Input>` (or any single child) with a
 * label, optional hint, and optional inline error. Wires up all the ARIA
 * relationships so screen-reader users hear the error or the hint as part
 * of the field, not as decoupled text.
 */
export function FormField({
  id,
  label,
  hint,
  error,
  required,
  children,
  className,
}: FormFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const classes = ['lbr-field'];
  if (error) classes.push('lbr-field--invalid');
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')}>
      <label htmlFor={id} className="lbr-field__label">
        {label}
        {required ? (
          <span aria-hidden="true" className="lbr-field__required">
            *
          </span>
        ) : null}
      </label>
      {React.cloneElement(children, {
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        invalid: error ? true : undefined,
      })}
      {error ? (
        <p id={errorId} className="lbr-field__error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="lbr-field__hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
