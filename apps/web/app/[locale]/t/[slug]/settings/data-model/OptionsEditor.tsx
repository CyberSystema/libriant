'use client';
import * as React from 'react';
import { Button, Input } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';

export type EditableOption = {
  /** Stable client-side id for React keys; not sent to the API. */
  id: string;
  value: string;
  labelEn: string;
  labelEl: string;
};

type Props = {
  catalog: Catalog;
  locale: Locale;
  value: EditableOption[];
  onChange: (next: EditableOption[]) => void;
};

let nextId = 0;
const newId = () => `opt-${nextId++}`;

/**
 * Inline editor for select_one / select_many option lists. Each row has
 * a value (internal), an English label, and a Greek label. The last row
 * gets a delete button; new rows are added through "+ Add option".
 *
 * Order in the array becomes the order in the rendered dropdown — there's
 * no per-option sort: the librarian arranges by adding/removing.
 */
export function OptionsEditor({ catalog, locale, value, onChange }: Props) {
  const t = createTranslator(catalog, locale);

  function update(ix: number, patch: Partial<Omit<EditableOption, 'id'>>) {
    onChange(value.map((o, i) => (i === ix ? { ...o, ...patch } : o)));
  }
  function remove(ix: number) {
    onChange(value.filter((_, i) => i !== ix));
  }
  function add() {
    onChange([...value, { id: newId(), value: '', labelEn: '', labelEl: '' }]);
  }

  return (
    <div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th
              style={{
                textAlign: 'left',
                fontSize: 'var(--fs-xs)',
                color: 'var(--color-text-muted)',
                fontWeight: 600,
                textTransform: 'uppercase',
                paddingBottom: 'var(--sp-1)',
              }}
            >
              {t('settings.dataModel.form.optionValue')}
            </th>
            <th
              style={{
                textAlign: 'left',
                fontSize: 'var(--fs-xs)',
                color: 'var(--color-text-muted)',
                fontWeight: 600,
                textTransform: 'uppercase',
                paddingBottom: 'var(--sp-1)',
              }}
            >
              {t('settings.dataModel.form.optionLabelEn')}
            </th>
            <th
              style={{
                textAlign: 'left',
                fontSize: 'var(--fs-xs)',
                color: 'var(--color-text-muted)',
                fontWeight: 600,
                textTransform: 'uppercase',
                paddingBottom: 'var(--sp-1)',
              }}
            >
              {t('settings.dataModel.form.optionLabelEl')}
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {value.map((o, ix) => (
            <tr key={o.id}>
              <td style={{ padding: 'var(--sp-1) var(--sp-1) var(--sp-1) 0' }}>
                <Input
                  value={o.value}
                  onChange={(e) =>
                    update(ix, {
                      value: e.currentTarget.value.toLowerCase().replace(/\s+/g, '_'),
                    })
                  }
                  spellCheck={false}
                />
              </td>
              <td style={{ padding: 'var(--sp-1)' }}>
                <Input
                  value={o.labelEn}
                  onChange={(e) => update(ix, { labelEn: e.currentTarget.value })}
                />
              </td>
              <td style={{ padding: 'var(--sp-1)' }}>
                <Input
                  value={o.labelEl}
                  onChange={(e) => update(ix, { labelEl: e.currentTarget.value })}
                />
              </td>
              <td style={{ padding: 'var(--sp-1)', textAlign: 'right' }}>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="Remove option"
                  onClick={() => remove(ix)}
                >
                  ×
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={add}
        style={{ marginTop: 'var(--sp-2)' }}
      >
        {t('settings.dataModel.form.optionAdd')}
      </Button>
    </div>
  );
}
