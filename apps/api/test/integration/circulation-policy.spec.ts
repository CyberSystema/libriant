import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { compareRank, resolveCirculationPolicy, type CirculationRule } from '@libriant/circ-policy';
import type { TenantPrismaClientV2 } from '@libriant/db-tenant';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { TenantPrismaService } from '../../src/tenancy/tenant-prisma.service.js';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service.js';
import type { TenantContext } from '../../src/tenancy/tenant-context.js';
import { DEFAULT_IDS } from '../../src/policy/circulation-defaults.js';
import { PolicySnapshotService } from '../../src/policy/policy-snapshot.service.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Circulation policy is what decides when a book is due. A library whose subscription has ' +
    'lapsed must still be able to check a book back in and answer a patron asking why it was ' +
    'due when it was.',
);

/**
 * Phase 13 — the policy engine service.
 *
 * §6's acceptance clause, sentence by sentence:
 *
 *   "Deleting or disabling the wildcard rule is refused with a typed error"  → §2
 *   "a duplicate scope 409s from the partial unique"                         → §2
 *   "A policy write bumps circulation_policy_version IN THE SAME TRANSACTION" → §3
 *   "every pod serves the new snapshot within 1 s (pub/sub) or 30 s (TTL)"   → §3
 *   "Resolution p99 < 0.2 ms over a 500-rule snapshot"                       → §4
 *   "/circulation/explain returns matchedRuleId, beatenRuleIds and the rolls" → §5
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let dbUrl = '';
let owner = '';
let v2: TenantPrismaClientV2;
let ctx: TenantContext;
let snapshots: PolicySnapshotService;

const SESSION_RE = /^(__Host-)?libriant_session=/;
function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}

/** Raw SQL against the tenant's 2.0 schema. Always `lbr2.`-qualified. */
async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

const api = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error'],
  });
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await listenOnce(app);

  slug = `circpol-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Policy ${slug}`,
      slug,
      fullName: `Owner ${slug}`,
      email: `owner@${slug}.test`,
      password: 'owner-signup-pw-123',
      acceptLegal: true,
      libraryType: 'public',
      addressStreet: '1 Library St',
      addressCity: 'Athens',
      addressPostalCode: '10000',
      addressCountry: 'GR',
    })
    .expect(201);
  owner = cookieFrom(res, SESSION_RE);
  const t = await controlDb.tenant.findUnique({ where: { slug } });
  dbUrl = t!.dbUrl;

  ctx = (await app.get(TenantResolverService).resolveBySlug(slug))!;
  v2 = app.get(TenantPrismaService).getClientV2(ctx);
  snapshots = app.get(PolicySnapshotService);
}, 240_000);

afterAll(async () => {
  await app?.close();
});

// ---------------------------------------------------------------------------
// 1. A new library can lend on day one
// ---------------------------------------------------------------------------

