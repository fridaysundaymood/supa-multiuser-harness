import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import {
  type AutomaticAttackOptions,
  runAutomaticAttacks,
} from '../src/core/automatic-attacks.js';

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    await promise;
  }
  server = undefined;
});

const jwt = (exp: number, signature = 'signature') =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.${signature}`;

async function setup(vulnerable = false): Promise<AutomaticAttackOptions> {
  const valid = jwt(4102444800);
  const expired = jwt(1);
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/rest/v1/')
      return res.end(
        JSON.stringify({ paths: { '/tasks': {}, '/rpc/find_tasks': {} } }),
      );
    if (req.headers.authorization !== `Bearer ${valid}`) {
      res.statusCode = 401;
      return res.end('{}');
    }
    res.end(
      JSON.stringify(
        req.url?.includes('group=eq.other') && vulnerable ? [{ id: 1 }] : [],
      ),
    );
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return {
    connection: {
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'secret-api-key',
      tokens: { member: valid },
    },
    policies: ['/tasks', '/rpc/find_tasks'].map((path) => ({
      path,
      roles: [
        {
          actor: 'member',
          request: { path: `/rest/v1${path}` },
          checks: [{ kind: 'status', equals: 200 }],
        },
      ],
      credentialRequest: { path: `/rest/v1${path}` },
      expiredTokens: { member: expired },
      crossGroup: [
        {
          name: 'other group',
          request: { actor: 'member', path: `/rest/v1${path}?group=eq.other` },
          checks: [{ kind: 'empty' }],
        },
      ],
    })),
  };
}

it.each([false, true])(
  'covers catalog resources and detects cross-group leaks (vulnerable=%s)',
  async (vulnerable) => {
    const options = await setup(vulnerable);
    const report = await runAutomaticAttacks(options);
    expect(report.status).toBe(vulnerable ? 'fail' : 'pass');
    expect(report.probes).toHaveLength(8);
    expect(report.discovered).toEqual({
      tables: ['tasks'],
      rpcs: ['find_tasks'],
    });
    expect(JSON.stringify(report)).not.toContain(
      options.connection.tokens.member,
    );
    expect(JSON.stringify(report)).not.toContain(options.connection.apiKey);
  },
);

it('refuses missing policy, invalid expiry and remote endpoints', async () => {
  const options = await setup();
  expect((await runAutomaticAttacks({ ...options, policies: [] })).status).toBe(
    'error',
  );
  const policy = options.policies[0];
  if (!policy) throw new Error('Missing test policy');
  policy.expiredTokens.member = jwt(4102444800, 'other');
  expect((await runAutomaticAttacks(options)).status).toBe('error');
  options.connection.baseUrl = 'https://example.com';
  expect((await runAutomaticAttacks(options)).status).toBe('error');
});
