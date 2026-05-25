/**
 * Typed shape of the design tokens stored in /assets/theme/tokens.json.
 * The actual values live in that file, not here — code must never hardcode
 * colours/fonts/spacing. Values are loaded at runtime from /assets/theme/tokens.json
 * and emitted as CSS custom properties on :root.
 */
export type DesignTokens = {
  name: string;
  version: string;
  colors: Record<string, string>;
  fonts: Record<string, string>;
  fontSizes: Record<string, string>;
  spacing: Record<string, string>;
  radius: Record<string, string>;
  shadow: Record<string, string>;
};

/**
 * Convert a DesignTokens object into a CSS string that sets every value
 * as a custom property on :root. Consumed by the web app at boot.
 */
export function tokensToCssVars(tokens: DesignTokens): string {
  const lines: string[] = [':root {'];
  for (const [k, v] of Object.entries(tokens.colors)) lines.push(`  --color-${k}: ${v};`);
  for (const [k, v] of Object.entries(tokens.fonts)) lines.push(`  --font-${k}: ${v};`);
  for (const [k, v] of Object.entries(tokens.fontSizes)) lines.push(`  --fs-${k}: ${v};`);
  for (const [k, v] of Object.entries(tokens.spacing)) lines.push(`  --sp-${k}: ${v};`);
  for (const [k, v] of Object.entries(tokens.radius)) lines.push(`  --radius-${k}: ${v};`);
  for (const [k, v] of Object.entries(tokens.shadow)) lines.push(`  --shadow-${k}: ${v};`);
  lines.push('}');
  return lines.join('\n');
}
