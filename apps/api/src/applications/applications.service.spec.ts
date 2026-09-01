import { describe, expect, it, vi, beforeEach } from 'vitest';

// Repo convention for a service that reads config in its constructor.
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    applyHashPepper: 'unit-test-pepper-0123456789abcdef0123',
    applyNotifyTo: 'info@example.test',
    // Both are read for the operator-facing log line the offer's only working
    // notification channel is made of; see the `notify` block at the bottom.
    adminHost: 'admin.example.test',
    emailDriver: 'console',
    // The service owns a NotifyService, which reads these in ITS constructor.
    // `ntfyTopic: null` is the shipped default — off — so no unit test can
    // open a socket to a third party by accident; the tests that care about
    // the push assert on a spy over `sendDetached`, not on the wire.
    ntfyServer: 'https://ntfy.invalid',
    ntfyTopic: null,
    ntfyToken: null,
    ntfyMinLevel: 'info',
    ntfyConfigProblem: null,
  }),
}));

// `offerState` counts accepted applications, which is the whole of
// launch-readiness-11 — the unit suite has no database, so the count is the
// thing under test's only collaborator here.
const { applicationCount, applicationCreate } = vi.hoisted(() => ({
  applicationCount: vi.fn(),
  // `save` is the commit point, and what it puts in the row is worth asserting
  // there rather than inferring from the columns further downstream.
  applicationCreate: vi.fn(),
}));
vi.mock('@libriant/db-control', () => ({
  controlDb: {
    application: { count: applicationCount, create: applicationCreate, update: vi.fn() },
  },
}));

import { ERRORS } from '@libriant/site';
import { NotifyService } from '../platform/notify.service.js';
import {
  ApplicationsService,
  OFFER_TOTAL,
  applicationAnnouncement,
  dialablePhone,
} from './applications.service.js';

/**
 * Validation is ported verbatim from the Cloudflare Worker this replaces, and
 * these cases are the acceptance criteria for that port. The rules matter more
 * than they look: each one is the difference between a real library's
 * application arriving and being silently dropped.
 */

const E = ERRORS.el;

function makeService(
  hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 }),
  redisStatus = 'ready',
) {
  const email = { enqueue: vi.fn().mockResolvedValue(undefined) };
  const rateLimit = { hit };
  // ioredis exposes the socket state as `client.status`; the service reads it
  // to tell "the ceiling counted 61" from "nothing counted anything".
  const redis = { client: { status: redisStatus } };
  // The constructor reads env; the loadEnv mock above supplies the pepper.
  // Nothing sets HASH_PEPPER in the unit environment — the integration suite
  // has to set it itself, in test/integration/setup.ts.
  // The real NotifyService, with the env mock's `ntfyTopic: null` — so it is
  // OFF, exactly as a host that has not configured ntfy has it, and no unit
  // test can open a socket to a third party by accident.
  const notifier = new NotifyService();
  const svc = new ApplicationsService(email as never, rateLimit as never, redis as never, notifier);
  // The degraded-ceiling path logs one warn per accepted submission; captured
  // rather than printed so a 60-submission test does not bury the run, and so
  // the tests below can assert the operator actually gets that signal.
  const warn = vi.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);
  // The push. Spied rather than stubbed out wholesale, so what the tests assert
  // on is the exact NotifyInput the production call site builds.
  const push = vi.spyOn(svc['pushes'], 'sendDetached').mockImplementation(() => undefined);
  return { svc, email, rateLimit, redis, warn, push };
}

const complete = {
  libraryName: 'Δημοτική Βιβλιοθήκη Λάρισας',
  libraryType: 'public',
  city: 'Λάρισα',
  country: 'GR',
  contactName: 'Μαρία Παπαδοπούλου',
  contactEmail: 'library@example.gr',
  // An ISO code, not digits. Twenty-five countries share +1, so the dial
  // `<select>` is valued by country: options that do not distinguish the
  // answers cannot give the applicant back the one they picked when the form
  // comes round again. See `phoneField` in apps/site/src/pages.ts.
  phoneDialCode: 'GR',
  phone: '2410000000',
  consent: 'yes',
};

