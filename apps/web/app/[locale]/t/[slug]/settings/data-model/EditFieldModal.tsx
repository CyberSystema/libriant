'use client';
import * as React from 'react';
import { Banner, Button, FormField, Input, Modal, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import type { EditorFieldDef } from './FieldEditor';
import { OptionsEditor, type EditableOption } from './OptionsEditor';

let nextOptId = 0;

type Props = {
  open: boolean;
  onClose: () => void;
  field: EditorFieldDef | null;
  slug: string;
  entityKind: string;
  catalog: Catalog;
  locale: Locale;
  onUpdated: (field: EditorFieldDef) => void;
};

/**
 * Edit-field modal. Same shape as Add, but:
 *
 *   - `fieldKey` is read-only (changing it would break existing records).
 *   - `type` is read-only (intentional safety rail — the plan calls this
 *     out explicitly as a guard against invalidating existing values).
 *   - `optionsJson` can still be edited for select_one / select_many.
 *
 * Updates land via PATCH; success calls `onUpdated` so the parent list
 * stays in sync without a full refresh.
 */
export function EditFieldModal({
  open,
  onClose,
  field,
  slug,
  entityKind,
  catalog,
  locale,
  onUpdated,
}: Props) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const [labelEn, setLabelEn] = React.useState('');
  const [labelEl, setLabelEl] = React.useState('');
  const [required, setRequired] = React.useState(false);
  const [options, setOptions] = React.useState<EditableOption[]>([]);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!field) return;
    setLabelEn(field.labelJson.en ?? '');
    setLabelEl(field.labelJson.el ?? '');
    setRequired(field.required);
    const opts = field.optionsJson?.options ?? [];
    setOptions(
      opts.map((o) => ({
        id: `existing-${nextOptId++}`,
        value: o.value,
        labelEn: o.label?.en ?? '',
        labelEl: o.label?.el ?? '',
      })),
    );
    setFormError(null);
    setErrors({});
  }, [field]);

  if (!field) return null;
  const isSelect = field.type === 'select_one' || field.type === 'select_many';

  async function handleSubmit() {
    const validation: Record<string, string> = {};
    if (!labelEn.trim() && !labelEl.trim()) {
      validation.label = t('settings.dataModel.form.errors.labelRequired');
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

      const body: Record<string, unknown> = { labelJson, required };
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

      const updated = await api<EditorFieldDef>(
        `/t/${slug}/data-model/fields/${entityKind}/${field!.fieldKey}`,
        { method: 'PATCH', body },
      );
      toast.show({
        severity: 'success',
        title: t('settings.dataModel.toast.updated'),
      });
      onUpdated(updated);
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
      title={t('settings.dataModel.form.edit')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="primary" loading={submitting} onClick={handleSubmit}>
            {t('settings.dataModel.form.submitEdit')}
          </Button>
        </>
      }
    >
      {formError ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-3)' }}>
          {formError}
        </Banner>
      ) : null}

      <FormField
        id="edit-label-en"
        label={t('settings.dataModel.form.label.en')}
        error={errors.label}
      >
        <Input value={labelEn} onChange={(e) => setLabelEn(e.currentTarget.value)} />
      </FormField>
      <FormField id="edit-label-el" label={t('settings.dataModel.form.label.el')}>
        <Input value={labelEl} onChange={(e) => setLabelEl(e.currentTarget.value)} />
      </FormField>

      <FormField
        id="edit-fieldKey"
        label={t('settings.dataModel.form.fieldKey')}
        hint={t('settings.dataModel.form.typeLocked')}
      >
        <Input value={field.fieldKey} readOnly disabled />
      </FormField>

      <FormField
        id="edit-type"
        label={t('settings.dataModel.form.type')}
        hint={t('settings.dataModel.form.typeLocked')}
      >
        <Input value={t(`settings.dataModel.types.${field.type}`)} readOnly disabled />
      </FormField>

      <FormField
        id="edit-required"
        label={t('settings.dataModel.form.required')}
        hint={t('settings.dataModel.form.requiredHint')}
      >
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
          <input
            type="checkbox"
            id="edit-required"
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
          id="edit-options"
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