describe('provisioning leaves a library able to lend', () => {
  it('seeds the wildcard rule and its five policies', async () => {
    // Without this a brand-new library resolves `NO_MATCHING_RULE` on its first
    // checkout — the desk refuses, correctly and unhelpfully — which is the one
    // failure `packages/circ-policy`'s refusal to export a default guarantees
    // somebody else has to prevent.
    const rules = await v2.circulationRule.findMany();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.id).toBe(DEFAULT_IDS.wildcardRule);
    expect(rules[0]!.patronCategoryId).toBeNull();
    expect(rules[0]!.itemTypeId).toBeNull();

    const [{ specificity }] = await sql<{ specificity: number }>(
      `SELECT specificity FROM lbr2.circulation_rules WHERE id = $1`,
      [DEFAULT_IDS.wildcardRule],
    );
    expect(specificity).toBe(0);

    expect(await v2.loanPolicy.count()).toBe(1);
    expect(await v2.overdueFinePolicy.count()).toBe(1);
    expect(await v2.lostItemFeePolicy.count()).toBe(1);
    expect(await v2.holdPolicy.count()).toBe(1);
    expect(await v2.noticePolicy.count()).toBe(1);
  });

  it('starts in simple mode — the matrix is off until a library asks for it', async () => {
    // §8 risk 6: "simple mode is the DEFAULT". A five-person school library must
    // not be handed a rules matrix it did not ask for.
    const res = await api().get(`/t/${slug}/circulation/policy`).set('Cookie', owner).expect(200);
    expect(res.body.circulationRulesEnabled).toBe(false);
  });

  it('the resolver answers from the seeded snapshot', async () => {
    const snapshot = await snapshots.get(ctx);
    const resolved = resolveCirculationPolicy(snapshot, {
      patronCategoryId: null,
      itemTypeId: null,
      owningBranchId: null,
      shelvingLocationId: null,
      checkoutBranchId: null,
      pickupBranchId: null,
      at: new Date('2026-05-05T09:00:00Z'),
    });
    expect(resolved.trace.matchedRuleId).toBe(DEFAULT_IDS.wildcardRule);
    expect(resolved.trace.beatenRuleIds).toEqual([]);
    expect(resolved.loan.period).toEqual({ value: 14, unit: 'days' });
  });
});

// ---------------------------------------------------------------------------
// 2. The two refusals the phase line names
// ---------------------------------------------------------------------------

describe('the wildcard rule cannot be removed', () => {
  it('refuses to DELETE it, with a typed code', async () => {
    const res = await api()
      .delete(`/t/${slug}/circulation/rules/${DEFAULT_IDS.wildcardRule}`)
      .set('Cookie', owner)
      .expect(409);
    expect(res.body.code).toBe('circulation.wildcardRuleRequired');
    // The message has to say what would happen, not that a constraint fired.
    expect(res.body.message).toContain('refuse every checkout');
    expect(await v2.circulationRule.count()).toBe(1);
  });

  it('refuses to DISABLE it — a disabled wildcard is present and matches nothing', async () => {
    const res = await api()
      .patch(`/t/${slug}/circulation/rules/${DEFAULT_IDS.wildcardRule}`)
      .set('Cookie', owner)
      .send({ enabled: false })
      .expect(409);
    expect(res.body.code).toBe('circulation.wildcardRuleRequired');
  });

  it('refuses to give it an END DATE, which retires it just as surely', async () => {
    // `isInForce` cannot tell an expired rule from a deleted one, and the row
    // reads as live in the editor. This is the third door.
    const res = await api()
      .patch(`/t/${slug}/circulation/rules/${DEFAULT_IDS.wildcardRule}`)
      .set('Cookie', owner)
      .send({ effectiveTo: '2026-01-01T00:00:00.000Z' })
      .expect(409);
    expect(res.body.code).toBe('circulation.wildcardRuleRequired');
  });

  it('refuses to give it a START DATE, which is the sharpest of the three', async () => {
    // A wildcard with `effective_from` in the future satisfies both partial
    // unique indexes and looks perfectly configured, and every checkout until
    // that date raises NO_MATCHING_RULE.
    const res = await api()
      .patch(`/t/${slug}/circulation/rules/${DEFAULT_IDS.wildcardRule}`)
      .set('Cookie', owner)
      .send({ effectiveFrom: '2099-01-01T00:00:00.000Z' })
      .expect(409);
    expect(res.body.code).toBe('circulation.wildcardRuleRequired');
  });

  it('EDITING it is allowed — that is the whole of simple mode', async () => {
    await api()
      .patch(`/t/${slug}/circulation/rules/${DEFAULT_IDS.wildcardRule}`)
      .set('Cookie', owner)
      .send({ maxLoansForRule: 20 })
      .expect(200);
    const rule = await v2.circulationRule.findUnique({ where: { id: DEFAULT_IDS.wildcardRule } });
    expect(rule!.maxLoansForRule).toBe(20);
  });
});

