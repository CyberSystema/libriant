import { describe, expect, it } from 'vitest';
import { redactSecrets } from './export-processors.js';

describe('redactSecrets (A14-04)', () => {
  it('redacts a simple password', () => {
    expect(redactSecrets('postgres://user:pass@host:5432/db')).toBe(
      'postgres://user:***@host:5432/db',
    );
  });

  it('redacts a password that itself contains "@" (the A14-04 leak)', () => {
    // The old `[^@/\s]+@` stopped at the first '@', leaking "ss@host".
    expect(redactSecrets('postgres://user:p@ss@host:5432/db')).toBe(
      'postgres://user:***@host:5432/db',
    );
    expect(redactSecrets('postgresql://u:a@b@c@dbhost/x')).toBe('postgresql://u:***@dbhost/x');
  });

  it('handles the pg_dump error-message form', () => {
    const msg =
      'pg_dump: error: connection to server failed: postgres://super:S3cr@t!@10.0.0.5:5432/control';
    expect(redactSecrets(msg)).not.toContain('S3cr');
    expect(redactSecrets(msg)).toContain('postgres://super:***@10.0.0.5:5432/control');
  });

  it('leaves a credential-less URL untouched', () => {
    expect(redactSecrets('postgres://host/db')).toBe('postgres://host/db');
    expect(redactSecrets('no connection string here')).toBe('no connection string here');
  });
});
