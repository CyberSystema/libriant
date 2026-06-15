import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { CopiesController } from './copies.controller.js';
import { MembersController } from '../members/members.controller.js';

/**
 * The scan lookups (`GET .../copies/lookup`, `GET .../members/lookup`) live in
 * controllers that also expose `:copyId` / `:id` param routes. Express matches
 * routes in registration order, and Nest registers them in method-declaration
 * order — so the literal `lookup` segment MUST be declared before the param
 * route or it gets swallowed (the param captures "lookup" as an id → 404/wrong
 * handler). This pins that ordering so a future reorder can't silently break
 * scan-to-checkout / scan-to-return.
 */
type RouteInfo = { name: string; path: string; method: number; index: number };

function getRoutes(ctor: new (...args: never[]) => object): RouteInfo[] {
  const proto = ctor.prototype as Record<string, unknown>;
  const names = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
  const routes: RouteInfo[] = [];
  names.forEach((name, index) => {
    const handler = proto[name];
    const path = Reflect.getMetadata('path', handler as object) as string | undefined;
    const method = Reflect.getMetadata('method', handler as object) as number | undefined;
    if (path !== undefined && method !== undefined) routes.push({ name, path, method, index });
  });
  return routes;
}

describe('scan lookup route registration', () => {
  it('CopiesController GET copies/lookup is registered and before any copies/:copyId GET', () => {
    const routes = getRoutes(CopiesController);
    const lookup = routes.find((r) => r.method === RequestMethod.GET && r.path === 'copies/lookup');
    expect(lookup, 'GET copies/lookup must exist').toBeDefined();
    // There must be no *GET* on copies/:copyId that could shadow it; if one is
    // ever added, it must come after lookup.
    const paramGets = routes.filter(
      (r) => r.method === RequestMethod.GET && r.path === 'copies/:copyId',
    );
    for (const pg of paramGets) expect(lookup!.index).toBeLessThan(pg.index);
  });

  it('MembersController GET lookup is declared before GET :id', () => {
    const routes = getRoutes(MembersController);
    const lookup = routes.find((r) => r.method === RequestMethod.GET && r.path === 'lookup');
    const byId = routes.find((r) => r.method === RequestMethod.GET && r.path === ':id');
    expect(lookup, 'GET lookup must exist').toBeDefined();
    expect(byId, 'GET :id must exist').toBeDefined();
    expect(lookup!.index).toBeLessThan(byId!.index);
  });
});