describe('ApplicationsService.validate', () => {
  let svc: ApplicationsService;
  beforeEach(() => {
    svc = makeService().svc;
  });

  it('accepts a complete application', () => {
    const { errors } = svc.validate(complete, E);
    expect(errors).toEqual({});
  });

  it('requires every field the form marks required', () => {
    const { errors } = svc.validate({ consent: 'yes' }, E);
    expect(Object.keys(errors).sort()).toEqual(
      [
        'city',
        'contactEmail',
        'contactName',
        'country',
        'libraryName',
        'libraryType',
        'phone',
        'phoneDialCode',
      ].sort(),
    );
  });

  /**
   * The country and the phone, which the form now insists on.
   *
   * These are the cases that matter most for a public write. `country` and
   * `phoneDialCode` are `<select>`s on the page and nothing at all on the wire:
   * this is the only unauthenticated write in the control plane, the submitter
   * is assumed not to have used the form, and the canonical list in
   * `@libriant/shared` is the only thing between an arbitrary string and the
   * `applications` table.
   */
  it('asks for a country when none was chosen, and complains only when one was', () => {
    // The country select opens on an empty «Επιλέξτε…» option, so a real
    // visitor can submit nothing: "choose one" and "that is not one of them"
    // are different sentences because they are different mistakes.
    const { country: _dropped, ...noCountry } = complete;
    expect(svc.validate(noCountry, E).errors.country).toBe(E.required.country);
    expect(svc.validate({ ...complete, country: 'XX' }, E).errors.country).toBe(E.badCountry);
  });

  it('refuses a country that is not on the canonical list', () => {
    // XK is the interesting one: ICU knows Kosovo, ISO does not assign the
    // code, and `@libriant/shared` therefore does not offer it. 'Ελλάδα' is the
    // other shape of the same mistake — a NAME where a code belongs.
    for (const bogus of ['XX', 'XK', 'gr', 'GRC', 'Ελλάδα', '../../etc/passwd']) {
      const { errors } = svc.validate({ ...complete, country: bogus }, E);
      expect(errors.country, JSON.stringify(bogus)).toBe(E.badCountry);
    }
  });

  it('accepts a country that is, including ones nobody expected to see here', () => {
    for (const code of ['GR', 'CY', 'DE', 'TR', 'NZ', 'AX']) {
      const { errors } = svc.validate({ ...complete, country: code }, E);
      expect(errors.country, code).toBeUndefined();
    }
  });

  it('refuses a dial code that is not a country, the bare digits included', () => {
    // '30' is what a hand-written submission — or a renderer that forgot — would
    // guess, and it is exactly what this select does not carry.
    for (const bogus of ['30', '+30', '999', 'XX', 'gr', '../../etc/passwd']) {
      const { errors } = svc.validate({ ...complete, phoneDialCode: bogus }, E);
      expect(errors.phoneDialCode, JSON.stringify(bogus)).toBe(E.badDialCode);
    }
  });

  it('refuses an empty dial code outright, since the select cannot produce one', () => {
    // No `required` entry to fall through to, deliberately: the select carries
    // no empty option and a native select cannot be cleared, so a blank one did
    // not come from this form.
    const { phoneDialCode: _dropped, ...noDial } = complete;
    expect(svc.validate(noDial, E).errors.phoneDialCode).toBe(E.badDialCode);
  });

  it('requires a phone number, now that the campaign has to be able to ring back', () => {
    expect(svc.validate({ ...complete, phone: '  ' }, E).errors.phone).toBe(E.required.phone);
  });

  it('does not require the dial code to match the country', () => {
    // Two `<select>`s with no JavaScript between them: a Greek library whose
    // contact carries a Cypriot mobile must not be told that pair is an error.
    const { errors } = svc.validate({ ...complete, country: 'GR', phoneDialCode: 'CY' }, E);
    expect(errors).toEqual({});
  });

  it('keeps both halves of the phone separate, so a failed form comes back filled in', () => {
    const { values } = svc.validate({ ...complete, city: '', phoneDialCode: 'CA' }, E);
    // 'CA', not '1'. Twenty-five countries dial +1 and the select has to
    // re-open on the one the applicant actually picked.
    expect(values.phoneDialCode).toBe('CA');
    expect(values.phone).toBe('2410000000');
    expect(values.country).toBe('GR');
  });

  it('treats consent as given ONLY for the literal "yes"', () => {
    for (const v of ['true', '1', 'on', 'YES', ' yes ']) {
      const { values, errors } = svc.validate({ ...complete, consent: v }, E);
      // ' yes ' trims to 'yes' and is legitimately accepted; the rest are not.
      if (v.trim() === 'yes') {
        expect(values.consent, v).toBe('yes');
        expect(errors.consent, v).toBeUndefined();
      } else {
        expect(values.consent, v).toBeUndefined();
        expect(errors.consent, v).toBe(E.consent);
      }
    }
  });

  it('rejects a libraryType outside the enum', () => {
    const { errors } = svc.validate({ ...complete, libraryType: 'archive' }, E);
    expect(errors.libraryType).toBe(E.badType);
  });

  it('accepts every value the form actually offers', () => {
    for (const t of ['public', 'academic', 'school', 'special', 'community', 'other']) {
      const { errors } = svc.validate({ ...complete, libraryType: t }, E);
      expect(errors.libraryType, t).toBeUndefined();
    }
  });

  it('rejects an address with no dot in the domain, accepts a normal one', () => {
    expect(
      svc.validate({ ...complete, contactEmail: 'nope@localhost' }, E).errors.contactEmail,
    ).toBe(E.badEmail);
    expect(
      svc.validate({ ...complete, contactEmail: 'a.b+tag@sub.example.co.uk' }, E).errors
        .contactEmail,
    ).toBeUndefined();
  });

  it('does not report "too long" on a field that is already missing', () => {
    const { errors } = svc.validate({ consent: 'yes' }, E);
    expect(errors.libraryName).toBe(E.required.libraryName);
  });

  it('enforces the per-field length caps', () => {
    const { errors } = svc.validate({ ...complete, message: 'x'.repeat(4001) }, E);
    expect(errors.message).toBe(E.tooLong(4000));
  });

  it('echoes back only what the field can hold, so an oversized body cannot inflate the page', () => {
    // 100KB in — body-parser's default, and the biggest thing that can reach
    // here — must not become a 100KB value re-rendered into the response on a
    // path the throttle deliberately does not meter.
    const { values, errors } = svc.validate({ ...complete, message: 'x'.repeat(100_000) }, E);
    expect(errors.message).toBe(E.tooLong(4000));
    expect(values.message).toHaveLength(4000);
  });

  it('never truncates a list-checked field into a valid one', () => {
    // 'GRC' capped to 2 would be 'GR' — a real country, which would flip the
    // message from "choose one of the available countries" to "too long" and
    // echo the form back with Greece selected by nobody.
    const { values, errors } = svc.validate({ ...complete, country: 'GRC' }, E);
    expect(errors.country).toBe(E.badCountry);
    expect(values.country).toBe('GRC');
  });

  it('trims values, so whitespace alone is not an answer', () => {
    const { values, errors } = svc.validate({ ...complete, city: '   ' }, E);
    expect(values.city).toBe('');
    expect(errors.city).toBe(E.required.city);
  });

  it('ignores unknown fields rather than rejecting them — the honeypot is one', () => {
    // validateDto would 400 here because of forbidNonWhitelisted, which is
    // exactly why this does not use it.
    const { errors } = svc.validate({ ...complete, website: 'http://spam.example' }, E);
    expect(errors).toEqual({});
  });

  // The half of the requiredness contract a type cannot reach.
  //
  // `RequiredField` (apps/site/src/copy.ts) makes el and en agree at compile
  // time, but it lives in a different package from `MAX_LEN`, which is what
  // decides that a field is read off the submission at all. A name required
  // there and absent here is never populated, so `!values[key]` is always true:
  // the error is set on every submission, renders against no control because no
  // input carries that name, and the only unauthenticated write in the product
  // becomes permanently unsubmittable behind "check the fields marked below"
  // with nothing marked. Both languages, because both are served.
  it.each(['el', 'en'] as const)(
    'collects every field %s declares required, so none can be unsatisfiable',
    (lang) => {
      const messages = ERRORS[lang];
      const { errors } = svc.validate({ ...complete }, messages);
      // `complete` answers every required field. Anything still failing is a
      // key the service never reads.
      expect(errors).toEqual({});
      // And the two languages require the same set, which is what makes
      // /en/apply as strict as /apply.
      expect(Object.keys(messages.required).sort()).toEqual(Object.keys(ERRORS.el.required).sort());
    },
  );
});

