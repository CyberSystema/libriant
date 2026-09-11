import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { formatMoney } from '@libriant/shared/money';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';

/**
 * A receipt is rendered ONCE and reprinted verbatim (2.0 phase 18).
 *
 * ## Why the bytes are stored rather than the inputs
 *
 * The obvious design keeps the transaction id and re-renders on demand, and it
 * is wrong for a reason that only shows up months later: re-rendering picks up
 * TODAY's branding, TODAY's locale file, TODAY's address for the branch and
 * TODAY's wording of the refund policy. A reader who brings back a receipt and a
 * librarian who reprints it would then be holding two different documents about
 * one payment, and the library's own copy would be the one that had changed.
 *
 * So `rendered_bytes` is the record. The acceptance criterion — a reprint is
 * byte-identical — is not a property of the renderer being deterministic; it is
 * a property of the renderer being run exactly once. `rendered_sha256` lets a
 * reprint prove it rather than assert it.
 *
 * `receipts` is append-only by trigger, so there is no way to edit one, and
 * `receipts_one_per_transaction` means one payment cannot produce two.
 *
 * ## The number
 *
 * Per branch per year, from `receipt_number_counters`, taken with an UPDATE …
 * RETURNING so two desks printing at the same moment cannot take the same
 * number. A sequence would be simpler and would give the whole library one run
 * of numbers, which is wrong the first time an auditor asks a branch to explain
 * a gap in its book that another branch's printing caused.
 *
 * PLAIN TEXT, not PDF and not ESC/POS. Phase 34 owns the thermal printer and its
 * Greek codepages; what this phase owes is a stable document and the proof that
 * it never changes.
 */
@Injectable()
export class ReceiptsService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Take the next receipt number for a branch and year.
   *
   * `INSERT … ON CONFLICT DO UPDATE … RETURNING` so the row is created and
   * incremented in one statement: a read-then-write would hand two desks the
   * same number on the first print of January.
   */
  async nextNumberWithin(tx: TxV2, branchId: string, at: Date): Promise<string> {
    const year = at.getUTCFullYear();
    const rows = await tx.$queryRaw<{ next_value: bigint }[]>`
      INSERT INTO lbr2.receipt_number_counters (branch_id, year, next_value)
      VALUES (${branchId}, ${year}, 2)
      ON CONFLICT (branch_id, year)
      DO UPDATE SET next_value = lbr2.receipt_number_counters.next_value + 1
      RETURNING (lbr2.receipt_number_counters.next_value - 1)::bigint AS next_value`;
    const taken = rows[0]?.next_value;
    if (taken === undefined) {
      throw new Error(`Could not take a receipt number for ${branchId}/${year}.`);
    }
    return `${year}-${String(taken).padStart(6, '0')}`;
  }

  /**
   * Render the document. PURE — same inputs, same bytes, no clock and no
   * database, so the one thing that decides what a receipt says is what is
   * passed to it.
   */
  render(input: {
    readonly number: string;
    readonly branchName: string;
    readonly libraryName: string;
    readonly locale: string;
    readonly currency: string;
    readonly totalCents: bigint;
    readonly at: Date;
    readonly lines: readonly { readonly label: string; readonly amountCents: bigint }[];
  }): Buffer {
    const money = (cents: bigint): string =>
      formatMoney({ amount: cents, currency: input.currency }, input.locale);
    const out = [
      input.libraryName,
      input.branchName,
      '',
      `#${input.number}`,
      input.at.toISOString(),
      '',
      ...input.lines.map((l) => `${l.label}  ${money(l.amountCents)}`),
      '',
      `TOTAL  ${money(input.totalCents)}`,
      '',
    ];
    return Buffer.from(out.join('\n'), 'utf8');
  }

  /** Store the rendered bytes against a transaction. One per transaction. */
  async storeWithin(
    tx: TxV2,
    input: {
      readonly transactionId: string;
      readonly branchId: string;
      readonly number: string;
      readonly currency: string;
      readonly totalCents: bigint;
      readonly locale: string;
      readonly bytes: Buffer;
      readonly at: Date;
    },
  ): Promise<{ receiptId: string; sha256: string }> {
    const digest = createHash('sha256').update(input.bytes).digest();
    const receipt = await tx.receipt.create({
      data: {
        number: input.number,
        transactionId: input.transactionId,
        branchId: input.branchId,
        currency: input.currency,
        totalCents: input.totalCents,
        contentType: 'text/plain; charset=utf-8',
        locale: input.locale,
        // Prisma's Bytes is Uint8Array<ArrayBuffer>; Node's Buffer is
        // Uint8Array<ArrayBufferLike>, which includes SharedArrayBuffer and is
        // therefore not assignable. Copying at the boundary is one allocation
        // per receipt and keeps the conversion in one place.
        renderedBytes: new Uint8Array(input.bytes),
        renderedSha256: new Uint8Array(digest),
        renderedAt: input.at,
      },
      select: { id: true },
    });
    return { receiptId: receipt.id, sha256: digest.toString('hex') };
  }

  /**
   * Serve a stored receipt. THIS IS THE REPRINT, and it re-renders nothing.
   *
   * The digest is recomputed from the stored bytes and compared with the stored
   * digest, so a reprint that has been tampered with in the database is refused
   * rather than printed. The append-only trigger makes that unreachable through
   * this application, which is exactly why it is worth checking here.
   */
  async reprint(
    tenant: TenantContext,
    receiptId: string,
  ): Promise<{ bytes: Buffer; contentType: string; number: string }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const receipt = await client.receipt.findUnique({
      where: { id: receiptId },
      select: {
        number: true,
        contentType: true,
        renderedBytes: true,
        renderedSha256: true,
      },
    });
    if (receipt === null) throw new NotFoundException(`No receipt ${receiptId}.`);

    const bytes = Buffer.from(receipt.renderedBytes);
    const digest = createHash('sha256').update(bytes).digest();
    if (!digest.equals(Buffer.from(receipt.renderedSha256))) {
      throw new Error(
        `Receipt ${receiptId} does not match its own digest. It has been altered in the ` +
          `database, which the append-only trigger should have made impossible.`,
      );
    }
    return { bytes, contentType: receipt.contentType, number: receipt.number };
  }
}
