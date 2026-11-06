import { describe, expect, it } from 'vitest';
import {
  assertLocalUrl,
  BackendError,
  normalizeDump,
  stackAt,
  stackMigrate,
} from '../src/core/stack.js';

describe('local stack safety', () => {
  it('accepts loopback and rejects remote or deceptive endpoints', () => {
    expect(() =>
      assertLocalUrl('postgresql://postgres@127.0.0.1:54322/postgres', [
        'postgresql:',
      ]),
    ).not.toThrow();
    for (const url of [
      'https://localhost.example.com',
      'https://10.0.2.2',
      'https://example.com',
      'file:///tmp/x',
    ]) {
      expect(() => assertLocalUrl(url, ['http:', 'https:'])).toThrow(
        BackendError,
      );
    }
  });
  it('refuses linked operations before consulting the stack', async () => {
    await expect(
      stackMigrate({ projectRoot: '.', linked: true }),
    ).rejects.toThrow('linked');
    await expect(
      stackAt({ projectRoot: '.', version: '20260101', linked: true }),
    ).rejects.toThrow('linked');
  });
  it('normalizes dump metadata but preserves SQL and schema comments', () => {
    const dump =
      '-- Dumped by pg_dump version 16\r\n\\restrict abc\r\n-- meaningful comment\r\nCREATE TABLE x (id int);\r\n';
    expect(normalizeDump(dump)).toBe(
      '-- meaningful comment\nCREATE TABLE x (id int);\n',
    );
    expect(normalizeDump('CREATE TABLE x (id text);')).not.toBe(
      normalizeDump('CREATE TABLE x (id int);'),
    );
  });
});
