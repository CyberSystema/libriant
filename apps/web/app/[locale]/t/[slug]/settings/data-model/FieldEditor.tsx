'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, Card, CardBody, CardHeader, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { DynamicFields, type FieldDef } from '@/components/DynamicFields';
import { AddFieldModal } from './AddFieldModal';
import { EditFieldModal } from './EditFieldModal';

export type EditorFieldDef = FieldDef & { archivedAt: string | null };

type Props = {
  slug: string;
  entityKind: string;
  catalog: Catalog;
  locale: Locale;
  initialFields: EditorFieldDef[];
};

/**
 * Two-pane editor:
 *
 *   Left  — list of fields with drag-and-drop reorder, edit + archive
 *           controls. Reorder pushes a `sortOrder` PATCH per moved row.
 *   Right — `<DynamicFields>` preview rendering with throwaway state, so
 *           the librarian sees exactly the form their staff would fill in.
 *
 * The list state is kept in a local `useState` so reorder feels instant.
 * Each mutation calls the API and on failure rolls back via `router.refresh()`.
 */
export function FieldEditor({ slug, entityKind, catalog, locale, initialFields }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [fields, setFields] = React.useState<EditorFieldDef[]>(initialFields);
  const [showArchived, setShowArchived] = React.useState(false);
  const [previewValues, setPreviewValues] = React.useState<Record<string, unknown>>({});
  const [addOpen, setAddOpen] = React.useState(false);
  const [editingKey, setEditingKey] = React.useState<string | null>(null);
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [draggingKey, setDraggingKey] = React.useState<string | null>(null);

  // Reset whenever the entity-kind tab changes (the page re-renders with a
  // fresh `initialFields` array).
  React.useEffect(() => {
    setFields(initialFields);
    setPreviewValues({});
  }, [initialFields, entityKind]);

  const activeFields = fields.filter((f) => f.archivedAt === null);
  const archivedFields = fields.filter((f) => f.archivedAt !== null);
  const visibleRows = showArchived ? fields : activeFields;
  const editingField = editingKey ? (fields.find((f) => f.fieldKey === editingKey) ?? null) : null;

  async function move(fieldKey: string, dir: -1 | 1) {
    // Find the row's spot among ACTIVE rows (archived rows are
    // visually-only — they live at the bottom and don't reorder).
    const ix = activeFields.findIndex((f) => f.fieldKey === fieldKey);
    if (ix === -1) return;
    const target = ix + dir;
    if (target < 0 || target >= activeFields.length) return;

    const a = activeFields[ix]!;
    const b = activeFields[target]!;
    // Swap sortOrder values + recompute the local order optimistically.
    const aOrder = a.sortOrder;
    const bOrder = b.sortOrder;

    setFields((prev) =>
      prev.map((f) => {
        if (f.fieldKey === a.fieldKey) return { ...f, sortOrder: bOrder };
        if (f.fieldKey === b.fieldKey) return { ...f, sortOrder: aOrder };
        return f;
      }),
    );

    try {
      await Promise.all([
        api(`/t/${slug}/data-model/fields/${entityKind}/${a.fieldKey}`, {
          method: 'PATCH',
          body: { sortOrder: bOrder },
        }),
        api(`/t/${slug}/data-model/fields/${entityKind}/${b.fieldKey}`, {
          method: 'PATCH',
          body: { sortOrder: aOrder },
        }),
      ]);
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : t('common.states.error'),
      });
      router.refresh();
    }
  }

  async function setArchived(fieldKey: string, archive: boolean) {
    setBusyKey(fieldKey);
    try {
      const updated = await api<EditorFieldDef>(
        `/t/${slug}/data-model/fields/${entityKind}/${fieldKey}`,
        { method: 'PATCH', body: { archived: archive } },
      );
      setFields((prev) => prev.map((f) => (f.fieldKey === fieldKey ? updated : f)));
      toast.show({
        severity: 'success',
        title: archive
          ? t('settings.dataModel.toast.archived')
          : t('settings.dataModel.toast.restored'),
      });
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : t('common.states.error'),
      });
    } finally {
      setBusyKey(null);
    }
  }

  // Native HTML5 drag-and-drop. Keeps things accessible since each row
  // also has explicit up/down arrow buttons.
  function onDragStart(key: string) {
    setDraggingKey(key);
  }
  async function onDragDrop(targetKey: string) {
    if (!draggingKey || draggingKey === targetKey) {
      setDraggingKey(null);
      return;
    }
    const dragged = activeFields.find((f) => f.fieldKey === draggingKey);
    const target = activeFields.find((f) => f.fieldKey === targetKey);
    setDraggingKey(null);
    if (!dragged || !target || dragged.archivedAt || target.archivedAt) return;
    // Swap sortOrders directly. For multi-step drag (move from position
    // 5 to position 1), we just patch the dragged row's sortOrder to the
    // target's old value — the rest of the list is non-contiguous after,
    // but that's fine: sortOrder doesn't need to be contiguous, only
    // ordered. The next time someone reorders, integers stay sane.
    const aOrder = dragged.sortOrder;
    const bOrder = target.sortOrder;
    setFields((prev) =>
      prev.map((f) => {
        if (f.fieldKey === dragged.fieldKey) return { ...f, sortOrder: bOrder };
        if (f.fieldKey === target.fieldKey) return { ...f, sortOrder: aOrder };
        return f;
      }),
    );
    try {
      await Promise.all([
        api(`/t/${slug}/data-model/fields/${entityKind}/${dragged.fieldKey}`, {
          method: 'PATCH',
          body: { sortOrder: bOrder },
        }),
        api(`/t/${slug}/data-model/fields/${entityKind}/${target.fieldKey}`, {
          method: 'PATCH',
          body: { sortOrder: aOrder },
        }),
      ]);
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : t('common.states.error'),
      });
      router.refresh();
    }
  }

  // Sort visible rows: active first (by sortOrder), then archived at the
  // bottom (also by sortOrder).
  const sortedVisible = visibleRows.slice().sort((a, b) => {
    const aArchived = a.archivedAt ? 1 : 0;
    const bArchived = b.archivedAt ? 1 : 0;
    if (aArchived !== bArchived) return aArchived - bArchived;
    return a.sortOrder - b.sortOrder || a.fieldKey.localeCompare(b.fieldKey);
  });

  return (
    <div className="lbr-split lbr-split--even" style={{ gap: 'var(--sp-4)' }}>
      <Card>
        <CardHeader
          title={t('settings.dataModel.fieldsTitle')}
          subtitle={t('settings.dataModel.fieldsHint')}
          actions={
            <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
              + {t('settings.dataModel.addField')}
            </Button>
          }
        />
        <CardBody>
          {activeFields.length === 0 && archivedFields.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
              {t('settings.dataModel.empty')}
            </p>
          ) : (
            <>
              <ul
                aria-label={t('settings.dataModel.fieldsTitle')}
                style={{ listStyle: 'none', margin: 0, padding: 0 }}
              >
                {sortedVisible.map((f, ix) => {
                  const archived = f.archivedAt !== null;
                  const isFirst = ix === 0;
                  const isLast = ix === activeFields.length - 1 || archived;
                  return (
                    <li
                      key={f.id}
                      draggable={!archived}
                      onDragStart={() => onDragStart(f.fieldKey)}
                      onDragOver={(e) => {
                        if (draggingKey && !archived) e.preventDefault();
                      }}
                      onDrop={() => onDragDrop(f.fieldKey)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--sp-2)',
                        padding: 'var(--sp-2) var(--sp-3)',
                        marginBottom: 'var(--sp-1)',
                        border: '1px solid var(--color-border-muted)',
                        borderRadius: 'var(--radius-md)',
                        background:
                          draggingKey === f.fieldKey
                            ? 'var(--color-surface-muted)'
                            : 'var(--color-surface)',
                        opacity: archived ? 0.6 : 1,
                        cursor: archived ? 'default' : 'grab',
                      }}
                    >
                      <span aria-hidden style={{ color: 'var(--color-text-muted)' }}>
                        ⋮⋮
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500 }}>
                          {f.labelJson[locale] ?? f.labelJson.en ?? f.labelJson.el ?? f.fieldKey}
                        </div>
                        <div
                          style={{
                            color: 'var(--color-text-muted)',
                            fontSize: 'var(--fs-xs)',
                            display: 'flex',
                            gap: 'var(--sp-2)',
                          }}
                        >
                          <code style={{ fontFamily: 'var(--font-mono)' }}>{f.fieldKey}</code>
                          <span>· {t(`settings.dataModel.types.${f.type}`)}</span>
                          <span>
                            ·{' '}
                            {f.required
                              ? t('settings.dataModel.row.required')
                              : t('settings.dataModel.row.optional')}
                          </span>
                          {archived ? (
                            <span style={{ color: 'var(--color-warning)' }}>
                              · {t('settings.dataModel.row.archived')}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {!archived ? (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t('settings.dataModel.row.moveUp')}
                            disabled={isFirst}
                            onClick={() => move(f.fieldKey, -1)}
                          >
                            ↑
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t('settings.dataModel.row.moveDown')}
                            disabled={isLast}
                            onClick={() => move(f.fieldKey, 1)}
                          >
                            ↓
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingKey(f.fieldKey)}
                          >
                            {t('settings.dataModel.row.edit')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busyKey === f.fieldKey}
                            onClick={() => setArchived(f.fieldKey, true)}
                          >
                            {t('settings.dataModel.row.archive')}
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyKey === f.fieldKey}
                          onClick={() => setArchived(f.fieldKey, false)}
                        >
                          {t('settings.dataModel.row.restore')}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {archivedFields.length > 0 ? (
                <div style={{ marginTop: 'var(--sp-3)' }}>
                  <Button variant="ghost" size="sm" onClick={() => setShowArchived((s) => !s)}>
                    {showArchived
                      ? t('settings.dataModel.row.hideArchived')
                      : t('settings.dataModel.row.showArchived')}{' '}
                    ({archivedFields.length})
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t('settings.dataModel.previewTitle')}
          subtitle={t('settings.dataModel.previewHint')}
        />
        <CardBody>
          {activeFields.length === 0 ? (
            <Banner severity="info">{t('settings.dataModel.empty')}</Banner>
          ) : (
            <DynamicFields
              fields={activeFields}
              locale={locale}
              values={previewValues}
              onChange={setPreviewValues}
              idPrefix="dm-preview"
            />
          )}
        </CardBody>
      </Card>

      <AddFieldModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        slug={slug}
        entityKind={entityKind}
        catalog={catalog}
        locale={locale}
        existingKeys={fields.map((f) => f.fieldKey)}
        nextSortOrder={(fields.reduce((max, f) => Math.max(max, f.sortOrder), 0) || 0) + 10}
        onCreated={(created) => {
          setFields((prev) => [...prev, created]);
          setAddOpen(false);
        }}
      />

      <EditFieldModal
        open={editingField !== null}
        onClose={() => setEditingKey(null)}
        field={editingField}
        slug={slug}
        entityKind={entityKind}
        catalog={catalog}
        locale={locale}
        onUpdated={(updated) => {
          setFields((prev) => prev.map((f) => (f.fieldKey === updated.fieldKey ? updated : f)));
          setEditingKey(null);
        }}
      />
    </div>
  );
}
