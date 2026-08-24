/**
 * The one place that decides what is painted on top of what.
 *
 * frontend-05: a circulation action that failed server-side fired a critical
 * toast while its modal stayed open, and the librarian saw nothing happen at
 * all. The toast stack sat at `z-index: 9000`, but `<dialog>.showModal()` puts
 * the dialog in the browser's *top layer*, which beats every z-index there is.
 * Raising 9000 to 99999 would not have fixed it, and the next component that
 * needs "above everything" would have broken it again — so the ordering is
 * owned here instead of being re-guessed per component.
 *
 * Measured in a browser against the real `styles.css`, with a `showModal()`'d
 * `.lbr-modal` and a `.lbr-toast--critical` in `.lbr-toast-stack`:
 *
 *   1. stack at z-index 9000                  → toast painted *under*
 *      `.lbr-modal::backdrop`, invisible.
 *   2. stack promoted with `showPopover()`
 *      *before* the dialog opened             → still under the backdrop.
 *      Top-layer paint order is entry order, so a dialog opened later wins.
 *   3. stack (re-)promoted *after* the dialog
 *      entered the top layer                  → painted crisply above it.
 *
 * Hence `resolveToastLayer` below: being a popover once is not enough, the
 * stack has to be re-promoted whenever a dialog has joined the top layer
 * since. In all three cases `document.elementFromPoint()` at the toast's
 * close button returned the dialog: a modal dialog blocks hit-testing for
 * everything outside its own subtree, so a toast over an open modal can be
 * *read* but never *clicked*. That is a platform rule we cannot route around,
 * and it is why `Modal` owns an inline `error` slot for failures that happen
 * while the dialog is still up.
 */

/** Normal-layer stacking contexts, lowest first. Must match `styles.css`. */
export const LAYER_ORDER = ['sticky', 'popover', 'scrim', 'drawer', 'toast'] as const;

export type Layer = (typeof LAYER_ORDER)[number];

/**
 * `sticky`  — the mobile top bar.
 * `popover` — combobox listboxes and anything else anchored to a field; above
 *             the top bar so options are not clipped when a field scrolls
 *             under it, below the nav so an open menu still covers them.
 * `scrim`   — the off-canvas nav's dimmer.
 * `drawer`  — the off-canvas nav itself.
 * `toast`   — the notification stack; the highest thing in the normal layer.
 *             Dialogs are *not* here: they live in the browser top layer,
 *             above all of these regardless of number.
 */
export const LAYER_Z: Readonly<Record<Layer, number>> = {
  sticky: 50,
  popover: 55,
  scrim: 60,
  drawer: 70,
  toast: 80,
};

export function zIndexFor(layer: Layer): number {
  return LAYER_Z[layer];
}

export function stacksAbove(a: Layer, b: Layer): boolean {
  return LAYER_Z[a] > LAYER_Z[b];
}

/** The `--lbr-z-*` block in `styles.css`, so a test can assert the two agree. */
export function layerCssVars(): string {
  return LAYER_ORDER.map((layer) => `--lbr-z-${layer}: ${LAYER_Z[layer]};`).join('\n');
}

export type ToastLayerState = {
  /** Does this browser implement the popover API? Without it we fall back to z-index. */
  supportsTopLayer: boolean;
  /** Is there anything worth showing? An empty stack should not hold the top layer. */
  hasToasts: boolean;
  /** Is the stack currently in the top layer? */
  promoted: boolean;
  /** Modal dialogs currently in the top layer. */
  openModals: number;
  /** Re-promoting re-enters the top layer, which would blur anything focused inside. */
  focusWithinStack: boolean;
};

export type ToastLayerAction = 'none' | 'promote' | 'repromote' | 'demote';

/**
 * Decide what the toast stack should do about the top layer. Pure so the
 * ordering rule can be exercised without a browser.
 *
 * `repromote` means leave and re-enter the top layer — the only way to move
 * above a dialog that entered after us (fact 2 above).
 */
export function resolveToastLayer(state: ToastLayerState): ToastLayerAction {
  if (!state.supportsTopLayer) return 'none';
  if (!state.hasToasts) return state.promoted ? 'demote' : 'none';
  if (!state.promoted) return 'promote';
  if (state.openModals > 0 && !state.focusWithinStack) return 'repromote';
  return 'none';
}

/*
 * A tiny document-global registry of open modal dialogs.
 *
 * The toast stack has to know when a dialog joined the top layer, and the
 * platform gives us no event for it that every supported browser fires. The
 * dialogs themselves do know, so `Modal` and `HelpDrawer` report in here and
 * the toast stack subscribes. Module state is the right scope: the top layer
 * is a property of the document, not of any React tree.
 */
let openModals = 0;
const listeners = new Set<() => void>();

/** Count of modal dialogs this design system currently has in the top layer. */
export function openModalCount(): number {
  return openModals;
}

/** Called by a dialog when it opens. Returns the "and now it closed" callback. */
export function registerOpenModal(): () => void {
  openModals += 1;
  for (const fn of listeners) fn();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openModals = Math.max(0, openModals - 1);
    for (const fn of listeners) fn();
  };
}

export function subscribeToModalLayer(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
