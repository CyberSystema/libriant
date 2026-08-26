import { describe, expect, it } from 'vitest';
import { UnsupportedMediaTypeException } from '@nestjs/common';
import { assertBytesMatchContentType } from './content-sniff.js';

/**
 * input-and-files-09. The payload in the first case is the audit's, verbatim:
 * it was accepted as a book cover (201) and read back byte-identical.
 */
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 7)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x40, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.alloc(64, 7),
]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 7)]);
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)]);

describe('assertBytesMatchContentType', () => {
  it('refuses an HTML body sent as a PNG', () => {
    expect(() => assertBytesMatchContentType('image/png', HTML)).toThrow(
      UnsupportedMediaTypeException,
    );
    expect(() => assertBytesMatchContentType('image/png', HTML)).toThrow(/not a PNG image/);
  });

  it('refuses one real image type declared as another', () => {
    expect(() => assertBytesMatchContentType('image/jpeg', PNG)).toThrow(
      UnsupportedMediaTypeException,
    );
  });

  it('refuses an empty upload declared as an image', () => {
    expect(() => assertBytesMatchContentType('image/png', Buffer.alloc(0))).toThrow(
      UnsupportedMediaTypeException,
    );
  });

  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['image/webp', WEBP],
    ['application/pdf', PDF],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', XLSX],
  ])('accepts a real %s', (type, bytes) => {
    expect(() => assertBytesMatchContentType(type, bytes)).not.toThrow();
  });

  it('accepts a PDF whose header is preceded by a preamble', () => {
    // Scanners and older exporters do this, and every reader tolerates it —
    // a library receiving such a file from a supplier must not be stuck.
    const withPreamble = Buffer.concat([Buffer.alloc(200, 0x20), PDF]);
    expect(() => assertBytesMatchContentType('application/pdf', withPreamble)).not.toThrow();
  });

  it('ignores a charset parameter rather than treating it as an unknown type', () => {
    expect(() => assertBytesMatchContentType('IMAGE/PNG; charset=binary', HTML)).toThrow(
      UnsupportedMediaTypeException,
    );
    expect(() => assertBytesMatchContentType('image/png; charset=binary', PNG)).not.toThrow();
  });

  it.each(['text/plain', 'text/csv', 'application/marc', 'application/octet-stream'])(
    'accepts %s unchecked — those formats have no header to check',
    (type) => {
      expect(() => assertBytesMatchContentType(type, HTML)).not.toThrow();
      expect(() => assertBytesMatchContentType(type, Buffer.from('Title,ISBN\n'))).not.toThrow();
    },
  );
});