/**
 * The commit point, and the one decision here that is about shape rather than
 * validity: the two halves of the phone are joined on the way in.
 */
describe('ApplicationsService.save', () => {
  beforeEach(() => {
    applicationCreate.mockReset();
    applicationCreate.mockResolvedValue({ id: 'app-1' });
  });

  it('round-trips a complete application into the row the admin panel reads', async () => {
    const { svc } = makeService();
    const parsed = svc.validate(complete, E);
    expect(parsed.errors).toEqual({});

    await expect(svc.save(parsed, '2026-08-01')).resolves.toBe('app-1');

    const data = applicationCreate.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.country).toBe('GR');
    // One column, dialable. The panel renders this straight into
    // `<a href="tel:…">`, so a bare '2410000000' here is a lead nobody outside
    // Greece can ring.
    expect(data.phone).toBe('+30 2410000000');
    expect(data.contactEmail).toBe('library@example.gr');
    expect(data.consent).toBe(true);
    expect(data.privacyVersion).toBe('2026-08-01');
  });

  it('stores the code and never the label — CLDR renames the labels', async () => {
    const { svc } = makeService();
    await svc.save(svc.validate({ ...complete, country: 'TR' }, E), '2026-08-01');
    const data = applicationCreate.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.country).toBe('TR');
  });
});

