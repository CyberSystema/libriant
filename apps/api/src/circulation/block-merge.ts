import type { Block } from '@libriant/circ-policy';

/**
 * The two block sources, composed.
 *
 * STORED blocks (`patron_blocks`, phase 14) and COMPUTED ones (`evaluateBlocks`)
 * are concatenated, and the stored one wins on a shared code. Two codes overlap
 * — `too_many_overdues` and `fine_limit_exceeded` — and they agree because both
 * read the same policy; when they do not, the stored one is the one a librarian
 * has seen on the screen and possibly acted on, so showing the computed one
 * instead would contradict something the desk already said out loud.
 *
 * ## Why it is its own file rather than a private function in `checkout`
 *
 * Phase 16 wrote it inside `CheckoutService`, which was right when there was one
 * caller. Phase 17 adds the second — a hold placement evaluates the same stored
 * blocks against a different half of the same policy — and a copied merge is how
 * two surfaces end up disagreeing about which block a reader is shown. The
 * override permission a block carries is the thing a desk greys a button on, and
 * two implementations of that would be two answers to one question.
 */
export function mergeBlocks(
  stored: readonly { code: string; severity: string; reason: string | null }[],
  computed: readonly Block[],
): readonly Block[] {
  const out: Block[] = stored.map((s) => ({
    code: s.code as Block['code'],
    severity: s.severity === 'warn' ? 'warn' : 'block',
    overridable: true,
    overridePermission: 'circ.checkout.override',
    ...(s.reason === null ? {} : { observed: s.reason }),
  }));
  const seen = new Set(out.map((b) => b.code.toLowerCase()));
  for (const c of computed) {
    if (!seen.has(c.code.toLowerCase())) out.push(c);
  }
  return out;
}
