/**
 * Resolve environment variables once at boot. Treats config strictly: every
 * value we depend on is either present + valid, or boot fails loudly.
 */
export type AppEnv = {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  publicAppUrl: string;
  controlDbUrl: string;
  redisUrl: string;
  storageRoot: string;
  assetsRoot: string;
};

function required(key: string): string {
  const v = process.env[key];
  if (!v || v.trim().length === 0) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

function optional(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length ? v : fallback;
}

export function loadEnv(): AppEnv {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as AppEnv['nodeEnv'];
  return {
    nodeEnv,
    port: Number(optional('PORT', '3001')),
    publicAppUrl: optional('PUBLIC_APP_URL', 'http://localhost:3000'),
    controlDbUrl: optional(
      'CONTROL_DATABASE_URL',
      'postgresql://libriant:libriant@localhost:5432/libriant_control',
    ),
    redisUrl: optional('REDIS_URL', 'redis://localhost:6379'),
    storageRoot: optional('STORAGE_ROOT', '/srv/libriant/storage'),
    assetsRoot: optional('ASSETS_ROOT', new URL('../../../../assets', import.meta.url).pathname),
  };
}
