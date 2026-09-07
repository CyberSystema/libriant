import type { TenantActor } from './tenant-actor.js';

/**
 * Tell the database who is acting, so the changelog triggers can attribute.
 *
 * ## Why a session setting and not a column
 *
 * `change_events` is written by TRIGGERS (§4.2), and a trigger cannot see who is
 * logged in. The actor therefore has to arrive out-of-band, through three
 * custom GUCs the trigger reads with `current_setting(…, true)`. Without them
 * every event is attributed to `system`, which is true but useless: "who
 * changed this record?" is the first question asked about a catalogue.
 *
 * ## Three things about this that are not optional
 *
 * **It must be INSIDE a transaction.** `SET LOCAL` outside a transaction block
 * is a no-op that only emits a warning, and a session-level `SET` is worse: on a
 * pooled connection it leaks the previous request's actor onto whatever reuses
 * the backend, so a nightly job writes events attributed to the last librarian
 * who happened to share it. `set_config(name, value, true)` is the
 * transaction-local form, and it reverts at COMMIT or ROLLBACK.
 *
 * **It must be parameterised.** `SET LOCAL x = $1` is not valid SQL — it is a
 * `42601` syntax error with a bind parameter — so the only safe form is
 * `set_config(name, $1, true)`. Actor ids come from a session token and are
 * user-influenced; string-interpolating them into a SET would be an injection
 * into every write path in the catalogue.
 *
 * **The empty string is not NULL.** Once a backend has run `set_config(…, true)`
 * once, the setting is `''` afterwards rather than unset — measured — so the
 * trigger reads every GUC through `NULLIF(…, '')`. That is the trigger's half of
 * this contract, and it is why an unattributed write after an attributed one on
 * the same connection lands as `system` instead of raising `22P02 invalid input
 * value for enum audit_actor_kind: ""`.
 *
 * ## Not middleware, not a guard, not an interceptor
 *
 * All three run outside the transaction the write happens in, so a setting made
 * there would either be a no-op (`SET LOCAL` with no transaction) or a leak
 * (session-level `SET`). It has to be the first thing the transaction does,
 * which means the service calls it.
 */

/** `audit_actor_kind` in the 2.0 schema. */
export type ActorKind = 'user' | 'admin' | 'system' | 'device';

export type ChangeActor = {
  readonly kind: ActorKind;
  readonly id: string | null;
  /** The offline client that produced this change, from M8. */
  readonly deviceId?: string | null;
};

/**
 * A {@link TenantActor} as the changelog wants it.
 *
 * The three 1.0 `AuditActorType` values map onto the 2.0 enum unchanged, which
 * is why the phase-9 enum kept them verbatim; `device` has no 1.0 equivalent and
 * arrives with M8.
 */
export function changeActorOf(actor: TenantActor, deviceId?: string | null): ChangeActor {
  return { kind: actor.actorType, id: actor.actorId, deviceId: deviceId ?? null };
}

/** The system actor, for sweeps and migrations. Explicit rather than implied. */
export const SYSTEM_ACTOR: ChangeActor = { kind: 'system', id: null, deviceId: null };

/** The minimum of a Prisma transaction client this module needs. */
export type RawExecutor = {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
};

/**
 * Set the actor for the rest of THIS transaction.
 *
 * Call it once, early, inside `$transaction`. One statement rather than three so
 * the round trip is paid once per write.
 */
export async function setChangeActor(tx: RawExecutor, actor: ChangeActor): Promise<void> {
  await tx.$executeRaw`SELECT
    pg_catalog.set_config('libriant.actor_kind', ${actor.kind}, true),
    pg_catalog.set_config('libriant.actor_id', ${actor.id ?? ''}, true),
    pg_catalog.set_config('libriant.device_id', ${actor.deviceId ?? ''}, true)`;
}
