/**
 * Invariants of the permission catalog.
 *
 * These run in the fast lane, with no database and no Nest app, because they
 * are properties of the DATA — and the data is what a library's
 * `role_permissions` rows are written from. The route-by-route proof that this
 * model reproduces the old role check lives in
 * `apps/api/test/integration/authorization-matrix.spec.ts`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIMIT_PERMISSION_KEYS,
  PERMISSIONS,
  PERMISSION_KEYS,
  PERMISSION_MODULES,
  ROLE_TEMPLATES,
  SUPPORT_DENIED_KEYS,
  getPermission,
  isPermissionKey,
} from './permissions.js';

test('every key is unique, well-formed, and in a declared module', () => {
  assert.equal(new Set(PERMISSION_KEYS).size, PERMISSION_KEYS.length, 'duplicate key');
  for (const p of PERMISSIONS) {
    // `module.object.action`, lowercase, underscores inside a segment only.
    assert.match(p.key, /^[a-z]+(\.[a-z][a-z0-9_]*)+$/, p.key);
    assert.equal(p.key.split('.')[0], p.module, `${p.key} is filed under ${p.module}`);
    assert.ok(p.module in PERMISSION_MODULES, `${p.module} is not a declared module`);
    assert.ok(p.label.length > 0, `${p.key} has no label`);
  }
});

test('a key is granted by at least one template, or it is unreachable', () => {
  // A key nothing grants protects a route nobody can call. That is not a
  // policy, it is a dead route, and it looks exactly like a permissions bug.
  for (const key of PERMISSION_KEYS) {
    const granted = Object.values(ROLE_TEMPLATES).some((t) => t.permissions.includes(key));
    assert.ok(granted, `no role holds ${key}, so the route it protects is unreachable`);
  }
});

test('every template grants only keys that exist', () => {
  for (const [name, t] of Object.entries(ROLE_TEMPLATES)) {
    for (const key of t.permissions) {
      assert.ok(isPermissionKey(key), `${name} grants ${key}, which is not in the catalog`);
    }
    assert.equal(new Set(t.permissions).size, t.permissions.length, `${name} has duplicates`);
  }
});

test('the four shipped roles are strictly nested', () => {
  // owner ⊇ admin ⊇ librarian ⊇ volunteer. Not a stylistic preference: the
  // staff UI presents them as a ladder and a library reasons about them that
  // way, so a key that librarian holds and admin does not would be a role
  // hierarchy that lies.
  const chain = ['volunteer', 'librarian', 'admin', 'owner'] as const;
  for (let i = 1; i < chain.length; i += 1) {
    const lower = new Set(ROLE_TEMPLATES[chain[i - 1]!].permissions);
    const upper = new Set(ROLE_TEMPLATES[chain[i]!].permissions);
    const missing = [...lower].filter((k) => !upper.has(k));
    assert.deepEqual(missing, [], `${chain[i]} is missing keys that ${chain[i - 1]} holds`);
    assert.ok(
      upper.size > lower.size,
      `${chain[i]} adds nothing over ${chain[i - 1]}, so one of them is redundant`,
    );
  }
  assert.equal(ROLE_TEMPLATES.owner.permissions.length, PERMISSION_KEYS.length, 'owner holds all');
});

test('owner is the only role that may accept the legal agreements', () => {
  // It binds the library. Every other role must not hold it, including support.
  for (const [name, t] of Object.entries(ROLE_TEMPLATES)) {
    assert.equal(
      t.permissions.includes('admin.legal.accept'),
      name === 'owner',
      `${name} and admin.legal.accept`,
    );
  }
});

test('support is exactly admin minus the four denied keys', () => {
  const admin = new Set(ROLE_TEMPLATES.admin.permissions);
  const support = new Set(ROLE_TEMPLATES.support.permissions);
  assert.deepEqual(
    [...admin].filter((k) => !support.has(k)).sort(),
    [...SUPPORT_DENIED_KEYS].sort(),
  );
  assert.deepEqual(
    [...support].filter((k) => !admin.has(k)),
    [],
    'support must never hold a key an administrator does not',
  );
  for (const key of SUPPORT_DENIED_KEYS) {
    assert.ok(isPermissionKey(key), `${key} is denied to support but is not a real key`);
  }
});

test('only the two fee keys carry a ceiling', () => {
  // A limit is meaningless on a key with no amount, and `check:permissions`
  // refuses `limitFrom` on an action key — so this is the other half of that.
  assert.deepEqual([...LIMIT_PERMISSION_KEYS].sort(), ['circ.fee.void', 'circ.fee.waive']);
  for (const p of PERMISSIONS) {
    assert.ok(p.kind === 'action' || p.kind === 'limit', p.key);
  }
});

test('the accessors refuse junk', () => {
  for (const junk of ['', 'cat', 'CAT.BIB.READ', 'cat.bib.read ', null, 42, undefined]) {
    assert.equal(isPermissionKey(junk), false, JSON.stringify(junk));
  }
  assert.equal(isPermissionKey('cat.bib.read'), true);
  assert.equal(getPermission('cat.bib.read')?.module, 'cat');
  assert.equal(getPermission('nope.nope'), undefined);
});
