import { Controller, Get, UseGuards } from '@nestjs/common';
import { SHIPPED_TEMPLATES } from '@libriant/marc';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';

/**
 * The record a cataloguer starts from (2.0 phase 20l).
 *
 * ## Why this route exists at all
 *
 * `POST /t/:slug/catalog/bib` takes a whole MARC record — `{leader, fields}` —
 * and there is no scalar create route, deliberately: the create DTO's own
 * docblock says the shape is "the same shape `packages/marc` reads and writes,
 * so a record can be posted straight from an import or a Z39.50 response
 * without a translation layer that could lose subfield order".
 *
 * So a create SCREEN has to know what a new book record looks like — which
 * leader, which fields, which indicators. That answer already exists, as data,
 * in `SHIPPED_TEMPLATES`, and it is GATE-CHECKED: `check:marc-schema` runs
 * `checkTemplate` and refuses a template binding any tag the shipped Avram
 * definition does not define. What it must not become is a second answer
 * hand-rolled in the web app, because the byte that decides it is one nobody
 * looks at twice — `marc-from-book.ts` has shipped a leader since phase 19b
 * whose comment names /17 and whose value landed at /18, and every migrated
 * record carries the resulting `position-not-allowed` warning.
 *
 * `@libriant/marc` is not a web dependency and must not become one: the web
 * Dockerfile would need a matching COPY entry (`check:docker-workspace-closure`
 * exists because a missing one builds a green image that cannot boot), and the
 * codec pulls `fast-xml-parser` into a browser bundle that has no use for it.
 * Serving the template is the bridge that costs neither.
 *
 * ## Why it is its own controller and not `catalog/bib/templates`
 *
 * `BibController` mounts `@Get(':id')`, which compiles to `([^/]+)` and
 * swallows any sibling declared after it — the trap `contributors`, `by-barcode`
 * and `shelf` are each ordered around. A separate path cannot be shadowed by
 * declaration order at all, and §3 gives every library its own
 * `catalog_templates` rows in M5, so `catalog/templates` is where those will be
 * served from too. The shipped ones are the fallback that route will keep.
 *
 * ## `cat.bib.read`
 *
 * The same key as the `org/*` pickers and for the same reason: a cataloguer who
 * may read the catalogue may see the shape of a record in it. Writing one still
 * needs `cat.bib.write` at the create route, which is where the decision
 * belongs. Inventing a key for a static list would mean editing all four role
 * templates for a distinction nobody has asked for.
 */
@Controller('t/:slug/catalog/templates')
@UseGuards(TenantGuard, PermissionGuard)
export class CatalogTemplatesController {
  /**
   * Static, and served rather than bundled.
   *
   * No tenant read: these are the templates this BUILD ships, identical for
   * every library, so there is nothing per-tenant to look up yet. The guard
   * still runs — the route is inside the tenant path and a caller must be a
   * member of that library to see it — which is what keeps this route's
   * behaviour unchanged on the day M5 starts returning the tenant's own rows
   * beside these.
   */
  @RequirePermission('cat.bib.read')
  @Get()
  templates() {
    return { items: SHIPPED_TEMPLATES };
  }
}
