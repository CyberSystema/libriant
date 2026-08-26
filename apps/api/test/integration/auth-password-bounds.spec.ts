import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Both routes here are unauthenticated account paths that run before any plan is known.',
);

/**
 * input-and-files-11, driven through the real HTTP surface.
 *
 * The audit set a 300-character password at signup (201, account created) and
 * was then refused at login by `LoginDto`'s `@Length(1, 200)` — self-locked out
 * of a library one request old. The set paths are bounded now, at the only
 * number bcrypt makes meaningful: 72 UTF-8 bytes (password-bounds.ts).
 *
 * The probes below stop at validation on purpose. Nothing is provisioned, no
 * tenant database is created, and every case is distinguished by WHICH refusal
 * comes back — a bounded password 400s, an unbounded one used to sail past the
 * DTO and be refused later (or not at all) for an unrelated reason.
 */
let app: NestExpressApplication;

const TOO_LONG_MESSAGE = 'at most 72 characters';
/** 40 Greek letters: 40 characters, 80 UTF-8 bytes. `@MaxLength(72)` would pass it. */
const GREEK_OVER_BUDGET = 'κωδικόςπρόσβασηςβιβλιοθήκηςκαλαμάταςαβγδ';

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await listenOnce(app);
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
});

function messagesOf(res: request.Response): string[] {
  const m = (res.body as { message?: unknown }).message;
  return Array.isArray(m) ? (m as string[]) : [String(m)];
}

describe('a password the platform cannot keep is refused where it is SET', () => {
  it('refuses it at signup', async () => {
    // The email is invalid too, so this request 400s either way: the test is
    // about whether the password is one of the reasons. Without the bound the
    // only complaint is about the email, and a valid-looking body with the same
    // 300-character password would have created the library.
    const res = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email: 'not-an-email', password: 'x'.repeat(300) })
      .expect(400);
    expect(messagesOf(res).join(' | ')).toContain(TOO_LONG_MESSAGE);
  });

  it('refuses it at password reset — before it even looks the token up', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({ token: 'no-such-token', newPassword: 'x'.repeat(300) })
      .expect(400);
    expect(messagesOf(res).join(' | ')).toContain(TOO_LONG_MESSAGE);
  });

  it('counts BYTES, so 40 Greek letters are over budget where 40 Latin ones are not', async () => {
    expect(GREEK_OVER_BUDGET).toHaveLength(40);
    expect(Buffer.byteLength(GREEK_OVER_BUDGET, 'utf8')).toBe(80);
    const greek = await request(app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({ token: 'no-such-token', newPassword: GREEK_OVER_BUDGET })
      .expect(400);
    expect(messagesOf(greek).join(' | ')).toContain(TOO_LONG_MESSAGE);

    // The control. A password inside the budget is not this rule's business:
    // it reaches the token lookup and fails there, which is a 404.
    await request(app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({ token: 'no-such-token', newPassword: 'x'.repeat(40) })
      .expect(404);
  });
});
