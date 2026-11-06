import {
  createPrivateKey,
  type JsonWebKey as NodeJsonWebKey,
} from 'node:crypto';
import { type SigningKey, signJwt } from './identity.js';
import { BackendError, localStatus, type StackOptions } from './stack.js';

/** Detect signing material only from explicit signing fields, never API keys. */
export function detectSigningKey(
  status: Record<string, unknown>,
): SigningKey | undefined {
  for (const field of [
    'JWT_SIGNING_KEYS',
    'JWT_SIGNING_KEY',
    'SIGNING_KEYS',
    'SIGNING_KEY',
  ]) {
    let value = status[field];
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        continue;
      }
    }
    const keys = Array.isArray(value)
      ? value
      : value &&
          typeof value === 'object' &&
          'keys' in value &&
          Array.isArray(value.keys)
        ? value.keys
        : [value];
    for (const candidate of keys) {
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate)
      )
        continue;
      const jwk = candidate as JsonWebKey & { kid?: unknown };
      if (typeof jwk.d !== 'string' || !jwk.d || (jwk.use && jwk.use !== 'sig'))
        continue;
      const algorithm =
        jwk.alg ??
        (jwk.kty === 'EC' && jwk.crv === 'P-256'
          ? 'ES256'
          : jwk.kty === 'OKP' && jwk.crv === 'Ed25519'
            ? 'EdDSA'
            : jwk.kty === 'RSA'
              ? 'RS256'
              : undefined);
      if (
        !(
          (algorithm === 'ES256' && jwk.kty === 'EC' && jwk.crv === 'P-256') ||
          (algorithm === 'EdDSA' &&
            jwk.kty === 'OKP' &&
            jwk.crv === 'Ed25519') ||
          (algorithm === 'RS256' && jwk.kty === 'RSA')
        )
      )
        continue;
      try {
        createPrivateKey({ key: jwk as NodeJsonWebKey, format: 'jwk' });
      } catch {
        continue;
      }
      return {
        algorithm,
        privateKey: jwk,
        ...(typeof jwk.kid === 'string' && jwk.kid ? { keyId: jwk.kid } : {}),
      };
    }
  }
  const secret = status.JWT_SECRET;
  if (
    typeof secret === 'string' &&
    secret.trim() &&
    !secret.startsWith('sb_')
  ) {
    return { algorithm: 'HS256', secret };
  }
  return undefined;
}

export async function mintLocalJwt(
  options: StackOptions & { claims: Record<string, unknown> },
): Promise<string> {
  const key = detectSigningKey(await localStatus(options));
  if (!key) {
    throw new BackendError(
      'Local JWT signing material is unavailable; configure a local signing key or use the local auth flow',
      'unsupported',
    );
  }
  return signJwt(options.claims, key);
}
