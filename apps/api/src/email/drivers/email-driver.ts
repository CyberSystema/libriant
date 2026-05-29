/**
 * Driver interface every email backend implements.
 *
 *   ConsoleEmailDriver — logs the rendered envelope. Dev default; lets
 *                        the rest of the pipeline (outbox, queue, retry,
 *                        stats) run without network.
 *   SmtpEmailDriver    — nodemailer + `SMTP_URL`. Production path.
 *
 * Adding a Postmark / SES / Resend driver later is a single new class
 * implementing this interface plus a switch arm in `EmailModule`.
 */
export type SendInput = {
  to: string;
  from: string;
  replyTo: string | null;
  subject: string;
  bodyMarkdown: string;
};

export type SendResult = {
  /** Provider-assigned identifier we can look up later (Message-ID, etc.). */
  providerId: string | null;
};

export interface EmailDriver {
  readonly name: 'console' | 'smtp';
  send(input: SendInput): Promise<SendResult>;
}
