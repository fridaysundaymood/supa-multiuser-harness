import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { probeCatalog } from '../src/core/catalog-attacks.js';

const catalog = {
  tables: [{ schema: 'public', name: 'widgets', kind: 'r', rls: true }],
  functions: [{ schema: 'public', name: 'lookup', securityDefiner: true }],
};
const key = { algorithm: 'HS256' as const, secret: 'synthetic-secret' };
const request =
  (vulnerable: boolean, escalation: boolean): typeof fetch =>
  async (_input, init) => {
    const token =
      new Headers(init?.headers).get('authorization')?.slice(7) ?? '';
    if (token === 'anon-key') return new Response('[]', { status: 200 });
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const alg = JSON.parse(Buffer.from(header, 'base64url').toString()).alg;
    const expected = createHmac('sha256', key.secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    if (
      alg === 'none' ||
      claims.exp < Date.now() / 1000 ||
      signature !== expected
    )
      return new Response('{}', { status: vulnerable ? 200 : 401 });
    if (!claims.sub && escalation)
      return new Response('[{"id":1}]', { status: 200 });
    return new Response('[]', { status: 200 });
  };
it('reports unsafe tokens and compares claim probes against the anonymous baseline', async () => {
  const clean = await probeCatalog(
    'http://127.0.0.1:1234',
    'anon-key',
    key,
    catalog,
    request(false, false),
  );
  // Empty anon baseline: a 200 with no rows proves nothing about claim rejection, so the run is not a pass.
  expect(clean.status).toBe('error');
  expect(clean.findings.find((f) => f.check === 'missing sub')?.outcome).toBe(
    'inconclusive',
  );
  expect(clean.findings.find((f) => f.check === 'missing sub')?.detail).toMatch(
    /seed rows/i,
  );
  expect(clean.summary.inconclusive).toBeGreaterThan(0);
  const unsafe = await probeCatalog(
    'http://127.0.0.1:1234',
    'anon-key',
    key,
    catalog,
    request(true, true),
  );
  expect(unsafe.status).toBe('fail');
  expect(unsafe.findings.find((f) => f.check === 'alg none')?.outcome).toBe(
    'fail',
  );
  expect(unsafe.findings.find((f) => f.check === 'missing sub')?.outcome).toBe(
    'fail',
  );
  expect(JSON.stringify(unsafe)).not.toContain('anon-key');
});
it('refuses remote targets', async () => {
  await expect(
    probeCatalog(
      'https://example.com',
      'anon-key',
      key,
      catalog,
      request(false, false),
    ),
  ).rejects.toThrow('loopback');
});

it('fails disabled RLS and invalid tokens that reach route validation', async () => {
  const result = await probeCatalog(
    'http://127.0.0.1:1234',
    'anon-key',
    key,
    { tables: [{ ...catalog.tables[0], rls: false }], functions: [] },
    async () => new Response('{}', { status: 404 }),
  );
  expect(result.status).toBe('fail');
  expect(
    result.findings.find((f) => f.check === 'row level security')?.outcome,
  ).toBe('fail');
  expect(
    result.findings.find((f) => f.check === 'bad signature')?.outcome,
  ).toBe('fail');
});

it('reports empty catalogs as inconclusive and rejects credential-bearing URLs', async () => {
  const result = await probeCatalog(
    'http://localhost:1234',
    'anon-key',
    key,
    { tables: [], functions: [] },
    request(false, false),
  );
  expect(result.status).toBe('error');
  await expect(
    probeCatalog(
      'http://user:pass@localhost:1234',
      'anon-key',
      key,
      catalog,
      request(false, false),
    ),
  ).rejects.toThrow('loopback');
});

it('does not execute RPCs and compares claim probes to the anon baseline', async () => {
  const seen: string[] = [];
  const result = await probeCatalog(
    'http://localhost:1234',
    'anon-key',
    key,
    catalog,
    async (input, init) => {
      seen.push(String(input));
      const token =
        new Headers(init?.headers).get('authorization')?.slice(7) ?? '';
      if (token === 'anon-key') return new Response('[]', { status: 200 });
      return new Response('[]', { status: 401 });
    },
  );
  expect(seen.some((url) => url.includes('/rpc/'))).toBe(false);
  expect(
    result.findings.find(
      (f) =>
        f.resource === 'public.lookup' &&
        f.check === 'anonymous security definer',
    )?.outcome,
  ).toBe('info');
});