describe('dialablePhone', () => {
  it('turns the chosen country into its digits and puts them in front', () => {
    expect(dialablePhone({ phoneDialCode: 'GR', phone: '2410000000' })).toBe('+30 2410000000');
    // Two different answers that dial the same code — the whole reason the
    // select carries countries rather than digits.
    expect(dialablePhone({ phoneDialCode: 'CA', phone: '4165550000' })).toBe('+1 4165550000');
    expect(dialablePhone({ phoneDialCode: 'US', phone: '4165550000' })).toBe('+1 4165550000');
  });

  it('leaves the national part alone, punctuation and all', () => {
    // Tidying it would turn an extension into four more digits of phone number,
    // and dropping a leading trunk zero is right for the UK and wrong for
    // Italy. Neither is ours to decide about someone else's number.
    expect(dialablePhone({ phoneDialCode: 'GR', phone: '2410 000 000 (εσωτ. 12)' })).toBe(
      '+30 2410 000 000 (εσωτ. 12)',
    );
    expect(dialablePhone({ phoneDialCode: 'IT', phone: '06 1234567' })).toBe('+39 06 1234567');
  });

  it('does not prefix a number the applicant already wrote in full', () => {
    // The hint asks for the code in the select, and people type it anyway.
    // '+30 +357 99123456' is not a number anyone can ring — and typing the
    // code is also the only way to give a number whose country is not the one
    // the select happens to be showing.
    expect(dialablePhone({ phoneDialCode: 'GR', phone: '+357 99123456' })).toBe('+357 99123456');
    expect(dialablePhone({ phoneDialCode: 'GR', phone: '+30 2410000000' })).toBe('+30 2410000000');
    // Still trimmed, so a stray leading space does not defeat the check.
    expect(dialablePhone({ phoneDialCode: 'GR', phone: '  +44 20 7123 4567' })).toBe(
      '+44 20 7123 4567',
    );
  });

  it('is empty when there is no number, so nothing stores a bare "+30"', () => {
    expect(dialablePhone({ phoneDialCode: 'GR' })).toBe('');
    expect(dialablePhone({ phoneDialCode: 'GR', phone: '   ' })).toBe('');
  });

  it('falls back to the bare number when the code is missing or unknown', () => {
    // Unreachable through `validate`, which refuses both. A number with no
    // country in front of it still beats no number at all for whoever rings.
    expect(dialablePhone({ phone: '2410000000' })).toBe('2410000000');
    expect(dialablePhone({ phoneDialCode: 'XX', phone: '2410000000' })).toBe('2410000000');
  });
});

