'use client';
import * as React from 'react';

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

/**
 * Bare `<input>` with library styling. Most code should use `FormField`
 * which wires this together with a label + helptext + error message.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, ...rest },
  ref,
) {
  const classes = ['lbr-input'];
  if (invalid) classes.push('lbr-input--invalid');
  if (className) classes.push(className);
  return <input ref={ref} className={classes.join(' ')} aria-invalid={invalid} {...rest} />;
});

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, ...rest },
  ref,
) {
  const classes = ['lbr-input', 'lbr-input--textarea'];
  if (invalid) classes.push('lbr-input--invalid');
  if (className) classes.push(className);
  return <textarea ref={ref} className={classes.join(' ')} aria-invalid={invalid} {...rest} />;
});
