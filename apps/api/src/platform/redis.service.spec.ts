import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * reliability-01 / -16: the client is built with `enableOfflineQueue: false`,
 * so a command issued while the socket is still `connecting` rejects instead
 * of waiting. `ready()` is the guard every short-lived caller needs; these
 * specs pin its contract, including that it doesn't hang forever on a Redis
 * that is genuinely gone and doesn't leak a listener per call.
 */
type FakeRedis = {
  status: string;
  listenerCount(event: string): number;
  emit(event: string): void;
};

const { instances } = vi.hoisted(() => ({ instances: [] as FakeRedis[] }));

vi.mock('ioredis', () => {
  type Listener = () => void;
  class Fake {
    status = 'connecting';
    private readonly listeners = new Map<string, Listener[]>();
    constructor() {
      instances.push(this as unknown as FakeRedis);
    }
    on(event: string, fn: Listener) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
      return this;
    }
    once(event: string, fn: Listener) {
      return this.on(event, fn);
    }
    off(event: string, fn: Listener) {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((l) => l !== fn),
      );
      return this;
    }
    listenerCount(event: string) {
      return (this.listeners.get(event) ?? []).length;
    }
    emit(event: string) {
      for (const fn of [...(this.listeners.get(event) ?? [])]) fn();
    }
  }
  return { Redis: Fake };
});
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({ redisUrl: 'redis://localhost:6379' }),
}));

import { FailOpenMemo, RedisService } from './redis.service.js';

describe('RedisService.ready', () => {
  beforeEach(() => {
    instances.length = 0;
  });

  it('returns without waiting when the socket is already up', async () => {
    const service = new RedisService();
    const client = instances[0]!;
    client.status = 'ready';

    await service.ready();

    expect(client.listenerCount('ready')).toBe(0);
  });

  it('waits for the connection instead of letting the first command reject', async () => {
    const service = new RedisService();
    const client = instances[0]!;

    let settled = false;
    const waiting = service.ready().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    client.status = 'ready';
    client.emit('ready');
    await waiting;

    expect(settled).toBe(true);
    // Both listeners and the timer are cleaned up, so a per-tick caller can't
    // pile them up on the shared client.
    expect(client.listenerCount('ready')).toBe(0);
    expect(client.listenerCount('end')).toBe(0);
  });

  it('gives up when the connection ends before it comes up', async () => {
    const service = new RedisService();
    const client = instances[0]!;

    const waiting = service.ready();
    client.emit('end');

    await expect(waiting).rejects.toThrow(/ended before it became ready/);
  });

  it('gives up after the timeout rather than hanging the job forever', async () => {
    const service = new RedisService();

    await expect(service.ready(5)).rejects.toThrow(/not ready after 5ms/);
  });
});

describe('FailOpenMemo', () => {
  it('serves a value back until it expires', () => {
    const memo = new FailOpenMemo<string>(50);
    memo.set('k', 'v');

    expect(memo.get('k')).toBe('v');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 51);
    try {
      expect(memo.get('k')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a busted key immediately', () => {
    const memo = new FailOpenMemo<string>(1_000);
    memo.set('a', '1');
    memo.set('b', '2');

    memo.delete('a', 'b');

    expect(memo.get('a')).toBeNull();
    expect(memo.get('b')).toBeNull();
  });

  it('cannot grow without bound during a long outage', () => {
    const memo = new FailOpenMemo<string>(60_000, 3);
    for (const k of ['a', 'b', 'c', 'd']) memo.set(k, k);

    expect(memo.get('d')).toBe('d');
    expect(memo.get('a')).toBeNull();
  });
});
