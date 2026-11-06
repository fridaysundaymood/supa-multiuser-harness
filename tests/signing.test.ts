import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { detectSigningKey, mintLocalJwt } from '../src/core/signing.js';
import { BackendError, localStatus } from '../src/core/stack.js';

vi.mock('../src/core/stack.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/core/stack.js')>();
  return { ...original, localStatus: vi.fn() };
});

describe('local signing key detection', () => {
  it('detects an explicit legacy secret without using API keys', () => {
    expect(
      detectSigningKey({ JWT_SECRET: 'legacy-secret', ANON_KEY: 'other' }),
    ).toEqual({ algorithm: 'HS256', secret: 'legacy-secret' });
    expect(
      detectSigningKey({
        ANON_KEY: 'legacy-token',
        SECRET_KEY: 'sb_secret_example',
      }),
    ).toBeUndefined();
    expect(
      detectSigningKey({ JWT_SECRET: 'sb_secret_example' }),
    ).toBeUndefined();
  });

  it('detects and uses a private JWK from a JSON key set', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const jwk = {
      ...privateKey.export({ format: 'jwk' }),
      alg: 'ES256',
      kid: 'local',
    };
    vi.mocked(localStatus).mockResolvedValueOnce({
      JWT_SIGNING_KEYS: JSON.stringify({ keys: [jwk] }),
    });
    const token = await mintLocalJwt({
      projectRoot: '.',
      claims: { sub: 'fixture' },
    });
    const [header, payload, signature] = token.split('.');
    expect(
      JSON.parse(Buffer.from(header, 'base64url').toString()),
    ).toMatchObject({ alg: 'ES256', kid: 'local' });
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('ignores public, malformed, and incompatible keys', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicJwk = publicKey.export({ format: 'jwk' });
    expect(
      detectSigningKey({
        JWT_SIGNING_KEYS: JSON.stringify({
          keys: [publicJwk, { ...publicJwk, d: 'invalid', alg: 'RS256' }],
        }),
      }),
    ).toBeUndefined();
    expect(
      detectSigningKey({ JWT_SIGNING_KEYS: '{bad', JWT_SECRET: 'fallback' }),
    ).toEqual({ algorithm: 'HS256', secret: 'fallback' });
  });

  it('reports unavailable signing material without disclosing credentials', async () => {
    vi.mocked(localStatus).mockResolvedValueOnce({
      SECRET_KEY: 'sb_secret_private',
    });
    try {
      await mintLocalJwt({ projectRoot: '.', claims: {} });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BackendError);
      expect(error).toMatchObject({ status: 'unsupported' });
      expect(String(error)).not.toContain('sb_secret_private');
    }
  });
});
