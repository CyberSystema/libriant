import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { clientIp } from './client-ip.js';

function req(headers: Record<string, string | string[]>, ip?: string): Request {
  return { headers, ip, socket: { remoteAddress: '10.0.0.1' } } as unknown as Request;
}

describe('clientIp', () => {
  it('prefers X-Real-IP (the real client behind Cloudflare/Caddy)', () => {
    expect(clientIp(req({ 'x-real-ip': '203.0.113.7' }, '172.16.0.5'))).toBe('203.0.113.7');
  });

  it('takes the first entry if X-Real-IP is a list', () => {
    expect(clientIp(req({ 'x-real-ip': '203.0.113.7, 172.16.0.5' }))).toBe('203.0.113.7');
  });

  it('handles X-Real-IP delivered as an array', () => {
    expect(clientIp(req({ 'x-real-ip': ['203.0.113.7'] }))).toBe('203.0.113.7');
  });

  it('falls back to req.ip when X-Real-IP is absent', () => {
    expect(clientIp(req({}, '172.16.0.5'))).toBe('172.16.0.5');
  });

  it('falls back to the socket address as a last resort', () => {
    expect(clientIp(req({}))).toBe('10.0.0.1');
  });
});
