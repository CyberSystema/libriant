#!/usr/bin/env tsx
// Every tenant-scoped route declares who may call it, or the build fails.
//
// THE FAILURE THIS PREVENTS. A handler with no authorization decorator is not
// a route that nobody can reach — it is a route that EVERY signed-in member of
// the library can reach, including a volunteer. `TenantGuard` proves the caller
// belongs to the tenant and stops there. So the natural consequence of
// forgetting is a silently open route, on a controller that looks exactly like
// its neighbours, and no test fails because no test knows the route was meant
// to be restricted.
//
// authn-authz-06 is this bug, already shipped once: two controllers carried
// `@UseGuards(TenantGuard)` alone, so a volunteer who was refused
// `POST /t/:slug/members` could upload that member's photo.
//
// SO "I FORGOT" AND "EVERYONE MAY" ARE DIFFERENT STATES IN THE SOURCE. A route
// open to all staff says `@PublicWithinTenant()` and means it; anything else
// says `@RequirePermission('some.key')`. Neither is a build failure.
// `PermissionGuard` also refuses at runtime when it finds no metadata, so this
// gate is the first of two lines, not the only one.
//
// It also checks the things a typo makes invisible:
//   - every key names a permission that exists in the catalog (a key that does
//     not can never be granted, so the route is permanently unreachable);
//   - every controller under `t/:slug` actually mounts `PermissionGuard`,
//     because a decorator nothing reads is decoration;
//   - `limitFrom` is only used on a key that takes a ceiling;
//   - no `@Roles`/`@StaffWrite` survives on a tenant controller, since
//     `RolesGuard` no longer runs there and an annotation that decides nothing
//     is worse than none.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPermission, isPermissionKey } from '../packages/shared/src/permissions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'apps', 'api', 'src');

const files: string[] = [];
(function walk(dir: string) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (entry.endsWith('.controller.ts')) files.push(p);
  }
})(SRC);

const problems: string[] = [];
const fail = (m: string) => problems.push(m);

let controllers = 0;
let handlers = 0;
let publicHandlers = 0;

for (const file of files.sort()) {
  const rel = path.relative(path.resolve(HERE, '..'), file);
  const src = readFileSync(file, 'utf8');
  const controllerDecorator = /@Controller\(\s*(?:(['"`])([^'"`]*)\1)?\s*\)/.exec(src);
  if (!controllerDecorator) continue;
  const base = (controllerDecorator[2] ?? '').trim();

  const lines = src.split('\n');
  const ctrlIdx = lines.findIndex((l) => l.includes('@Controller('));
  const classIdx = lines.findIndex((l, i) => i > ctrlIdx && /^export (abstract )?class/.test(l));
  const classBlock = lines.slice(ctrlIdx, classIdx).join('\n');
  const classGuards = /@UseGuards\(([^)]*)\)/.exec(classBlock)?.[1] ?? '';
  const classRequires =
    /@RequirePermission\(/.test(classBlock) || /@PublicWithinTenant\(\)/.test(classBlock);

  let sawTenantRoute = false;

  for (let i = classIdx; i < lines.length; i += 1) {
    const verb = /^\s{2}@(Get|Post|Patch|Put|Delete)\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)/.exec(
      lines[i] as string,
    );
    if (!verb) continue;

    const sub = verb[3] ?? '';
    // The full path decides, not the controller's base. StorageDemoController
    // is `@Controller()` with `@Post('t/:slug/storage/:resourceType')` on each
    // method, so a base-only test missed five routes — one of them a DELETE
    // that only owner and admin could reach. The same controller also serves
    // `/_files/signed`, which is genuinely public and must NOT be required to
    // declare a permission, so the test cannot be per-controller either.
    const full = `${base}${sub ? (base ? '/' : '') + sub : ''}`.replace(/\/+/g, '/');
    if (!full.startsWith('t/:slug')) continue;

    sawTenantRoute = true;
    handlers += 1;

    const window: string[] = [];
    for (
      let j = i - 1;
      j >= 0 && /^\s{2}@|^\s{2}\*|^\s{2}\/\*|^\s{2}\/\/|^\s*$/.test(lines[j] as string);
      j -= 1
    ) {
      window.push(lines[j] as string);
    }
    for (let j = i + 1; j < lines.length && /^\s{2}@/.test(lines[j] as string); j += 1) {
      window.push(lines[j] as string);
    }
    const near = window.join('\n');

    // Guards may sit on the class or on the route. Either mounts the guard.
    const guards = classGuards + ' ' + (/@UseGuards\(([^)]*)\)/.exec(near)?.[1] ?? '');
    if (!/\bPermissionGuard\b/.test(guards)) {
      fail(
        `${rel}:${i + 1}: ${verb[1]!.toUpperCase()} ${full} does not mount PermissionGuard. ` +
          `Its @RequirePermission is read by nothing, so the route is open to all staff.`,
      );
    }

    const isPublic = /@PublicWithinTenant\(\)/.test(near);
    const match = /@RequirePermission\(\s*(['"])([^'"]+)\1\s*(?:,\s*\{([^}]*)\})?\s*\)/.exec(near);
    if (isPublic) publicHandlers += 1;

    if (!isPublic && !match) {
      if (classRequires) continue;
      fail(
        `${rel}:${i + 1}: ${verb[1]!.toUpperCase()} ${full} declares no permission.\n` +
          `      Add @RequirePermission('some.key'), or @PublicWithinTenant() if every staff ` +
          `role may call it. Undecorated is not closed — it is open to all staff.`,
      );
      continue;
    }

    if (match) {
      const key = match[2] as string;
      if (!isPermissionKey(key)) {
        fail(
          `${rel}:${i + 1}: '${key}' is not a key in packages/shared/src/permissions.ts. ` +
            `No role can hold it, so this route is unreachable by everyone.`,
        );
        continue;
      }
      if (/limitFrom/.test(match[3] ?? '') && getPermission(key)?.kind !== 'limit') {
        fail(
          `${rel}:${i + 1}: '${key}' has limitFrom, but it is an 'action' key with no ceiling ` +
            `to compare against. The limit would never be applied.`,
        );
      }
    }
  }

  if (!sawTenantRoute) continue;
  controllers += 1;

  const whole = lines.join('\n');
  for (const stale of ['@Roles(', '@StaffWrite()']) {
    if (whole.includes(stale)) {
      fail(
        `${rel}: still carries ${stale}. RolesGuard no longer runs on tenant controllers, so ` +
          `this decides nothing and reads as though it does.`,
      );
    }
  }
}

if (problems.length) {
  console.error(`✗ permissions: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`    ${p}\n`);
  console.error(
    'A tenant route with no declared permission is reachable by every signed-in member of\n' +
      'the library, including a volunteer. That is authn-authz-06, which this repository has\n' +
      'already shipped once.',
  );
  process.exit(1);
}

console.log(
  `permission check passed: ${controllers} tenant-scoped controller(s), ${handlers} route ` +
    `handler(s), every one declaring a permission from the catalog or @PublicWithinTenant ` +
    `(${publicHandlers} do); every controller mounts PermissionGuard; no @Roles or ` +
    `@StaffWrite survives where RolesGuard no longer runs.`,
);
