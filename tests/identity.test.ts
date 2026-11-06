import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signJwt } from '../src/core/identity.js';

describe('JWT signing', () => {
  it('signs HS256 with the actual secret, not an opaque API key', () => {
    const token = signJwt(
      { sub: 'user' },
      { algorithm: 'HS256', secret: 'local signing secret' },
    );
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString()).alg).toBe(
      'HS256',
    );
    expect(signature).toBe(
      createHmac('sha256', 'local signing secret')
        .update(`${header}.${payload}`)
        .digest('base64url'),
    );
    expect(() =>
      signJwt({}, { algorithm: 'HS256', secret: 'sb_secret_example' }),
    ).toThrow();
  });
  it('signs ES256 with an asymmetric private key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const token = signJwt(
      { sub: 'user' },
      {
        algorithm: 'ES256',
        privateKey: privateKey.export({ format: 'jwk' }),
        keyId: 'local',
      },
    );
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString()).kid).toBe(
      'local',
    );
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });
});
