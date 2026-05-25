import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  await app.listen(env.port);
  // eslint-disable-next-line no-console
  console.log(`[libriant-api] listening on :${env.port} (${env.nodeEnv})`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[libriant-api] failed to start', err);
  process.exit(1);
});
