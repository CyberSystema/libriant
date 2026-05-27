import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionPayload } from './jwt-session.service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by SessionMiddleware. Undefined on unauthenticated requests. */
      session?: SessionPayload;
    }
  }
}

/**
 * Pull the verified session payload from the request. Throws 401 if not
 * present — used inside handlers protected by AuthGuard for type safety.
 */
export const Sess = createParamDecorator<unknown, ExecutionContext, SessionPayload>((_, ctx) => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.session) {
    throw new UnauthorizedException('Authentication required.');
  }
  return req.session;
});
