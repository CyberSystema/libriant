import { describe, expect, it } from 'vitest';
import { decodeBuffer } from './encoding.js';

describe('decodeBuffer', () => {
  it('decodes plain UTF-8', () => {
    const r = decodeBuffer(Buffer.from('héllo', 'utf-8'));
    expect(r.text).toBe('héllo');
    expect(r.encoding).toBe('utf-8');
  });

  it('strips a UTF-8 BOM', () => {
    const r = decodeBuffer(Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0x42]));
    expect(r.text).toBe('AB');
    expect(r.encoding).toBe('utf-8');
  });

  it('decodes UTF-16LE via BOM', () => {
    const r = decodeBuffer(Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]));
    expect(r.text).toBe('AB');
    expect(r.encoding).toBe('utf-16le');
  });

  it('decodes UTF-16BE via BOM', () => {
    const r = decodeBuffer(Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x00, 0x42]));
    expect(r.text).toBe('AB');
    expect(r.encoding).toBe('utf-16be');
  });

  it('falls back to windows-1253 for invalid UTF-8 Greek bytes', () => {
    // 0xC1 0xE8 = "Αθ" in windows-1253, but invalid as UTF-8.
    const r = decodeBuffer(Buffer.from([0xc1, 0xe8]));
    expect(r.encoding).toBe('windows-1253');
    expect(r.text).toBe('Αθ');
  });

  it('honors an explicitly declared encoding', () => {
    // 0xE9 = "é" in latin1 / windows-1252.
    const r = decodeBuffer(Buffer.from([0xe9]), 'windows-1252');
    expect(r.encoding).toBe('windows-1252');
    expect(r.text).toBe('é');
  });

  it('ignores an unknown declared label and auto-detects', () => {
    const r = decodeBuffer(Buffer.from('abc', 'utf-8'), 'totally-bogus');
    expect(r.text).toBe('abc');
    expect(r.encoding).toBe('utf-8');
  });
});