describe('ApplicationsService.throttle', () => {
  it('keys on a hash, never on the raw address', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);
    await svc.throttle('203.0.113.7');
    const key = hit.mock.calls[0]?.[0] as string;
    expect(key).toMatch(/^apply:iph:[0-9a-f]{64}$/);
    expect(key).not.toContain('203.0.113.7');
  });

  it('keeps the per-visitor bucket outside every fail-closed prefix', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);
    await svc.throttle('203.0.113.7');
    // A Redis outage must not eat one visitor's lead, so this bucket must not
    // pick up `signup:` or the `apply-all:` prefix the ceiling below uses.
    expect(hit.mock.calls[0]?.[0]).not.toMatch(/^(signup:|apply-all:)/);
  });

  it('gives the same visitor the same bucket and different visitors different ones', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);
    await svc.throttle('203.0.113.7');
    await svc.throttle('203.0.113.7');
    await svc.throttle('203.0.113.8');
    const [a, , b, , c] = hit.mock.calls.map((call) => call[0] as string);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('allows 5 an hour', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);
    await svc.throttle('203.0.113.7');
    expect(hit.mock.calls[0]?.slice(1)).toEqual([5, 3600]);
  });

  it('reports over-budget when the limiter says so', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: false, count: 6, retryAfterSec: 900 });
    const { svc } = makeService(hit);
    await expect(svc.throttle('203.0.113.7')).resolves.toBe('ip');
  });

  /**
   * input-and-files-10. The per-IP bucket is the visitor's own budget and fails
   * open; behind it there has to be something that a rotated X-Real-IP cannot
   * step around and a Redis outage cannot remove. The auditor executed the
   * first half — eight submissions with rotating headers, all persisted.
   */
  it('also spends a platform-wide hourly ceiling that no address can dodge', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);

    await svc.throttle('203.0.113.7');
    await svc.throttle('198.51.100.9');

    const shared = hit.mock.calls.filter((call) => (call[0] as string).startsWith('apply-all:'));
    expect(shared).toHaveLength(2);
    // Same key from two different addresses, or it is not a ceiling.
    expect(shared[0]?.[0]).toBe(shared[1]?.[0]);
    expect(shared[0]?.slice(1)).toEqual([60, 3600]);
  });

  it('uses the prefix that makes that ceiling fail CLOSED on a Redis error', async () => {
    // The prefix is the whole mechanism: RateLimitService decides deny-vs-allow
    // from the key. Get it wrong and the ceiling evaporates in the outage it
    // exists for, which is exactly how the per-IP bucket behaves today.
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);
    await svc.throttle('203.0.113.7');
    expect(hit.mock.calls[1]?.[0]).toMatch(/^apply-all:/);
  });

  it('reports "global" when the ceiling refuses, so the visitor is not blamed', async () => {
    const hit = vi
      .fn()
      .mockResolvedValueOnce({ allowed: true, count: 1, retryAfterSec: 0 })
      .mockResolvedValueOnce({ allowed: false, count: 61, retryAfterSec: 3600 });
    const { svc } = makeService(hit);
    await expect(svc.throttle('203.0.113.7')).resolves.toBe('global');
  });

  /**
   * The other half of input-and-files-10, and the reason the fail-closed prefix
   * is not the whole answer.
   *
   * `RateLimitService.hit` cannot tell these two apart — a genuine 61st
   * submission and a dead socket both return `{ allowed: false, count: 61 }` —
   * so a Redis blip refused every application on the one unauthenticated write
   * in the product, during a campaign whose entire purpose is capturing five
   * leads. The verdict below is what a librarian's application depends on.
   */
  /**
   * What `RateLimitService` returns for both buckets when Redis is gone: the
   * per-visitor bucket fails open (`allowed`, nothing counted), the `apply-all:`
   * ceiling fails closed. Keyed by bucket rather than by call order, because
   * every test below makes more than one submission.
   */
  const outage = () =>
    vi.fn(async (key: string) =>
      key.startsWith('apply-all:')
        ? { allowed: false, count: 61, retryAfterSec: 3600 }
        : { allowed: true, count: 0, retryAfterSec: 0 },
    );

  it('accepts the application when the ceiling was refused by an unreachable Redis', async () => {
    const { svc, warn } = makeService(outage(), 'reconnecting');
    await expect(svc.throttle('203.0.113.7')).resolves.toBe('ok');
    // Accepting quietly would leave an operator with no way to know the shared
    // ceiling is no longer shared.
    expect(warn.mock.calls.map(String).join('\n')).toContain('reconnecting');
  });

  it('still refuses the 61st, so the outage does not remove the ceiling', async () => {
    const { svc } = makeService(outage(), 'end');
    for (let i = 0; i < 60; i++) {
      await expect(svc.throttle(`203.0.113.${i}`), `submission ${i + 1}`).resolves.toBe('ok');
    }
    await expect(svc.throttle('203.0.113.61')).resolves.toBe('global');
  });

  it('keeps refusing a genuine 61st while Redis is healthy enough to have counted it', async () => {
    // Same refusal, reachable socket: this one really is the ceiling, and the
    // in-process counter must not second-guess it.
    const { svc } = makeService(outage(), 'ready');
    await expect(svc.throttle('203.0.113.7')).resolves.toBe('global');
  });

  it('spends the in-process ceiling while Redis is healthy, so an outage inherits it', async () => {
    // A counter that only starts on the first error hands an attacker a fresh
    // 60 slots the moment Redis drops — the whole ceiling back, at the worst
    // possible moment.
    let redisUp = true;
    const hit = vi.fn(async (key: string) =>
      !redisUp && key.startsWith('apply-all:')
        ? { allowed: false, count: 61, retryAfterSec: 3600 }
        : { allowed: true, count: 1, retryAfterSec: 0 },
    );
    const { svc, redis } = makeService(hit, 'ready');
    for (let i = 0; i < 60; i++) {
      await expect(svc.throttle(`198.51.100.${i}`), `healthy submission ${i + 1}`).resolves.toBe(
        'ok',
      );
    }
    redisUp = false;
    redis.client.status = 'end';
    await expect(svc.throttle('198.51.100.200')).resolves.toBe('global');
  });

  it('does not spend the shared ceiling on a visitor already over their own budget', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: false, count: 6, retryAfterSec: 900 });
    const { svc } = makeService(hit);
    await svc.throttle('203.0.113.7');
    expect(hit).toHaveBeenCalledTimes(1);
  });
});

