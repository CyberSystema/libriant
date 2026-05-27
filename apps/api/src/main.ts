import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Parse Cookie header into req.cookies — required by SessionMiddleware.
  app.use(cookieParser());

  // Input validation runs per-route via `auth/validate-dto.ts`. We avoid
  // NestJS's global ValidationPipe because `tsx` (esbuild) doesn't emit
  // `design:paramtypes` decorator metadata, which the pipe needs to know
  // which DTO class to apply. When we adopt a transpiler that emits
  // metadata (swc), we can swap back to `useGlobalPipes(new ValidationPipe(...))`.

  await app.listen(env.port);
  // eslint-disable-next-line no-console
  console.log(`[libriant-api] listening on :${env.port} (${env.nodeEnv})`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[libriant-api] failed to start', err);
  process.exit(1);
});