describe('two rules cannot share one scope', () => {
  const body = (name: string) => ({
    name,
    itemTypeId: 'it-dvd',
    loanPolicyId: DEFAULT_IDS.loanPolicy,
    overdueFinePolicyId: DEFAULT_IDS.finePolicy,
    lostItemFeePolicyId: DEFAULT_IDS.lostItemPolicy,
    holdPolicyId: DEFAULT_IDS.holdPolicy,
    noticePolicyId: DEFAULT_IDS.noticePolicy,
  });

  it('accepts the first, 409s the second from the partial unique', async () => {
    await api()
      .post(`/t/${slug}/circulation/rules`)
      .set('Cookie', owner)
      .send(body('DVDs'))
      .expect(201);

    const res = await api()
      .post(`/t/${slug}/circulation/rules`)
      .set('Cookie', owner)
      .send(body('DVDs again'))
      .expect(409);
    // Not a 500. Prisma 7 with a driver adapter leaves `meta.target` undefined
    // and reports the constraint at `meta.driverAdapterError.cause.constraint`,
    // so the mapper matches the whole stringified meta plus the message.
    expect(res.body.code).toBe('circulation.duplicateRuleScope');
    expect(res.body.message).toContain('tie on every ranking key');
  });

  it('a SECOND wildcard is refused with its own message', async () => {
    const res = await api()
      .post(`/t/${slug}/circulation/rules`)
      .set('Cookie', owner)
      .send({
        name: 'Another default',
        loanPolicyId: DEFAULT_IDS.loanPolicy,
        overdueFinePolicyId: DEFAULT_IDS.finePolicy,
        lostItemFeePolicyId: DEFAULT_IDS.lostItemPolicy,
        holdPolicyId: DEFAULT_IDS.holdPolicy,
        noticePolicyId: DEFAULT_IDS.noticePolicy,
      })
      .expect(409);
    expect(res.body.code).toBe('circulation.duplicateWildcardRule');
  });
});

// ---------------------------------------------------------------------------
// 3. The version counter, and propagation
// ---------------------------------------------------------------------------

