'use client';
import * as React from 'react';

/**
 * A stable Idempotency-Key for one logical circulation action. The SAME key is
 * reused across a double-click or a retry-after-network-failure, so the server
 * dedupes them into one operation (no double fine / double loan). Call
 * `rotate()` after a SUCCESSFUL submit so the next distinct action (e.g. a
 * deliberate second renewal) gets a fresh key instead of replaying the first.
 */
export function useIdempotencyKey(): { key: string; rotate: () => void } {
  const [key, setKey] = React.useState(() => crypto.randomUUID());
  const rotate = React.useCallback(() => setKey(crypto.randomUUID()), []);
  return { key, rotate };
}
