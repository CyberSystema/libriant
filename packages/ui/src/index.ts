export { Asset, AssetProvider, useAssetUrl } from './Asset';
export type { AssetManifest, AssetSlot, AssetName } from './asset-manifest';
export { Barcode, encodeCode128 } from './Barcode';
export { Button } from './Button';
export { Banner } from './Banner';
export { Card, CardHeader, CardBody } from './Card';
// NOTE: there is no Combobox here on purpose. One was added during the
// frontend remediation as a corrected copy of apps/web/components/Combobox.tsx,
// but nothing ever imported it — so finding frontend-25 stayed open while a
// file that looked like the fix sat in the design system. The accessible
// version is the one the app actually renders. If this ever moves into the
// design system, MIGRATE the call sites in the same change; do not leave two.
export { ConfirmDestructive } from './ConfirmDestructive';
export { EmptyState } from './EmptyState';
export { FormField } from './FormField';
export { HelpButton, HelpDrawer } from './HelpDrawer';
export { Input, Textarea } from './Input';
export { Modal } from './Modal';
export { Nav, NavLink } from './Nav';
export { PageHeader } from './PageHeader';
export { PoweredBy } from './PoweredBy';
export { Skeleton } from './Skeleton';
export { ToastProvider, useToast } from './Toast';
export type { ToastItem } from './Toast';
export { tokensToCssVars } from './tokens';
export type { DesignTokens } from './tokens';

// Contrast maths — a brand colour or a text token has to be *computed*
// against a target ratio, not eyeballed (frontend-16, frontend-17).
// Contrast maths moved to @libriant/shared: the API enforces the brand-colour
// check at PATCH /t/:slug/branding, and apps/api must not depend on a React
// component library to do arithmetic.

// Stacking order, owned in one place (frontend-05).
export {
  LAYER_ORDER,
  LAYER_Z,
  layerCssVars,
  resolveToastLayer,
  stacksAbove,
  zIndexFor,
} from './layers';
export type { Layer, ToastLayerAction, ToastLayerState } from './layers';

// Toast timing + announcement policy (frontend-20, frontend-22).
export {
  DEFAULT_TOAST_DURATION_MS,
  defaultDurationFor,
  isSticky,
  liveRegionRoleFor,
  remainingMs,
  resolveDuration,
} from './toast-policy';
export type { ToastSeverity, ToastTimer } from './toast-policy';

// The design system's own accessible names (frontend-13).
export {
  UI_STRING_KEYS,
  VALUE_MARKER,
  defaultUiStrings,
  fillMarker,
  splitAroundMarker,
  uiStringsFromCatalog,
} from './ui-strings';
export type { UiStrings } from './ui-strings';
export { UiStringsProvider, useUiStrings } from './ui-strings-context';