/**
 * launch-readiness-11. The form's gate used to be
 * `config.offer.spotsRemaining <= 0` — a literal compiled into the API, which
 * nothing decremented and which took a commit, a CI run and an on-box deploy
 * to change. These are the cases that matter to a real library: the sixth
 * applicant must not be accepted by a form that should have shut, and the
 * first must not be turned away because a query failed.
 */
describe('ApplicationsService.offerState', () => {
  beforeEach(() => {
    applicationCount.mockReset();
  });

  it('is open while fewer than the advertised places have been given', async () => {
    applicationCount.mockResolvedValue(OFFER_TOTAL - 1);
    const { svc } = makeService();
    await expect(svc.offerState()).resolves.toEqual({
      total: OFFER_TOTAL,
      taken: OFFER_TOTAL - 1,
      open: true,
    });
  });

  it('closes the moment the last place is given, with no deploy', async () => {
    applicationCount.mockResolvedValue(OFFER_TOTAL);
    const { svc } = makeService();
    await expect(svc.offerState()).resolves.toMatchObject({ taken: OFFER_TOTAL, open: false });
  });

  it('counts accepted applications only — a reply is not a promise of a place', async () => {
    applicationCount.mockResolvedValue(0);
    const { svc } = makeService();
    await svc.offerState();
    expect(applicationCount).toHaveBeenCalledWith({ where: { status: 'accepted' } });
  });

  it('FAILS OPEN: a database error must never tell a real library the places are gone', async () => {
    applicationCount.mockRejectedValue(new Error('connection terminated'));
    const { svc } = makeService();
    const error = vi.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
    await expect(svc.offerState()).resolves.toMatchObject({ open: true });
    expect(error).toHaveBeenCalledOnce();
  });
});

/**
 * launch-readiness-03. The enqueue below it is delivered by nobody under
 * EMAIL_DRIVER=console, so this line is one of the two channels that actually
 * reach the operator (the other is the admin panel). It must name the library
 * — and it must NOT name the person: the container log is archived into the
 * nightly backup and reached by no retention sweep.
 */
