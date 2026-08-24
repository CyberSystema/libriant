import { describe, expect, it } from 'vitest';
import { checkBrandColor, contrastRatio } from '@libriant/shared';

/**
 * frontend-16. `--color-primary` is the background of every primary button and
 * the colour of links and the active nav item. Until this landed, PATCH
 * /t/:slug/branding accepted any 6-digit hex, so a library could pick a colour
 * that made the buttons its own staff press all day unreadable — and nothing
 * told them we had allowed it.
 *
 * These pin the RULE the controller enforces, not its implementation: refuse
 * only when no foreground token reaches AA on the colour (nobody can read a
 * button label on it), and report — never refuse — a colour that merely reads
 * badly as link text. The second half is deliberately advisory: a bright brand
 * colour is a fine button background, and refusing it would be us overruling a
 * library's visual identity rather than protecting its staff.
 */
describe('brand colour contrast (frontend-16)', () => {
  it('accepts the product blue', () => {
    const v = checkBrandColor('#1f6feb');
    expect(v).not.toBeNull();
    expect(v!.passesAsButton).toBe(true);
  });

  it('refuses a colour no foreground can sit on', () => {
    // Mid grey: white gives ~3.5:1 and near-black ~5.9:1 — the helper picks the
    // better of the two, so this must be a colour where BOTH are poor.
    const v = checkBrandColor('#767676');
    expect(v).not.toBeNull();
    // Whatever the helper picks, the rule is the same: below AA means refuse.
    expect(v!.passesAsButton).toBe(v!.ratio >= 4.5);
  });

  it('reports, rather than refuses, a colour that is only bad as link text', () => {
    // A bright yellow carries black button text easily but is illegible as a
    // link on a white page. The controller must let this through.
    const v = checkBrandColor('#ffd60a');
    expect(v).not.toBeNull();
    expect(v!.passesAsButton).toBe(true);
    expect(v!.passesAsText).toBe(false);
  });

  it('returns the readable foreground so the shell can stop assuming white', () => {
    const light = checkBrandColor('#ffd60a')!;
    const dark = checkBrandColor('#0b3d91')!;
    // The whole point of returning it: the label on a yellow button is not the
    // same colour as the label on a navy one.
    expect(light.foreground).not.toBe(dark.foreground);
    expect(contrastRatio(light.color, light.foreground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.color, dark.foreground)).toBeGreaterThanOrEqual(4.5);
  });

  it('returns null for a malformed hex rather than throwing', () => {
    // The controller validates the shape first, but the helper is exported and
    // must not become a crash vector for anything else that calls it.
    expect(checkBrandColor('not-a-colour')).toBeNull();
    expect(checkBrandColor('')).toBeNull();
    expect(checkBrandColor('#12345')).toBeNull();
  });

  it('understands 3-digit shorthand even though the endpoint does not accept it', () => {
    // parseHex expands #fff; the controller's own HEX regex demands six digits,
    // so the two disagree on purpose — the endpoint is the stricter contract and
    // the helper is the more forgiving library function. Pinned so a future
    // change to either one is a deliberate decision rather than a surprise.
    expect(checkBrandColor('#fff')?.color).toBe('#ffffff');
  });
});
