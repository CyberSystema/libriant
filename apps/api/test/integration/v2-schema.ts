import { V2_SCHEMA } from '@libriant/db-tenant';

/**
 * The Postgres schema the 2.0 tables live in, for the specs that ask the
 * catalogue about them (2.0 phase 20b-ii).
 *
 * ## Why this exists
 *
 * Six integration specs interrogate `information_schema` or `pg_catalog` with
 * the schema name written as a literal — `WHERE table_schema = 'lbr2'`. Phase
 * 20b-iii renames that schema to `public`, and on the day it does, every one of
 * those predicates starts matching **nothing** and every assertion built on it
 * passes on an empty result set.
 *
 * That is the same failure the phase-20b-i work found in verifier assertion
 * G03, which had been sitting in a green list of 42 unable to fail. The one in
 * `patrons.spec.ts` is worse than G03 was, because of what it is standing in
 * for: §5 promises `check:dsar-coverage` at phases 33 and 96 and it does not
 * exist, so three `it()` blocks are the ONLY thing keeping the patron data map
 * honest — and the map is what drives the Article 15 bundle and the Article 17
 * erase. A vacuous coverage assertion over a GDPR bundle is the worst instance
 * of this class in the repository.
 *
 * ## Why a constant and not a rename
 *
 * The specs could have been rewritten to say `'public'` at cutover time, in the
 * same commit as everything else 20b-iii touches. Importing the constant the
 * runtime already uses means they follow the schema wherever it goes and there
 * is nothing to remember — `V2_SCHEMA` is the single value the Prisma v2 client
 * is bound with, so a spec and the application cannot disagree about where the
 * tables are.
 *
 * Interpolating it into SQL is safe and stays safe: it is a compile-time
 * constant from this repository, never a value from a request.
 */
export const V2 = V2_SCHEMA;

/**
 * `WHERE <col> = 'lbr2'` as a fragment, for readability at the call sites.
 *
 * Deliberately not a template-literal tag: these queries are already written as
 * plain strings passed to a `sql()` helper, and a tag would mean rewriting six
 * specs to gain nothing a constant does not already give.
 */
export const V2_SCHEMA_LITERAL = `'${V2_SCHEMA}'`;