describe('ApplicationsService.notify', () => {
  it('announces the application on a channel that works with the console driver', async () => {
    const { svc, warn } = makeService();
    await svc.notify('app-123', {
      values: {
        libraryName: 'Δημοτική Βιβλιοθήκη Λάρισας',
        city: 'Λάρισα',
        country: 'GR',
        contactName: 'Μαρία Παπαδοπούλου',
        contactEmail: 'library@example.gr',
        phoneDialCode: 'GR',
        phone: '2410000000',
      },
      errors: {},
    });
    expect(warn).toHaveBeenCalledOnce();
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('NEW APPLICATION');
    expect(line).toContain('Δημοτική Βιβλιοθήκη Λάρισας');
    expect(line).toContain('Λάρισα');
    expect(line).toContain('app-123');
    expect(line).toContain('https://admin.example.test/en/admin/applications');
    expect(line).toContain('EMAIL_DRIVER=console');
    // The applicant is a person. Their name, address and phone stay out of a
    // log nothing ever erases (privacy-legal-04).
    expect(line).not.toContain('Μαρία');
    expect(line).not.toContain('library@example.gr');
    expect(line).not.toContain('2410000000');
  });

  it('gives the operator a country they can read and a number they can dial', async () => {
    const { svc, email } = makeService();
    await svc.notify('app-123', {
      values: {
        libraryName: 'Δημοτική Βιβλιοθήκη Λάρισας',
        city: 'Λάρισα',
        country: 'CY',
        contactName: 'Μαρία Παπαδοπούλου',
        contactEmail: 'library@example.gr',
        phoneDialCode: 'CY',
        phone: '22000000',
      },
      errors: {},
    });
    const body = String(email.enqueue.mock.calls[0]?.[0]?.bodyMarkdown);
    // The message is Greek throughout because the operator is; a bare 'CY' in
    // the middle of it is a code they would have to go and look up.
    expect(body).toContain('Κύπρος');
    expect(body).toContain('+357 22000000');
  });
});

/**
 * launch-readiness-03, the half the admin panel cannot fix: somebody still has
 * to remember to open it. This is what arrives on the operator's phone
 * instead, and the only thing worth asserting about it is what it does NOT
 * carry — the message leaves the country to a server we do not run, is
 * retained there, is cached on a handset, and on a public ntfy topic is read
 * by anyone who guesses the string.
 */
