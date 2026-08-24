import { describe, expect, it } from 'vitest';
import { createRowStreamer, type SqlClient, type TableShape } from '../export/export-processors.js';

/**
 * privacy-legal-06 — `email_outbox` must not leave the box in a control export.
 *
 * WHAT WAS MEASURED, ON A REAL RUN, TWICE: an owner-admin
 * `POST /admin/exports {"format":"csv","scope":"control"}` produced a zip whose
 * `email_outbox.csv` contained `id,idempotencyKey,kind,toEmail,fromEmail,
 * replyToEmail,subject,bodyMarkdown,…` with ZERO occurrences of `[redacted]`
 * (`users.csv` from the same zip had five). That is 90 days of every
 * transactional message Libriant has composed — patron names, patron e-mail
 * addresses, borrowed book titles, applicant contact details — leaving in a
 * 24-hour unencrypted download that any owner-admin can trigger, and landing in
 * every nightly backup of the file store besides.
 *
 * The redactor could not have caught it: `isSensitive` tests the COLUMN NAME
 * against /token|secret|passwordhash|password_hash/, and `bodymarkdown`,
 * `toemail` and `subject` match none of them. It needed a table entry, which is
 * now in `SENSITIVE_COLUMNS`.
 *
 * THIS SPEC LIVES HERE, NEXT TO THE PRODUCER, ON PURPOSE. The e-mail module is
 * what fills that table; the export module is where the fix physically sits and
 * is edited by people thinking about streaming, not about patrons. It drives
 * the REAL `createRowStreamer` — the function the export worker calls for every
 * table of every run — so deleting the entry fails the build here rather than
 * in a member's inbox.
 */

/** A `pg.Client` stand-in that answers DECLARE/FETCH/CLOSE from one array. */
function fakeClient(rows: Record<string, unknown>[]): SqlClient {
  let cursor: { pos: number } | null = null;
  const empty = { rows: [] as Record<string, unknown>[], fields: [], rowCount: 0 };
  return {
    async query(text: string) {
      if (text.startsWith('DECLARE ')) {
        cursor = { pos: 0 };
        return empty;
      }
      const fetched = /^FETCH FORWARD (\d+) FROM/.exec(text);
      if (fetched) {
        if (!cursor) throw new Error('FETCH without an open cursor');
        const slice = rows.slice(cursor.pos, cursor.pos + Number(fetched[1]));
        cursor.pos += slice.length;
        return { rows: slice, fields: [], rowCount: slice.length };
      }
      if (text.startsWith('CLOSE ')) {
        cursor = null;
        return empty;
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

const OUTBOX_SHAPE: TableShape = {
  name: 'email_outbox',
  columns: [
    'id',
    'idempotencyKey',
    'kind',
    'toEmail',
    'fromEmail',
    'replyToEmail',
    'subject',
    'bodyMarkdown',
    'status',
    'createdAt',
  ],
  numericColumns: new Set<string>(),
};

/** One row shaped exactly like what `member-notifications.job.ts` enqueues. */
function overdueNotice() {
  return {
    id: 'outbox-1',
    // Producers compose this key freely and some of them put an address in it
    // (`lib-req-submit:<requestId>:<adminEmail>`), which is why it is redacted
    // too — an export with the body blanked and the address still in the key
    // is not redacted.
    idempotencyKey: 'lib-req-submit:req-1:admin@example.gr',
    kind: 'member_overdue',
    toEmail: 'maria.papadopoulou@example.gr',
    fromEmail: 'no-reply@libriant.com',
    // The whole-row assertion below could not catch this while the fixture did
    // not set it — and it shipped in the clear on a real control export.
    // applications.service.ts sets replyToEmail to the APPLICANT'S address, so
    // it is recipient data wearing a different column name.
    replyToEmail: 'eleni.applicant@school.gr',
    subject: 'Το βιβλίο σας έχει καθυστερήσει',
    bodyMarkdown: 'Γεια σας Μαρία Παπαδοπούλου, το «Το Κιβώτιο» έληξε στις 2026-08-01.',
    status: 'delivered',
    createdAt: '2026-08-01T09:00:00.000Z',
  };
}

async function streamOne(isControl: boolean) {
  const rows: Record<string, unknown>[] = [];
  const stream = createRowStreamer(fakeClient([overdueNotice()]), { isControl });
  await stream(OUTBOX_SHAPE, async (batch) => {
    rows.push(...batch);
  });
  return rows[0]!;
}

describe('control-plane export redaction of email_outbox', () => {
  it('never ships a recipient address, a subject or a message body', async () => {
    const row = await streamOne(true);

    expect(row.toEmail).toBe('[redacted]');
    expect(row.subject).toBe('[redacted]');
    expect(row.bodyMarkdown).toBe('[redacted]');
    expect(row.idempotencyKey).toBe('[redacted]');
    expect(row.replyToEmail).toBe('[redacted]');
    // The whole serialized row, not just the fields we thought to name: an
    // export that redacts the column and leaks the same address elsewhere in
    // the row is not redacted. This is the assertion that caught
    // `idempotencyKey` on a real export, after the first three were clean.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('maria.papadopoulou@example.gr');
    expect(serialized).not.toContain('admin@example.gr');
    expect(serialized).not.toContain('eleni.applicant@school.gr');
    expect(serialized).not.toContain('Μαρία Παπαδοπούλου');
    expect(serialized).not.toContain('Το Κιβώτιο');
  });

  it('keeps the columns that make the export useful for a restore', async () => {
    const row = await streamOne(true);
    // The SHAPE has to survive — redaction replaces values, it does not drop
    // columns, or a control export stops being restorable.
    expect(Object.keys(row)).toEqual(OUTBOX_SHAPE.columns);
    expect(row.id).toBe('outbox-1');
    expect(row.kind).toBe('member_overdue');
    expect(row.status).toBe('delivered');
    // `fromEmail` is Libriant's own sending address, not a person's.
    expect(row.fromEmail).toBe('no-reply@libriant.com');
  });

  it('leaves a TENANT-database export alone — the redactor is control-only', async () => {
    // Guards against the opposite mistake: blanket-redacting a library's own
    // data out of the export it asked for. `email_outbox` is a control table,
    // but the streamer is shared, and `isControl` is the only thing separating
    // the two runs.
    const row = await streamOne(false);
    expect(row.toEmail).toBe('maria.papadopoulou@example.gr');
    expect(row.bodyMarkdown).toContain('Το Κιβώτιο');
  });
});
