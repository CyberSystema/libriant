/**
 * WCAG relative-luminance and contrast maths.
 *
 * Two audit findings landed here. A library's brand colour was accepted on a
 * hex regex alone and injected straight into `--color-primary`, so a library
 * could pick `#ffd60a` and get white-on-yellow buttons at 1.41:1 for every
 * member of staff, permanently (frontend-16). And `--color-warning` (#bf8700)
 * was hand-picked and used as body text at 3.14:1 on white (frontend-17).
 *
 * The lesson from both is the same: contrast has to be *computed*, not
 * eyeballed. So the maths lives here as plain functions with no React and no
 * DOM — callable from a form validator, an API guard, a build script, or a
 * test. There is no test runner in this repo yet (frontend-29); this module is
 * shaped so that adding one needs no refactor.
 */

export type Rgb = { r: number; g: number; b: number };

/** WCAG 2.x AA: normal text. */
export const AA_TEXT = 4.5;
/** WCAG 2.x AA: text at >=24px, or >=18.66px bold. */
export const AA_LARGE_TEXT = 3;
/** WCAG 2.x AA (SC 1.4.11): control boundaries, focus rings, icons. */
export const AA_NON_TEXT = 3;
/** WCAG 2.x AAA: normal text. */
export const AAA_TEXT = 7;

const HEX_SHORT = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_LONG = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** Parse `#rgb` / `#rrggbb` (with or without the `#`). Returns null if unparseable. */
export function parseHex(hex: string): Rgb | null {
  const value = hex.trim();
  const short = HEX_SHORT.exec(value);
  if (short) {
    return {
      r: parseInt(short[1]! + short[1]!, 16),
      g: parseInt(short[2]! + short[2]!, 16),
      b: parseInt(short[3]! + short[3]!, 16),
    };
  }
  const long = HEX_LONG.exec(value);
  if (long) {
    return {
      r: parseInt(long[1]!, 16),
      g: parseInt(long[2]!, 16),
      b: parseInt(long[3]!, 16),
    };
  }
  return null;
}

const clampChannel = (n: number) => Math.min(255, Math.max(0, Math.round(n)));

export function toHex({ r, g, b }: Rgb): string {
  const part = (n: number) => clampChannel(n).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

function coerce(color: string | Rgb): Rgb {
  if (typeof color !== 'string') return color;
  const parsed = parseHex(color);
  if (!parsed) throw new Error(`Not a hex colour: ${color}`);
  return parsed;
}

/** WCAG 2.x relative luminance (sRGB → linear, then the ITU-R BT.709 weights). */
export function relativeLuminance(color: string | Rgb): number {
  const { r, g, b } = coerce(color);
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, 1..21. Order of the arguments does not matter. */
export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Composite a translucent foreground over an opaque background.
 *
 * Needed because `opacity` on text does not lower the *ratio* the browser
 * reports — it changes the colour that actually reaches the eye. The landing
 * hero dimmed white copy to `opacity: .85` over the brand gradient and lost
 * a full point of contrast that way.
 */
export function flatten(foreground: string | Rgb, background: string | Rgb, alpha: number): Rgb {
  const fg = coerce(foreground);
  const bg = coerce(background);
  const a = Math.min(1, Math.max(0, alpha));
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

/** Linear interpolation between two colours in sRGB space. */
export function mix(from: string | Rgb, to: string | Rgb, t: number): Rgb {
  return flatten(to, from, t);
}

/**
 * Deliberately unrounded. Reporting tools print 4.4996 as "4.50"; a colour
 * that only passes once it has been rounded up has not passed.
 */
export function meets(ratio: number, target: number = AA_TEXT): boolean {
  return ratio >= target;
}

/**
 * Pick whichever of two candidate foregrounds is more readable on `background`.
 * Defaults are the design system's own `--color-primary-fg` (white) and
 * `--color-text` (near-black) so the answer is always a real token value.
 */
export function readableForeground(
  background: string | Rgb,
  light: string = '#ffffff',
  dark: string = '#0d1117',
): string {
  return contrastRatio(background, light) >= contrastRatio(background, dark) ? light : dark;
}

/**
 * Walk a colour toward black (on a light background) or white (on a dark one)
 * until it clears `target`, keeping its hue.
 *
 * Mixing toward pure black scales all three channels by the same factor, so
 * hue and saturation survive exactly — the result still reads as "the warning
 * colour", just legible. Returns the input unchanged when it already passes,
 * and the extreme (black/white) when even that cannot reach the target.
 */
export function toAccessibleTextColor(
  color: string | Rgb,
  background: string | Rgb,
  target: number = AA_TEXT,
): string {
  const start = coerce(color);
  const bg = coerce(background);
  if (meets(contrastRatio(start, bg), target)) return toHex(start);

  const towards: Rgb =
    relativeLuminance(bg) > 0.5 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  if (!meets(contrastRatio(towards, bg), target)) return toHex(towards);

  // Search over the *quantised* colour, not the float one: rounding to 8-bit
  // channels can knock a borderline result back under the target, and the
  // quantised value is the one that ends up in the stylesheet.
  const at = (t: number): Rgb => coerce(toHex(mix(start, towards, Math.min(1, Math.max(0, t)))));
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i += 1) {
    const t = (low + high) / 2;
    if (meets(contrastRatio(at(t), bg), target)) high = t;
    else low = t;
  }
  let result = at(high);
  for (let t = high; t < 1 && !meets(contrastRatio(result, bg), target); t += 1 / 255) {
    result = at(t);
  }
  return toHex(result);
}

export type BrandColorVerdict = {
  /** Normalised `#rrggbb`. */
  color: string;
  /** The more readable of the two foreground tokens on this colour. */
  foreground: string;
  /** Contrast of `foreground` on `color`. */
  ratio: number;
  /** Contrast of `color` used as text on the app's surface. */
  ratioAsText: number;
  /** True when a button label on this colour clears AA. */
  passesAsButton: boolean;
  /** True when the colour is legible as text/links on the app surface. */
  passesAsText: boolean;
};

/**
 * Everything a branding form (or the API that accepts the value) needs to
 * decide whether a library's chosen colour is usable.
 *
 * `--color-primary` is not only a button background: it is also link and
 * active-nav *text* on white (`.lbr-nav__link--active`, `.lbr-toast__action`),
 * so both directions have to be checked. Returns null for an unparseable hex
 * so the caller can keep its own "not a colour" error message.
 */
export function checkBrandColor(
  hex: string,
  options: { surface?: string; light?: string; dark?: string } = {},
): BrandColorVerdict | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const surface = options.surface ?? '#ffffff';
  const light = options.light ?? '#ffffff';
  const dark = options.dark ?? '#0d1117';
  const foreground = readableForeground(rgb, light, dark);
  const ratio = contrastRatio(rgb, foreground);
  const ratioAsText = contrastRatio(rgb, surface);
  return {
    color: toHex(rgb),
    foreground,
    ratio,
    ratioAsText,
    passesAsButton: meets(ratio, AA_TEXT),
    passesAsText: meets(ratioAsText, AA_TEXT),
  };
}
