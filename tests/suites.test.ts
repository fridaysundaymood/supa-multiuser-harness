import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Connection,
  type Probe,
  runAttacks,
  runRaces,
  runScenario,
} from '../src/core/suites.js';

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    await promise;
  }
  server = undefined;
});

async function fixture(vulnerable = false): Promise<Connection> {
  let counter = 0;
  let pending: Array<() => void> = [];
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/rest/v1/')
      return res.end(
        JSON.stringify({
          paths: { '/tasks': {}, '/rpc/increment_board_counter': {} },
        }),
      );
    if (req.url === '/rest/v1/tasks?board_id=eq.south')
      return res.end(JSON.stringify(vulnerable ? [{ id: 'south' }] : []));
    if (req.url === '/counter') return res.end(JSON.stringify({ counter }));
    if (req.url === '/rest/v1/rpc/increment_board_counter') {
      if (vulnerable) {
        const snapshot = counter;
        pending.push(() => {
          counter = snapshot + 1;
          res.end(JSON.stringify(counter));
        });
        if (pending.length === 4) {
          const batch = pending;
          pending = [];
          for (const finish of batch) finish();
        }
      } else {
        counter++;
        res.end(JSON.stringify(counter));
      }
      return;
    }
    res.end('[]');
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing server address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'private-api-key',
    tokens: { north: 'private-token', south: 'other-token' },
  };
}
const probe: Probe = {
  name: 'cross-board read',
  request: { actor: 'north', path: '/rest/v1/tasks?board_id=eq.south' },
  checks: [{ kind: 'status', equals: 200 }, { kind: 'empty' }],
};

describe('suite runners', () => {
  it.each([false, true])(
    'detects cross-board exposure (vulnerable=%s)',
    async (vulnerable) => {
      const connection = await fixture(vulnerable);
      const result = await runAttacks({ connection, probes: [probe] });
      expect(result.status).toBe(vulnerable ? 'fail' : 'pass');
      expect(result.discovered).toEqual({
        tables: ['tasks'],
        rpcs: ['increment_board_counter'],
      });
      expect(JSON.stringify(result)).not.toContain('private-token');
    },
  );
  it.each([false, true])(
    'detects lost increments (vulnerable=%s)',
    async (vulnerable) => {
      const connection = await fixture(vulnerable);
      const result = await runRaces({
        connection,
        request: {
          actor: 'north',
          path: '/rest/v1/rpc/increment_board_counter',
          method: 'POST',
          body: { p_board_id: 'north' },
        },
        before: { actor: 'north', path: '/counter' },
        after: { actor: 'north', path: '/counter' },
        concurrency: 4,
        repeats: 2,
        seed: 123,
        expectedDelta: 4,
        valuePath: ['counter'],
      });
      expect(result.status).toBe(vulnerable ? 'fail' : 'pass');
      expect(result.attempts.map((attempt) => attempt.seed)).toEqual([
        123, 124,
      ]);
      expect(result.attempts[0]?.ordering).toHaveLength(4);
      expect(result.latencyMs?.p95).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(result)).not.toContain('private-token');
    },
  );
  it('executes only the bounded reconnect permutations', async () => {
    const connection = await fixture();
    const result = await runScenario({
      connection,
      maxOrderings: 2,
      steps: [
        { kind: 'reconnect', devices: { a: [probe], b: [probe], c: [probe] } },
      ],
    });
    expect(result.status).toBe('pass');
    expect(result.totalOrderings).toBe(6);
    expect(result.executedOrderings).toBe(2);
    expect(result.truncated).toBe(true);
    expect(
      result.orderings.every((ordering) => ordering.probes.length === 3),
    ).toBe(true);
  });
  it('refuses remote endpoints', async () => {
    const connection = {
      baseUrl: 'https://example.com',
      apiKey: 'key',
      tokens: { north: 'token' },
    };
    const result = await runAttacks({ connection, probes: [probe] });
    expect(result.status).toBe('error');
  });
});
