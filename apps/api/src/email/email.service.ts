import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { controlDb, type EmailMessageKind, type Prisma } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { RedisService } from '../platform/redis.service.js';
import { OUTBOX_SECRET_TTL_SEC, outboxSecretKey, sealBodySecrets } from './outbox-secrets.js';

/**
 * Producer-side public API. Callers do `EmailService.enqueue({...})`
 * **inside the transaction that produced the trigger** (announcement
 * publish, support key creation, password reset, ...). The row commits
 * with the producer; a BullMQ job is then pushed to Redis on top — the
 * worker reads the row, calls the driver, and updates the row.
 *
 * Idempotency: `idempotencyKey` is unique-indexed. Repeating the same
 * enqueue (e.g. a retried transaction) is a no-op rather than a duplicate
 * send. Callers compose the key from the trigger's identity:
 *
 *   18a: `support.key.generated:<keyId>`
 *   18a: `support.key.redeemed:<sessionId>`
 *   18a: `support.session.ended:<sessionId>`
 *   18b: `announcement:<announcementId>:tenant:<tenantId>`
 *   7  : `auth.password_reset:<userId>:<minute-bucket>`
 *
 * Scheduling: omit `scheduledFor` to send ASAP. Provide it for
 * pre-window 18c "Notify libraries 24h before maintenance" mail or any
 * future "delay" delivery.
 *
 * Secrets: `bodyMarkdown` is SEALED on the way in — any bearer-credential
 * query parameter (`?token=`, `?code=`, …) is replaced by a placeholder and
 * the value is parked in Redis with a TTL, so the column that ends up in
 * `pg_dumpall` carries no redeemable credential (privacy-legal-06). The
 * worker re-hydrates immediately before the driver call, so producers pass
 * the real link and recipients receive the real link — nothing about the
 * producer contract changes. See `outbox-secrets.ts`.
 */

export const EMAIL_QUEUE_NAME = 'email-outbox';
export const EMAIL_JOB_NAME = 'send';

export type EnqueueInput = {
  kind: EmailMessageKind;
  toEmail: string;
  subject: string;
  bodyMarkdown: string;
  idempotencyKey?: string;
  tenantId?: string;
  fromEmail?: string;
  replyToEmail?: string;
  scheduledFor?: Date;
  metadata?: Record<string, unknown>;
  /**
   * Override the default per-job retry budget. Set to 0 for fire-and-
   * forget "we tried our best" messages where a transient failure
   * shouldn't keep retrying for hours.
   */
  maxAttempts?: number;
};

export type EnqueueResult = {
  outboxId: string;
  alreadyExisted: boolean;
};

@Injectable()
export class EmailService implements OnModuleDestroy {
  private readonly logger = new Logger(EmailService.name);
  private readonly queue: Queue;
  private readonly defaultMaxAttempts: number;

  constructor(@Inject(RedisService) private readonly redis: RedisService) {
    const env = loadEnv();
    this.defaultMaxAttempts = env.emailMaxAttempts;
    this.queue = new Queue(EMAIL_QUEUE_NAME, {
      // BullMQ doesn't tolerate ioredis' `keyPrefix` (set on the shared
      // RedisService). Open a fresh connection that BullMQ owns. We pay
      // an extra ~50 KB and one TCP socket for the producer; in return
      // the LUA scripts BullMQ uploads can address their own keys
      // without our app-level prefix collision-stealing them.
      connection: {
        host: this.redis.client.options.host,
        port: this.redis.client.options.port,
        password: this.redis.client.options.password,
        db: this.redis.client.options.db,
      },
      prefix: 'lbr-bull',
      defaultJobOptions: {
        attempts: this.defaultMaxAttempts,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const scheduledFor = input.scheduledFor ?? new Date();
    const maxAttempts = input.maxAttempts ?? this.defaultMaxAttempts;
    const metadata = (input.metadata ?? {}) as Prisma.InputJsonValue;

    // privacy-legal-06: lift bearer credentials out of the body before ANY of
    // it reaches Postgres. This is the single chokepoint every producer already
    // goes through, so a future one inherits the protection without opting in —
    // which is the point: the original defect was per-producer string building
    // (`?token=${token}`) landing in a column nothing ever redacts or purges.
    // See outbox-secrets.ts for why Redis, and not encryption, is the other
    // side of this line.
    const sealed = sealBodySecrets(input.bodyMarkdown);
    if (sealed.ref) {
      // Write the secrets FIRST. If this throws, we never persist a body whose
      // placeholders can't be resolved — the caller sees the failure and (like
      // every producer today) logs it and moves on. The alternative ordering
      // could store an undeliverable body on a crash. An orphaned Redis key
      // from a later failure is harmless: it expires on its own.
      await this.redis.client.set(
        outboxSecretKey(sealed.ref),
        JSON.stringify(sealed.secrets),
        'EX',
        OUTBOX_SECRET_TTL_SEC,
      );
    }

    // Use the unique constraint on idempotencyKey as the dedup lever.
    // We try the cheap insert path first; on conflict we re-fetch the
    // existing row so the caller still gets the outbox id.
    let row;
    let alreadyExisted = false;
    try {
      row = await controlDb.emailOutbox.create({
        data: {
          idempotencyKey: input.idempotencyKey ?? null,
          kind: input.kind,
          toEmail: input.toEmail,
          fromEmail: input.fromEmail ?? null,
          replyToEmail: input.replyToEmail ?? null,
          subject: input.subject,
          bodyMarkdown: sealed.storedBody,
          tenantId: input.tenantId ?? null,
          metadataJson: metadata,
          maxAttempts,
          scheduledFor,
        },
        select: { id: true, scheduledFor: true },
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002' && input.idempotencyKey) {
        alreadyExisted = true;
        row = await controlDb.emailOutbox.findUniqueOrThrow({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true, scheduledFor: true },
        });
      } else {
        throw err;
      }
    }

    if (!alreadyExisted) {
      const delayMs = Math.max(0, row.scheduledFor.getTime() - Date.now());
      await this.queue.add(
        EMAIL_JOB_NAME,
        { outboxId: row.id },
        {
          jobId: row.id, // co-locate the BullMQ job id with the outbox row id
          delay: delayMs,
        },
      );
    }

    this.logger.debug?.(
      `enqueued ${input.kind} → ${input.toEmail} outbox=${row.id} dup=${alreadyExisted}`,
    );
    return { outboxId: row.id, alreadyExisted };
  }

  /** Close the producer queue — Nest calls this on shutdown, and the
   *  DI-free notification cron calls it after a one-off batch enqueue. */
  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
