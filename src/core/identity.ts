import type { JsonWebKey as NodeJsonWebKey } from 'node:crypto';
import { createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { BackendError, localStatus, type StackOptions } from './stack.js';

export type SigningKey =
  | { algorithm: 'HS256'; secret: string }
  | {
      algorithm: 'RS256' | 'ES256' | 'EdDSA';
      privateKey: JsonWebKey;
      keyId?: string;
    };
const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
export function signJwt(
  claims: Record<string, unknown>,
  key: SigningKey,
): string {
  const header: Record<string, string> = { alg: key.algorithm, typ: 'JWT' };
  if ('keyId' in key && key.keyId) header.kid = key.keyId;
  const input = `${encode(header)}.${encode(claims)}`;
  let signature: Buffer;
  if (key.algorithm === 'HS256') {
    if (!key.secret || key.secret.startsWith('sb_'))
      throw new BackendError('No supported JWT signing secret', 'unsupported');
    signature = createHmac('sha256', key.secret).update(input).digest();
  } else {
    const privateKey = createPrivateKey({
      key: key.privateKey as NodeJsonWebKey,
      format: 'jwk',
    });
    signature = sign(
      key.algorithm === 'EdDSA' ? null : 'sha256',
      Buffer.from(input),
      key.algorithm === 'ES256'
        ? { key: privateKey, dsaEncoding: 'ieee-p1363' }
        : privateKey,
    );
  }
  return `${input}.${signature.toString('base64url')}`;
}
export interface MintUserOptions extends StackOptions {
  email: string;
  password?: string;
  userId?: string;
  role?: string;
}
export interface MintedUser {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  apiKey: string;
}
export async function mintUser(options: MintUserOptions): Promise<MintedUser> {
  const status = await localStatus(options);
  const apiKey = status.PUBLISHABLE_KEY || status.ANON_KEY;
  const adminKey = status.SECRET_KEY || status.SERVICE_ROLE_KEY;
  if (!status.API_URL || !apiKey || !adminKey)
    throw new BackendError(
      'Local auth credentials unavailable; enable auth and API services',
      'unsupported',
    );
  if (options.role && options.role !== 'authenticated')
    throw new BackendError(
      'Local auth flow only supports the authenticated role',
      'unsupported',
    );
  const password = options.password || randomBytes(24).toString('base64url');
  const headers = {
    apikey: adminKey,
    Authorization: `Bearer ${adminKey}`,
    'Content-Type': 'application/json',
  };
  const create = await fetch(`${status.API_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: options.email,
      password,
      email_confirm: true,
      ...(options.userId ? { id: options.userId } : {}),
    }),
    redirect: 'error',
  });
  if (!create.ok)
    throw new Error(`Local auth user creation failed (${create.status})`);
  const user = (await create.json()) as { id?: string };
  const login = await fetch(
    `${status.API_URL}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: { apikey: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: options.email, password }),
      redirect: 'error',
    },
  );
  if (!login.ok)
    throw new BackendError(
      `Local password authentication unavailable (${login.status}); enable password auth`,
      'unsupported',
    );
  const session = (await login.json()) as {
    access_token?: string;
    refresh_token?: string;
  };
  if (!user.id || !session.access_token || !session.refresh_token)
    throw new BackendError(
      'Local auth did not return a complete session',
      'unsupported',
    );
  return {
    userId: user.id,
    email: options.email,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    apiKey,
  };
}
