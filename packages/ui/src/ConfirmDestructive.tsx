'use client';
import * as React from 'react';
import { Button } from './Button';
import { Modal } from './Modal';
import { splitAroundMarker, useUiStrings } from './ui-strings';

type ConfirmDestructiveProps = {
  open: boolean;
  onClose: () => void;
  /** Called only when the user types `confirmText` exactly and confirms. */
  onConfirm: () => Promise<void> | void;

  title: React.ReactNode;
  /** Body content rendered above the warning + input. Caller-controlled copy. */
  children?: React.ReactNode;
  /**
   * The string the user must type to enable the confirm button. Plain
   * text only — typically the resource's name. Comparison is
   * case-insensitive after trimming, so "ACME" matches "acme  ".
   */
  confirmText: string;
  /**
   * Per-dialog overrides for the button labels. Both fall back to the shared
   * `UiStringsProvider` copy — this dialog's standing text ("This cannot be
   * undone.", the typing instructions) used to be English literals in the
   * middle of a Greek interface (frontend-13). The "confirm" button is
   * rendered in the critical (red) variant.
   */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Disable the entire dialog while the parent's onConfirm is in flight. */
  busy?: boolean;
};

/**
 * Typed-confirmation modal for destructive actions (UX principle:
 * "Destructive actions need typed confirmation"). The user has to type
 * the exact name of the thing they're deleting before the confirm button
 * activates. Pasting still works — the goal isn't keystroke proof, it's
 * making the user's brain re-read the name once before continuing.
 *
 * The native `<dialog>` (via `Modal`) already focus-traps + handles Esc.
 * We add an `alertdialog` role + a CSS-marked warning strip so screen
 * readers announce it as a confirmation rather than a generic dialog.
 *
 * Example:
 *
 *   <ConfirmDestructive
 *     open={open} onClose={close} onConfirm={doDelete}
 *     title="Delete book?"
 *     confirmText={book.title}
 *     confirmLabel="Delete book forever"
 *   >
 *     <p>This will permanently delete <strong>{book.title}</strong>. There's no undo.</p>
 *   </ConfirmDestructive>
 */
export function ConfirmDestructive({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmText,
  confirmLabel,
  cancelLabel,
  busy = false,
}: ConfirmDestructiveProps) {
  const ui = useUiStrings();
  const [promptBefore, promptAfter] = splitAroundMarker(ui.confirmTypePrompt);
  const [typed, setTyped] = React.useState('');
  // Reset on every open so a closed-and-reopened dialog doesn't carry
  // the previous attempt's state.
  React.useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const normalizedTarget = confirmText.trim().toLowerCase();
  const normalizedTyped = typed.trim().toLowerCase();
  const armed = normalizedTyped.length > 0 && normalizedTyped === normalizedTarget;

  async function handleConfirm() {
    if (!armed || busy) return;
    await onConfirm();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={title}
      role="alertdialog"
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {cancelLabel ?? ui.cancel}
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={!armed || busy}
            loading={busy}
          >
            {confirmLabel ?? ui.confirmDeleteForever}
          </Button>
        </>
      }
    >
      {children}
      <div className="lbr-confirm-destructive__warning" role="note">
        {ui.confirmIrreversible}
      </div>
      <label className="lbr-field">
        <span className="lbr-field__label">
          {promptBefore}
          <code>{confirmText}</code>
          {promptAfter}
        </span>
        <input
          className="lbr-input"
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.currentTarget.value)}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-required="true"
          // Submit-on-Enter when armed. Some users will type then hit Enter
          // expecting the dialog to fire — match that.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && armed) {
              e.preventDefault();
              void handleConfirm();
            }
          }}
        />
      </label>
      <p className="lbr-confirm-destructive__type-hint">{ui.confirmTypeHint}</p>
    </Modal>
  );
}
