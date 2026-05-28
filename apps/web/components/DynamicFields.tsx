'use client';
import * as React from 'react';
import { FormField, Input, Textarea } from '@libriant/ui';
import type { Locale } from '@libriant/i18n';

/**
 * One field definition as returned by `GET /t/:slug/data-model/fields/:entityKind`.
 * Mirrors `FieldDefinitionDto` from the API. We accept the raw shape so the
 * UI doesn't have to mirror the Prisma client types end-to-end.
 */
export type FieldDef = {
  id: string;
  fieldKey: string;
  labelJson: Record<string, string>;
  type:
    | 'short_text'
    | 'long_text'
    | 'number'
    | 'boolean'
    | 'date'
    | 'datetime'
    | 'select_one'
    | 'select_many'
    | 'url'
    | 'email';
  required: boolean;
  optionsJson: { options?: Array<{ value: string; label?: Record<string, string> }> } | null;
  validationJson: {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  } | null;
  sortOrder: number;
};

type Props = {
  fields: FieldDef[];
  locale: Locale;
  /** Current values keyed by `fieldKey`. Updated through `onChange`. */
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** Per-field error messages (e.g. surfaced from the API after submit). */
  errors?: Record<string, string>;
  /** Prefix for the rendered field ids — avoids collisions when two forms share a page. */
  idPrefix?: string;
};

function pickLabel(label: Record<string, string>, locale: Locale): string {
  return label[locale] ?? label.en ?? label.el ?? Object.values(label)[0] ?? '';
}

function pickOptionLabel(
  option: { value: string; label?: Record<string, string> },
  locale: Locale,
): string {
  return option.label ? pickLabel(option.label, locale) : option.value;
}

/**
 * Renders a vertical stack of FieldFields based on the entity's custom-field
 * definitions. Used by:
 *   - the add-member form
 *   - the add-book form
 *   - the data-model editor's "live preview" panel (Step 17e)
 *   - custom collection record forms (future)
 *
 * Each field's `fieldKey` becomes the key into the parent's `values` map.
 * The renderer doesn't coerce types client-side — that's the dynamic
 * validator's job server-side. We just keep the raw values readable.
 */
export function DynamicFields({
  fields,
  locale,
  values,
  onChange,
  errors,
  idPrefix = 'df',
}: Props) {
  function set(key: string, value: unknown) {
    onChange({ ...values, [key]: value });
  }

  if (fields.length === 0) return null;

  return (
    <>
      {fields
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder || a.fieldKey.localeCompare(b.fieldKey))
        .map((f) => {
          const id = `${idPrefix}-${f.fieldKey}`;
          const label = pickLabel(f.labelJson, locale);
          const error = errors?.[f.fieldKey];
          const current = values[f.fieldKey];

          if (f.type === 'long_text') {
            return (
              <FormField key={f.id} id={id} label={label} required={f.required} error={error}>
                <Textarea
                  rows={4}
                  value={typeof current === 'string' ? current : ''}
                  onChange={(e) => set(f.fieldKey, e.currentTarget.value)}
                />
              </FormField>
            );
          }

          if (f.type === 'boolean') {
            return (
              <FormField key={f.id} id={id} label={label} required={f.required} error={error}>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 'var(--sp-2)',
                  }}
                >
                  <input
                    type="checkbox"
                    id={id}
                    checked={current === true}
                    onChange={(e) => set(f.fieldKey, e.currentTarget.checked)}
                  />
                  <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)' }}>
                    {current === true ? 'Yes' : 'No'}
                  </span>
                </label>
              </FormField>
            );
          }

          if (f.type === 'select_one') {
            const options = f.optionsJson?.options ?? [];
            return (
              <FormField key={f.id} id={id} label={label} required={f.required} error={error}>
                <select
                  id={id}
                  className="lbr-input"
                  value={typeof current === 'string' ? current : ''}
                  onChange={(e) => set(f.fieldKey, e.currentTarget.value || undefined)}
                >
                  <option value="">—</option>
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {pickOptionLabel(o, locale)}
                    </option>
                  ))}
                </select>
              </FormField>
            );
          }

          if (f.type === 'select_many') {
            const options = f.optionsJson?.options ?? [];
            const selected = Array.isArray(current) ? (current as string[]) : [];
            return (
              <FormField key={f.id} id={id} label={label} required={f.required} error={error}>
                <div
                  id={id}
                  role="group"
                  aria-label={label}
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)' }}
                >
                  {options.map((o) => {
                    const checked = selected.includes(o.value);
                    return (
                      <label
                        key={o.value}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 'var(--sp-1)',
                          padding: 'var(--sp-1) var(--sp-2)',
                          background: checked
                            ? 'var(--color-surface-muted)'
                            : 'var(--color-surface)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 'var(--radius-md)',
                          cursor: 'pointer',
                          fontSize: 'var(--fs-sm)',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.currentTarget.checked
                              ? [...selected, o.value]
                              : selected.filter((v) => v !== o.value);
                            set(f.fieldKey, next.length ? next : undefined);
                          }}
                        />
                        {pickOptionLabel(o, locale)}
                      </label>
                    );
                  })}
                </div>
              </FormField>
            );
          }

          if (f.type === 'number') {
            return (
              <FormField key={f.id} id={id} label={label} required={f.required} error={error}>
                <Input
                  id={id}
                  type="number"
                  step="any"
                  min={f.validationJson?.min}
                  max={f.validationJson?.max}
                  value={current === null || current === undefined ? '' : String(current)}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    set(f.fieldKey, v === '' ? undefined : Number(v));
                  }}
                />
              </FormField>
            );
          }

          if (f.type === 'date') {
            return (
              <FormField key={f.id} id={id} label={label} required={f.required} error={error}>
                <Input
                  id={id}
                  type="date"
                  value={typeof current === 'string' ? current.slice(0, 10) : ''}
                  onChange={(e) => set(f.fieldKey, e.currentTarget.value || undefined)}
                />
              </FormField>
            );
          }

          if (f.type === 'datetime') {
            return (
              <FormField key={f.id} id={id} label={label} required={f.required} error={error}>
                <Input
                  id={id}
                  type="datetime-local"
                  value={typeof current === 'string' ? current.slice(0, 16) : ''}
                  onChange={(e) => set(f.fieldKey, e.currentTarget.value || undefined)}
                />
              </FormField>
            );
          }

          // short_text, url, email — same input element, different `type`.
          const htmlType = f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : 'text';
          return (
            <FormField key={f.id} id={id} label={label} required={f.required} error={error}>
              <Input
                id={id}
                type={htmlType}
                minLength={f.validationJson?.minLength}
                maxLength={f.validationJson?.maxLength}
                pattern={f.validationJson?.pattern}
                value={typeof current === 'string' ? current : ''}
                onChange={(e) => set(f.fieldKey, e.currentTarget.value)}
              />
            </FormField>
          );
        })}
    </>
  );
}