describe('circulation_policy_version', () => {
  it('is bumped by the DATABASE, in the same transaction as the write', async () => {
    // The whole point of a trigger over an `emit()`: this write goes through
    // raw SQL, touching no application code at all, and the counter still moves.
    // Phase 19's copy-forward is PL/pgSQL and does exactly this.
    const [before] = await sql<{ version: number }>(
      `SELECT version FROM lbr2.circulation_policy_version WHERE id = 1`,
    );
    await sql(`UPDATE lbr2.loan_policies SET period_value = 21 WHERE id = $1`, [
      DEFAULT_IDS.loanPolicy,
    ]);
    const [after] = await sql<{ version: number }>(
      `SELECT version FROM lbr2.circulation_policy_version WHERE id = 1`,
    );
    expect(after!.version).toBeGreaterThan(before!.version);
  });

  it('bumps ONCE for a multi-row statement, not once per row', async () => {
    const [before] = await sql<{ version: number }>(
      `SELECT version FROM lbr2.circulation_policy_version WHERE id = 1`,
    );
    // Both rules in one statement.
    const touched = await sql(`UPDATE lbr2.circulation_rules SET priority = priority RETURNING id`);
    expect(touched.length).toBeGreaterThan(1);
    const [after] = await sql<{ version: number }>(
      `SELECT version FROM lbr2.circulation_policy_version WHERE id = 1`,
    );
    expect(after!.version - before!.version).toBe(1);
  });

  it('a rollback takes the bump with it', async () => {
    // The counter is only meaningful if it names a state that exists. Because
    // the trigger runs inside the writing transaction, an aborted policy edit
    // cannot leave every pod rebuilding for a change that never happened.
    const [before] = await sql<{ version: number }>(
      `SELECT version FROM lbr2.circulation_policy_version WHERE id = 1`,
    );
    const client = new PgClient({ connectionString: dbUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE lbr2.loan_policies SET period_value = 999 WHERE id = $1`, [
        DEFAULT_IDS.loanPolicy,
      ]);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
    const [after] = await sql<{ version: number }>(
      `SELECT version FROM lbr2.circulation_policy_version WHERE id = 1`,
    );
    expect(after!.version).toBe(before!.version);
  });

  it('two concurrent bumps produce two distinct versions, not one', async () => {
    // `version = version + 1` under ReadCommitted: Postgres re-fetches the
    // newly committed row and re-evaluates the expression against it. A
    // read-then-write in application code loses this update, which is the
    // concrete reason the bump is not in a service.
    const [before] = await sql<{ version: number }>(
      `SELECT version FROM lbr2.circulation_policy_version WHERE id = 1`,
    );
    const a = new PgClient({ connectionString: dbUrl });
    const b = new PgClient({ connectionString: dbUrl });
    await a.connect();
    await b.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query(`UPDATE lbr2.hold_policies SET max_transit_days = 5 WHERE id = $1`, [
        DEFAULT_IDS.holdPolicy,
      ]);
      // B blocks on A's row lock until A commits, then re-evaluates.
      const bWrite = b.query(`UPDATE lbr2.hold_policies SET max_transit_days = 6 WHERE id = $1`, [
        DEFAULT_IDS.holdPolicy,
      ]);
      await a.query('COMMIT');
      await bWrite;
      await b.query('COMMIT');
    } finally {
      await a.end();
      await b.end();
    }
    const [after] = await sql<{ version: number }>(
      `SELECT version FROM lbr2.circulation_policy_version WHERE id = 1`,
    );
    expect(after!.version).toBe(before!.version + 2);
  });
});

describe('a second process sees a policy change', () => {
  /**
   * Two `PolicySnapshotService` instances in one process is the honest stand-in
   * for two pods: each has its own LRU, its own subscription and its own view,
   * and they share one Redis and one Postgres — which is exactly what
   * distinguishes a pod from a thread here.
   */
  let podB: PolicySnapshotService;

  beforeAll(async () => {
    podB = new PolicySnapshotService(new RedisService(), app.get(TenantPrismaService), {
      freshnessMs: 50,
      ttlMs: 30_000,
      staleCeilingMs: 900_000,
      maxTenants: 10,
    });
    await podB.onModuleInit();
  }, 30_000);

  afterAll(async () => {
    await podB.onModuleDestroy();
  });

  it('THE NEGATIVE CONTROL: a write behind the service is NOT seen', async () => {
    // Without this the positive case below proves only that a cache expires.
    // A raw SQL write bumps the counter but announces nothing, so pod B keeps
    // serving what it holds until its own freshness window lapses.
    const first = await podB.get(ctx);
    await sql(`UPDATE lbr2.loan_policies SET name = 'Behind the service' WHERE id = $1`, [
      DEFAULT_IDS.loanPolicy,
    ]);
    const immediately = await podB.get(ctx);
    expect(immediately.version).toBe(first.version);
    expect(immediately.loanPolicies[DEFAULT_IDS.loanPolicy]!.name).not.toBe('Behind the service');
  });

  it('sees a change made through the API within one second', async () => {
    await podB.get(ctx);
    const before = (await podB.get(ctx)).version;

    const started = Date.now();
    await api()
      .patch(`/t/${slug}/circulation/rules/${DEFAULT_IDS.wildcardRule}`)
      .set('Cookie', owner)
      .send({ name: 'Renamed by pod A' })
      .expect(200);

    // Poll rather than sleep: the number that matters is how long it took, and
    // the assertion is on the elapsed time, not on a fixed wait.
    let elapsed = -1;
    const deadline = started + 5_000;
    while (Date.now() < deadline) {
      const snap = await podB.get(ctx);
      if (snap.version > before) {
        elapsed = Date.now() - started;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    // eslint-disable-next-line no-console
    console.log(`policy change reached the second process in ${elapsed} ms`);
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(1_000);

    const rule = (await podB.get(ctx)).rules.find((r) => r.id === DEFAULT_IDS.wildcardRule);
    expect(rule!.name).toBe('Renamed by pod A');
  });
});

// ---------------------------------------------------------------------------
// 4. The budget
// ---------------------------------------------------------------------------

describe('resolution over a 500-rule snapshot', () => {
  it('p99 < 0.2 ms, and beatenRuleIds stays O(matched)', async () => {
    const snapshot = await snapshots.get(ctx);
    // Built in memory rather than in the database: the criterion measures
    // `resolveCirculationPolicy`, which §4.1 defines as pure and synchronous, so
    // the 500 rules only have to be a 500-rule PolicySnapshot. Inserting them
    // would measure Postgres.
    const rules: CirculationRule[] = [...snapshot.rules];
    const base = snapshot.rules.find((r) => r.id === DEFAULT_IDS.wildcardRule)!;
    for (let i = rules.length; i < 500; i += 1) {
      rules.push({
        ...base,
        id: `perf-${String(i).padStart(4, '0')}`,
        name: `Perf ${i}`,
        // Every rule matches a DIFFERENT category, so exactly one of them plus
        // the wildcard matches the context below. A 500-rule snapshot in which
        // 500 rules match would measure a different thing.
        patronCategoryId: `cat-${i}`,
      });
    }
    const big = { ...snapshot, rules };
    const ctxAt: Parameters<typeof resolveCirculationPolicy>[1] = {
      patronCategoryId: 'cat-250',
      itemTypeId: null,
      owningBranchId: null,
      shelvingLocationId: null,
      checkoutBranchId: null,
      pickupBranchId: null,
      at: new Date('2026-05-05T09:00:00Z'),
    };

    // Prime, then measure. 2,000 samples so a p99 is 20 observations deep.
    for (let i = 0; i < 200; i += 1) resolveCirculationPolicy(big, ctxAt);
    const N = 2_000;
    const samples = new Float64Array(N);
    for (let i = 0; i < N; i += 1) {
      const t0 = process.hrtime.bigint();
      resolveCirculationPolicy(big, ctxAt);
      samples[i] = Number(process.hrtime.bigint() - t0) / 1e6;
    }
    samples.sort();
    const p50 = samples[Math.floor(N * 0.5)]!;
    const p99 = samples[Math.floor(N * 0.99)]!;
    // eslint-disable-next-line no-console
    console.log(`resolution over 500 rules: p50 ${p50.toFixed(4)} ms, p99 ${p99.toFixed(4)} ms`);
    expect(p99).toBeLessThan(0.2);

    // The machine-independent half, which is the assertion that actually
    // protects the budget: `beatenRuleIds` is bounded by the rules that MATCHED,
    // not by the size of the snapshot. The naive reading returns 499 ids on
    // every checkout and is O(N) in allocation no matter how fast the sort is.
    const resolved = resolveCirculationPolicy(big, ctxAt);
    expect(resolved.trace.beatenRuleIds.length).toBeLessThanOrEqual(2);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. Explain
// ---------------------------------------------------------------------------

describe('GET /circulation/explain', () => {
  it('names the rule that won, the rules it beat, and the snapshot version', async () => {
    const res = await api()
      .get(`/t/${slug}/circulation/explain`)
      .query({ itemTypeId: 'it-dvd' })
      .set('Cookie', owner)
      .expect(200);

    // The three names §4.1 fixes, unrenamed.
    expect(res.body.matchedRuleId).toBeTypeOf('string');
    expect(Array.isArray(res.body.beatenRuleIds)).toBe(true);
    expect(Array.isArray(res.body.calendarRolls)).toBe(true);
    expect(res.body.snapshotVersion).toBeTypeOf('number');

    // The DVD rule created in §2 beats the wildcard on specificity 16 to 0.
    expect(res.body.beatenRuleIds).toContain(DEFAULT_IDS.wildcardRule);
    expect(res.body.selectorsUsed).toEqual(['itemTypeId']);
    expect(res.body.wildcardsUsed).toContain('patronCategoryId');
    expect(res.body.policies.loan.id).toBe(DEFAULT_IDS.loanPolicy);
  });

  it('says why there is no due date rather than inventing one', async () => {
    // No branch means no calendar, and a due date computed against a calendar
    // chosen at random is worse than no due date with a sentence explaining it.
    const res = await api().get(`/t/${slug}/circulation/explain`).set('Cookie', owner).expect(200);
    expect(res.body.dueAt).toBeNull();
    expect(res.body.dueDateNote).toContain('No branch was named');
  });

  it('resolves AT AN INSTANT, so a historical charge can be explained', async () => {
    const res = await api()
      .get(`/t/${slug}/circulation/explain`)
      .query({ at: '2026-03-01T12:00:00.000Z' })
      .set('Cookie', owner)
      .expect(200);
    expect(res.body.resolvedAt).toBe('2026-03-01T12:00:00.000Z');
  });

  it('turning the matrix ON is always allowed', async () => {
    const res = await api()
      .put(`/t/${slug}/circulation/mode`)
      .set('Cookie', owner)
      .send({ circulationRulesEnabled: true })
      .expect(200);
    expect(res.body.circulationRulesEnabled).toBe(true);
  });

  it('turning it OFF is refused while rules with conditions exist', async () => {
    // The asymmetry is the point. Simple mode shows one form describing the
    // wildcard and no way to see the others — but the others would go on
    // deciding loan periods and fines invisibly. Deleting them silently is
    // worse again: they are the library's configuration, not ours.
    const res = await api()
      .put(`/t/${slug}/circulation/mode`)
      .set('Cookie', owner)
      .send({ circulationRulesEnabled: false })
      .expect(409);
    expect(res.body.code).toBe('circulation.rulesStillPresent');
    expect(res.body.ruleCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. The collation trap
// ---------------------------------------------------------------------------

describe('rule order is decided in JavaScript, never by Postgres', () => {
  it('SQL and the resolver disagree on ids a human would choose', async () => {
    // Measured across the three collations this code meets: production tenants
    // are ICU el-GR (the compose file's initdb args), this machine's dev cluster
    // is libc en_US.UTF-8, and `compareRank` is UTF-16 code units. All three
    // disagree, so ANY reliance on the database's order would give a different
    // winner in production than in the test that passed.
    const ids = ['R-default', 'ckv1a2b3c', 'r-default', 'r_default', 'rdefault'];
    const [icuish] = await sql<{ ordered: string[] }>(
      `SELECT array_agg(id ORDER BY id) AS ordered FROM unnest($1::text[]) AS t(id)`,
      [ids],
    );
    const [cOrder] = await sql<{ ordered: string[] }>(
      `SELECT array_agg(id ORDER BY id COLLATE "C") AS ordered FROM unnest($1::text[]) AS t(id)`,
      [ids],
    );
    const js = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    expect(cOrder!.ordered).toEqual(js);
    // The load-bearing assertion: the DEFAULT collation is NOT JavaScript's.
    expect(icuish!.ordered).not.toEqual(js);
  });

  it('compareRank is a total order, so the loaded array order cannot matter', async () => {
    const snapshot = await snapshots.get(ctx);
    const forward = [...snapshot.rules].sort(compareRank).map((r) => r.id);
    const reversed = [...snapshot.rules]
      .reverse()
      .sort(compareRank)
      .map((r) => r.id);
    expect(reversed).toEqual(forward);
  });
});
