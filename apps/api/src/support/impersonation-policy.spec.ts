import { describe, expect, it } from 'vitest';
import {
  DENY_RULES,
  classifyImpersonatedRequest,
  summarizeBodyKeys,
} from './impersonation-policy.js';

/**
 * Unit coverage for the pure half of authn-authz-05. The wiring — that this
 * verdict actually stops a request and lands in both audit logs — is proved
 * over real HTTP in `test/integration/support-impersonation.spec.ts`; asserting
 * it here would only prove the function returns what it returns.
 */

function classify(method: string, path: string, params?: Record<string, unknown>) {
  return classifyImpersonatedRequest({ method, path, params });
}

describe('classifyImpersonatedRequest — credential minting', () => {
  it('refuses the reset-password route that disclosed a plaintext password', () => {
    const v = classify('POST', '/t/acme/staff/usr_123/reset-password', {
      slug: 'acme',
      id: 'usr_123',
    });
    expect(v.allowed).toBe(false);
    expect(v.rule).toBe('staff-write');
    // The library's log has to name the account, or it cannot tell which
    // credential left the building.
    expect(v.targetType).toBe('staff');
    expect(v.targetId).toBe('usr_123');
    expect(v.action).toBe('support.blocked');
  });

  it('refuses staff creation and role changes under the same prefix rule', () => {
    expect(classify('POST', '/t/acme/staff', { slug: 'acme' }).rule).toBe('staff-write');
    expect(classify('PATCH', '/t/acme/staff/u1/role', { slug: 'acme', id: 'u1' }).rule).toBe(
      'staff-write',
    );
    expect(classify('POST', '/t/acme/staff/u1/deactivate', { slug: 'acme', id: 'u1' }).rule).toBe(
      'staff-write',
    );
  });

  it('still lets support READ the staff list — the window is for looking', () => {
    const v = classify('GET', '/t/acme/staff', { slug: 'acme' });
    expect(v.allowed).toBe(true);
    expect(v.action).toBe('support.read');
  });
});

describe('classifyImpersonatedRequest — the library keeps its own controls', () => {
  it('refuses deleting the pending support key', () => {
    const v = classify('DELETE', '/t/acme/support/keys/pending', { slug: 'acme' });
    expect(v.allowed).toBe(false);
    expect(v.rule).toBe('support-write');
    expect(v.targetType).toBe('support/keys');
    expect(v.targetId).toBeNull();
  });

  it('refuses issuing a fresh key and ending the session from inside the window', () => {
    expect(classify('POST', '/t/acme/support/keys', { slug: 'acme' }).allowed).toBe(false);
    expect(classify('DELETE', '/t/acme/support/sessions/active', { slug: 'acme' }).allowed).toBe(
      false,
    );
  });

  it('allows reading the support log', () => {
    expect(classify('GET', '/t/acme/support/sessions/log', { slug: 'acme' }).allowed).toBe(true);
  });

  it('refuses billing writes and export creation, allowing their reads', () => {
    expect(classify('POST', '/t/acme/billing/checkout', { slug: 'acme' }).rule).toBe(
      'billing-write',
    );
    expect(classify('POST', '/t/acme/exports', { slug: 'acme' }).rule).toBe('export-write');
    expect(classify('GET', '/t/acme/billing', { slug: 'acme' }).allowed).toBe(true);
  });
});

describe('classifyImpersonatedRequest — routine support work is untouched', () => {
  it('allows the writes support exists to perform', () => {
    const v = classify('POST', '/t/acme/catalog/authors', { slug: 'acme' });
    expect(v.allowed).toBe(true);
    expect(v.action).toBe('support.action');
    expect(v.targetType).toBe('catalog/authors');
  });

  it('allows member edits and records the member id as the target', () => {
    const v = classify('PATCH', '/t/acme/members/mem_9', { slug: 'acme', id: 'mem_9' });
    expect(v.allowed).toBe(true);
    expect(v.targetType).toBe('members');
    expect(v.targetId).toBe('mem_9');
  });
});

describe('classifyImpersonatedRequest — ways a prefix fence gets bypassed', () => {
  it('is not fooled by casing, because Express route matching is case-insensitive', () => {
    // `/T/acme/STAFF/u1/reset-password` reaches the same handler as the
    // lowercase URL, so a case-sensitive fence would be one shift key wide.
    const v = classify('POST', '/T/acme/STAFF/u1/reset-password', { slug: 'acme', id: 'u1' });
    expect(v.allowed).toBe(false);
    expect(v.rule).toBe('staff-write');
  });

  it('is not fooled by doubled slashes', () => {
    expect(classify('POST', '/t/acme//staff//u1/reset-password', { id: 'u1' }).allowed).toBe(false);
  });

  it('matches whole segments only — a route named "staffroom" is not "staff"', () => {
    expect(classify('POST', '/t/acme/staffroom', { slug: 'acme' }).allowed).toBe(true);
  });

  it('applies the same rules when the tenant came from the Host header', () => {
    // Subdomain resolution leaves no `/t/<slug>` prefix to strip.
    const v = classifyImpersonatedRequest({
      method: 'POST',
      path: '/staff/u1/reset-password',
      params: { id: 'u1' },
    });
    expect(v.allowed).toBe(false);
    expect(v.rule).toBe('staff-write');
  });

  it('honours a non-default TENANT_PATH_PREFIX', () => {
    const v = classifyImpersonatedRequest({
      method: 'DELETE',
      path: '/lib/acme/support/keys/pending',
      tenantPathPrefix: '/lib/',
    });
    expect(v.allowed).toBe(false);
    expect(v.rule).toBe('support-write');
  });

  it('never puts an id into targetType, which is meant to be groupable', () => {
    const v = classify('GET', '/t/acme/members/mem_9/photo', { slug: 'acme', id: 'mem_9' });
    expect(v.targetType).toBe('members');
  });

  it('every rule carries a reason the admin can act on', () => {
    for (const rule of DENY_RULES) {
      expect(rule.message.length).toBeGreaterThan(40);
    }
  });
});

describe('summarizeBodyKeys', () => {
  it('returns field names and never values', () => {
    const keys = summarizeBodyKeys({ password: 'hunter2', role: 'admin' });
    expect(keys).toEqual(['password', 'role']);
    expect(JSON.stringify(keys)).not.toContain('hunter2');
  });

  it('returns null for empty, non-object and array bodies', () => {
    expect(summarizeBodyKeys({})).toBeNull();
    expect(summarizeBodyKeys(undefined)).toBeNull();
    expect(summarizeBodyKeys('raw')).toBeNull();
    expect(summarizeBodyKeys([{ a: 1 }])).toBeNull();
  });

  it('caps a hostile body at 20 keys', () => {
    const body = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
    expect(summarizeBodyKeys(body)).toHaveLength(20);
  });
});
