'use client';
import * as React from 'react';
import { Button, FormError, FormField, Input, Modal, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import type { EditorFieldDef } from './FieldEditor';
import { OptionsEditor, type EditableOption } from './OptionsEditor';

const FIELD_TYPES = [
  'short_text',
  'long_text',
  'number',
  'boolean',
  'date',
  'datetime',
  'select_one',
  'select_many',
  'url',
  'email',
] as const;
type FieldType = (typeof FIELD_TYPES)[number];

const FIELD_KEY_RE = /^[a-z][a-z0-9_]{1,49}$/;

type Props = {
  open: boolean;
  onClose: () => void;
  slug: string;
  entityKind: string;
  catalog: Catalog;
  locale: Locale;
  existingKeys: string[];
  nextSortOrder: number;
  onCreated: (field: EditorFieldDef) => void;
};

/** Lowercase + replace non-alphanumeric with underscores. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}

/**
 * Add-field modal. Captures everything `POST /data-model/fields/:entityKind`
 * needs:
 *
 *   - fieldKey (auto-slugified from the English label until the librarian
 *     edits it manually)
 *   - per-locale label (en + el; falls back to whichever is non-empty)
 *   - type (plain-language picker)
 *   - required toggle
 *   - options editor for select_one / select_many
 *
 * The "type" picker uses the same plain-language strings the editor's
 * field-row badges use — keeps the librarian in one mental model.
 */
export function AddFieldModal({
  open,
  onClose,
  slug,
  entityKind,
  catalog,
  locale,
  existingKeys,
  nextSortOrder,
  onCreated,
}: Props) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const [labelEn, setLabelEn] = React.useState('');
  const [labelEl, setLabelEl] = React.useState('');
  const [fieldKey, setFieldKey] = React.useState('');
  const [fieldKeyTouched, setFieldKeyTouched] = React.useState(false);
  const [type, setType] = React.useState<FieldType>('short_text');
  const [required, setRequired] = React.useState(false);
  const [options, setOptions] = React.useState<EditableOption[]>([]);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);

  // Reset every time the modal opens.
  React.useEffect(() => {
    if (open) {
      setLabelEn('');
      setLabelEl('');
      setFieldKey('');
      setFieldKeyTouched(false);
      setType('short_text');
      setRequired(false);
      setOptions([]);
      setFormError(null);
      setErrors({});
    }
  }, [open]);

  // Auto-fill fieldKey from English label until the user touches it.
  React.useEffect(() => {
    if (!fieldKeyTouched) {
      setFieldKey(slugify(labelEn || labelEl));
    }
  }, [labelEn, labelEl, fieldKeyTouched]);

  const isSelect = type === 'select_one' || type === 'select_many';

  async function handleSubmit() {
    const validation: Record<string, string> = {};
    if (!labelEn.trim() && !labelEl.trim()) {
      validation.label = t('settings.dataModel.form.errors.labelRequired');
    }
    if (!FIELD_KEY_RE.test(fieldKey)) {
      validation.fieldKey = t('settings.dataModel.form.errors.fieldKeyInvalid');
    } else if (existingKeys.includes(fieldKey)) {
      validation.fieldKey = `Field "${fieldKey}" already exists.`;
    }
    if (isSelect) {
      if (options.length === 0) {
        validation.options = t('settings.dataModel.form.optionsEmpty');
      } else if (options.some((o) => !o.value.trim())) {
        validation.options = t('settings.dataModel.form.errors.optionValueRequired');
      }
    }
    if (Object.keys(validation).length) {
      setErrors(validation);
      setFormError(t('settings.dataModel.form.errors.labelRequired'));
      return;
    }

    setErrors({});
    setFormError(null);
    setSubmitting(true);
    try {
      const labelJson: Record<string, string> = {};
      if (labelEn.trim()) labelJson.en = labelEn.trim();
      if (labelEl.trim()) labelJson.el = labelEl.trim();

      const body: Record<string, unknown> = {
        fieldKey,
        labelJson,
        type,
        required,
        sortOrder: nextSortOrder,
      };
      if (isSelect) {
        body.optionsJson = {
          options: options.map((o) => {
            const optionLabel: Record<string, string> = {};
            if (o.labelEn.trim()) optionLabel.en = o.labelEn.trim();
            if (o.labelEl.trim()) optionLabel.el = o.labelEl.trim();
            return {
              value: o.value.trim(),
              ...(Object.keys(optionLabel).length ? { label: optionLabel } : {}),
            };
          }),
        };
      }

      const created = await api<EditorFieldDef>(`/t/${slug}/data-model/fields/${entityKind}`, {
        method: 'POST',
        body,
      });
      toast.show({
        severity: 'success',
        title: t('settings.dataModel.toast.created'),
      });
      onCreated(created);
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(
          Array.isArray(err.body.message)
            ? err.body.message.join(' ')
            : (err.body.message ?? t('common.states.error')),
        );
      } else {
        setFormError(t('common.states.error'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('settings.dataModel.form.add')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="primary" loading={submitting} onClick={handleSubmit}>
            {t('settings.dataModel.form.submitAdd')}
          </Button>
        </>
      }
    >
      <FormError style={{ marginBottom: 'var(--sp-3)' }}>{formError}</FormError>

      <FormField
        id="add-label-en"
        label={t('settings.dataModel.form.label.en')}
        required
        error={errors.label}
      >
        <Input value={labelEn} onChange={(e) => setLabelEn(e.currentTarget.value)} />
      </FormField>
      <FormField id="add-label-el" label={t('settings.dataModel.form.label.el')}>
        <Input value={labelEl} onChange={(e) => setLabelEl(e.currentTarget.value)} />
      </FormField>

      <FormField
        id="add-fieldKey"
        label={t('settings.dataModel.form.fieldKey')}
        hint={t('settings.dataModel.form.fieldKeyHint')}
        error={errors.fieldKey}
      >
        <Input
          spellCheck={false}
          value={fieldKey}
          onChange={(e) => {
            setFieldKeyTouched(true);
            setFieldKey(e.currentTarget.value.toLowerCase());
          }}
        />
      </FormField>

      <FormField id="add-type" label={t('settings.dataModel.form.type')}>
        <select
          id="add-type"
          className="lbr-input"
          value={type}
          onChange={(e) => setType(e.currentTarget.value as FieldType)}
        >
          {FIELD_TYPES.map((ty) => (
            <option key={ty} value={ty}>
              {t(`settings.dataModel.types.${ty}`)}
            </option>
          ))}
        </select>
      </FormField>

      <FormField
        id="add-required"
        label={t('settings.dataModel.form.required')}
        hint={t('settings.dataModel.form.requiredHint')}
      >
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
          <input
            type="checkbox"
            id="add-required"
            checked={required}
            onChange={(e) => setRequired(e.currentTarget.checked)}
          />
          <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)' }}>
            {required ? t('settings.dataModel.row.required') : t('settings.dataModel.row.optional')}
          </span>
        </label>
      </FormField>

      {isSelect ? (
        <FormField
          id="add-options"
          label={t('settings.dataModel.form.options')}
          hint={t('settings.dataModel.form.optionsHint')}
          error={errors.options}
        >
          <OptionsEditor catalog={catalog} locale={locale} value={options} onChange={setOptions} />
        </FormField>
      ) : null}
    </Modal>
  );
}