describe('applicationAnnouncement', () => {
  const APPLICANT = {
    libraryName: 'Δημοτική Βιβλιοθήκη Λάρισας',
    city: 'Λάρισα',
    country: 'GR',
    contactName: 'Μαρία Παπαδοπούλου',
    contactEmail: 'library@example.gr',
    phoneDialCode: 'GR',
    phone: '2410000000',
    collectionSize: '12000',
    currentSystem: 'Koha',
    message: 'Θα θέλαμε να μάθουμε περισσότερα.',
  };

  it('names the institution, its town and where to answer it', () => {
    const { title, body } = applicationAnnouncement(APPLICANT, true, 'admin.example.test');

    expect(title).toBe('New library application');
    expect(body).toContain('Δημοτική Βιβλιοθήκη Λάρισας');
    expect(body).toContain('Λάρισα');
    expect(body).toContain('Greece');
    expect(body).toContain('https://admin.example.test/en/admin/applications');
  });

  it('carries no part of the person who filled the form in', () => {
    // The rule `notify()` already applies to a container log, applied to a
    // channel that is worse than a container log in every dimension.
    const { title, body } = applicationAnnouncement(APPLICANT, true, 'admin.example.test');
    const wire = `${title}\n${body}`;

    for (const secret of [
      'Μαρία',
      'Παπαδοπούλου',
      'library@example.gr',
      '2410000000',
      '+30',
      '12000',
      'Koha',
      'Θα θέλαμε',
    ]) {
      expect(wire).not.toContain(secret);
    }
  });

  it('leaves the application id off the lock screen', () => {
    // Not personal data, and it stays in the log line — but it is 36
    // characters of UUID answering "which row?", which the admin panel sorted
    // newest-first answers better than a phone does.
    const { body } = applicationAnnouncement(APPLICANT, true, 'admin.example.test');

    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it('sends the operator to the log and the outbox when the row never committed', () => {
    // There is no panel entry to open, so naming one would send them where the
    // lead is not.
    const { title, body } = applicationAnnouncement(APPLICANT, false, 'admin.example.test');

    expect(title).toContain('NOT saved');
    expect(body).toContain('Δημοτική Βιβλιοθήκη Λάρισας');
    expect(body).toContain('/admin/emails');
    expect(body).not.toContain('/en/admin/applications');
  });

  it('still says something useful when the form came in half-empty', () => {
    const { body } = applicationAnnouncement({ libraryName: '', city: '' }, true, '');

    expect(body).toContain('—');
    expect(body).toContain('the admin panel');
  });

  it('names the country in the same language as the rest of the message', () => {
    // A bare 'CY' on a phone is a code the reader has to go and look up.
    const { body } = applicationAnnouncement(
      { libraryName: 'Δημοτική Βιβλιοθήκη Λεμεσού', city: 'Λεμεσός', country: 'CY' },
      true,
      'admin.example.test',
    );

    expect(body).toContain('Cyprus');
  });
});

/**
 * The push itself: what leaves, when it is suppressed, and what happens to the
 * application when the third party misbehaves.
 */
describe('ApplicationsService.notify — the push', () => {
  const APPLICANT = {
    values: {
      libraryName: 'Δημοτική Βιβλιοθήκη Λάρισας',
      city: 'Λάρισα',
      country: 'GR',
      contactName: 'Μαρία Παπαδοπούλου',
      contactEmail: 'library@example.gr',
      phoneDialCode: 'GR',
      phone: '2410000000',
    },
    errors: {},
  };

  it('rings once for an application that landed, at warn', async () => {
    // warn, not error: the site promises two working days, not two minutes, and
    // level 5 is the only one that can wake somebody at 03:00. An operator woken
    // by a form submission mutes the topic — and the backup and deploy alerts
    // ride on the same topic.
    const { svc, push } = makeService();

    await svc.notify('app-123', APPLICANT);

    expect(push).toHaveBeenCalledOnce();
    expect(push.mock.calls[0]?.[0]).toMatchObject({
      level: 'warn',
      title: 'New library application',
    });
  });

  it('shouts at error when the row never committed', async () => {
    // The controller passes the literal 'unsaved' when `save` threw. That is
    // the single unauthenticated write in the control plane refusing a real
    // library during the campaign — the one state on this path where being
    // woken beats not being woken.
    const { svc, push } = makeService();

    await svc.notify('unsaved', APPLICANT);

    expect(push.mock.calls[0]?.[0]).toMatchObject({ level: 'error' });
    expect(String(push.mock.calls[0]?.[0]?.title)).toContain('NOT saved');
  });

  it('puts no part of the applicant on the phone', async () => {
    const { svc, push } = makeService();

    await svc.notify('app-123', APPLICANT);

    const sent = push.mock.calls[0]?.[0];
    const wire = `${sent?.title}\n${sent?.body}`;
    expect(wire).toContain('Δημοτική Βιβλιοθήκη Λάρισας');
    expect(wire).toContain('Λάρισα');
    for (const person of ['Μαρία', 'library@example.gr', '2410000000', '+30']) {
      expect(wire).not.toContain(person);
    }
  });

  it('stops announcing one at a time once the hourly budget is spent', async () => {
    // Sixty submissions an hour can be ACCEPTED (input-and-files-10). Sixty
    // buzzes is a muted topic, and a muted topic loses the backup alerts too.
    const { svc, push } = makeService();

    for (let i = 0; i < 20; i++) await svc.notify(`app-${i}`, APPLICANT);

    // Six real announcements, then exactly one line saying there are more.
    expect(push).toHaveBeenCalledTimes(7);
    const last = push.mock.calls[6]?.[0];
    expect(String(last?.title)).toContain('More applications');
    expect(String(last?.body)).toContain('being scripted');
  });

  it('says "there are more" once per hour, not once per application', async () => {
    const { svc, push } = makeService();

    for (let i = 0; i < 200; i++) await svc.notify(`app-${i}`, APPLICANT);

    expect(push).toHaveBeenCalledTimes(7);
  });

  it('still commits, still logs and still queues when the push throws', async () => {
    // NotifyService promises never to reject and swallows its own failures —
    // but the call site must not depend on that promise being kept. A notifier
    // that can break the thing it reports on is worse than no notifier.
    const { svc, email, warn, push } = makeService();
    push.mockImplementation(() => {
      throw new Error('ntfy.sh unreachable');
    });

    const error = vi.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);

    await expect(svc.notify('app-123', APPLICANT)).resolves.toBeUndefined();
    // The application is still announced in the log, and still queued for the
    // outbox — the two things a throw from the notifier would have skipped.
    expect(warn).toHaveBeenCalledOnce();
    expect(email.enqueue).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]?.[0])).toContain('ntfy.sh unreachable');
  });
});
