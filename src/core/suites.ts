import { performance } from 'node:perf_hooks';

export interface Connection {
  baseUrl: string;
  apiKey: string;
  tokens: Record<string, string>;
}
export interface RequestSpec {
  actor: string;
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}
export interface Observation {
  status: number;
  body: unknown;
  latencyMs: number;
}
export type Check =
  | { kind: 'status'; equals: number }
  | { kind: 'empty' }
  | { kind: 'equals'; value: unknown }
  | { kind: 'contains'; value: unknown };
export interface Probe {
  name: string;
  request: RequestSpec;
  checks: Check[];
}
export interface ProbeResult {
  name: string;
  passed: boolean;
  status?: number;
  error?: string;
}
export interface AttackOptions {
  connection: Connection;
  probes: Probe[];
}
export interface AttackReport {
  status: 'pass' | 'fail' | 'error';
  coverage: string;
  discovered: { tables: string[]; rpcs: string[] };
  probes: ProbeResult[];
}

function endpoint(connection: Connection, path: string): URL {
  const base = new URL(connection.baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) ||
    base.username ||
    base.password
  )
    throw new Error('A loopback HTTP endpoint is required');
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new Error('Request path must be absolute on the local endpoint');
  const url = new URL(path, base);
  if (url.origin !== base.origin)
    throw new Error('Request escaped the local endpoint');
  return url;
}

async function request(
  connection: Connection,
  spec: RequestSpec,
  timeoutMs = 30000,
): Promise<Observation> {
  const url = endpoint(connection, spec.path);
  const token = connection.tokens[spec.actor];
  if (token === undefined) throw new Error(`Unknown actor: ${spec.actor}`);
  const start = performance.now();
  const response = await fetch(url, {
    method: spec.method ?? 'GET',
    headers: {
      ...spec.headers,
      apikey: connection.apiKey,
      authorization: `Bearer ${token}`,
      ...(spec.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
    },
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    /* Non-JSON responses remain text. */
  }
  return {
    status: response.status,
    body,
    latencyMs: performance.now() - start,
  };
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function check(observation: Observation, checks: Check[]): boolean {
  return checks.every((c) => {
    switch (c.kind) {
      case 'status':
        return observation.status === c.equals;
      case 'empty':
        return Array.isArray(observation.body) && observation.body.length === 0;
      case 'equals':
        return equal(observation.body, c.value);
      case 'contains':
        return (
          Array.isArray(observation.body) &&
          observation.body.some((item) => equal(item, c.value))
        );
    }
    return false;
  });
}

export async function runAttacks(
  options: AttackOptions,
): Promise<AttackReport> {
  const discovered = { tables: [] as string[], rpcs: [] as string[] };
  const probes: ProbeResult[] = [];
  const coverage =
    'Only explicitly supplied probes are executed; discovery does not generate a role or JWT attack matrix.';
  try {
    const actor = Object.keys(options.connection.tokens)[0];
    if (!actor) throw new Error('At least one actor is required for discovery');
    const discovery = await request(options.connection, {
      actor,
      path: '/rest/v1/',
    });
    if (
      discovery.status !== 200 ||
      !discovery.body ||
      typeof discovery.body !== 'object'
    )
      throw new Error('PostgREST discovery failed');
    if (
      !('paths' in discovery.body) ||
      !discovery.body.paths ||
      typeof discovery.body.paths !== 'object'
    )
      throw new Error('PostgREST discovery did not return paths');
    const paths = discovery.body.paths;
    for (const path of Object.keys(paths)) {
      if (path.startsWith('/rpc/')) discovered.rpcs.push(path.slice(5));
      else if (path !== '/' && path.startsWith('/'))
        discovered.tables.push(path.slice(1));
    }
    for (const probe of options.probes) {
      try {
        if (!probe.checks.length)
          throw new Error('A probe needs at least one assertion');
        const result = await request(options.connection, probe.request);
        probes.push({
          name: probe.name,
          status: result.status,
          passed: check(result, probe.checks),
        });
      } catch {
        probes.push({
          name: probe.name,
          passed: false,
          error: 'Probe request or configuration failed',
        });
      }
    }
    if (!options.probes.length)
      return { status: 'error', coverage, discovered, probes };
    return {
      status: probes.some((p) => !p.passed) ? 'fail' : 'pass',
      coverage,
      discovered,
      probes,
    };
  } catch {
    return { status: 'error', coverage, discovered, probes };
  }
}

export interface RaceOptions {
  connection: Connection;
  request: RequestSpec;
  concurrency: number;
  repeats: number;
  seed: number;
  timeoutMs?: number;
  before: RequestSpec;
  after: RequestSpec;
  expectedDelta: number;
  valuePath: string[];
}
export interface RaceAttempt {
  attempt: number;
  seed: number;
  inputs: { request: Omit<RequestSpec, 'headers'>; concurrency: number };
  ordering: number[];
  statuses: (number | null)[];
  before?: number;
  after?: number;
  passed: boolean;
  deadlock: boolean;
  error?: string;
}
export interface RaceReport {
  status: 'pass' | 'fail' | 'flaky' | 'error';
  attempts: RaceAttempt[];
  latencyMs: { p50: number; p95: number; p99: number } | null;
}
function numberAt(value: unknown, path: string[]): number | undefined {
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
function shuffle(count: number, seed: number): number[] {
  let state = seed >>> 0;
  const values = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [values[i], values[j]] = [values[j] ?? 0, values[i] ?? 0];
  }
  return values;
}
export async function runRaces(options: RaceOptions): Promise<RaceReport> {
  const attempts: RaceAttempt[] = [];
  const latencies: number[] = [];
  if (
    !Number.isSafeInteger(options.repeats) ||
    options.repeats < 1 ||
    !Number.isSafeInteger(options.concurrency) ||
    options.concurrency < 1 ||
    !Number.isSafeInteger(options.seed) ||
    !Number.isFinite(options.expectedDelta) ||
    (options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1))
  )
    return { status: 'error', attempts, latencyMs: null };
  for (let i = 0; i < options.repeats; i++) {
    const seed = (options.seed + i) >>> 0;
    const ordering = shuffle(options.concurrency, seed);
    const safeRequest = JSON.parse(
      JSON.stringify(options.request, (key, value: unknown) => {
        if (/token|secret|password|authorization|apikey|api_key/i.test(key))
          return '[REDACTED]';
        if (typeof value === 'string') {
          for (const secret of [
            options.connection.apiKey,
            ...Object.values(options.connection.tokens),
          ])
            if (secret && value.includes(secret)) return '[REDACTED]';
        }
        return value;
      }),
    ) as RequestSpec;
    delete safeRequest.headers;
    const attempt: RaceAttempt = {
      attempt: i + 1,
      seed,
      inputs: { request: safeRequest, concurrency: options.concurrency },
      ordering,
      statuses: [],
      passed: false,
      deadlock: false,
    };
    attempts.push(attempt);
    try {
      const before = await request(
        options.connection,
        options.before,
        options.timeoutMs,
      );
      attempt.before = numberAt(before.body, options.valuePath);
      if (
        before.status < 200 ||
        before.status >= 300 ||
        attempt.before === undefined
      )
        throw new Error('Cannot read initial invariant');
      const results = await Promise.all(
        ordering.map(async () => {
          try {
            return await request(
              options.connection,
              options.request,
              options.timeoutMs,
            );
          } catch {
            return null;
          }
        }),
      );
      attempt.statuses = results.map((r) => r?.status ?? null);
      for (const result of results)
        if (result) {
          latencies.push(result.latencyMs);
          if (
            typeof result.body === 'object' &&
            result.body !== null &&
            'code' in result.body &&
            result.body.code === '40P01'
          )
            attempt.deadlock = true;
        }
      const after = await request(
        options.connection,
        options.after,
        options.timeoutMs,
      );
      attempt.after = numberAt(after.body, options.valuePath);
      if (
        after.status < 200 ||
        after.status >= 300 ||
        attempt.after === undefined
      )
        throw new Error('Cannot read final invariant');
      attempt.passed =
        results.every((r) => r !== null && r.status >= 200 && r.status < 300) &&
        attempt.after - attempt.before === options.expectedDelta &&
        !attempt.deadlock;
    } catch {
      attempt.error = 'Invariant request or configuration failed';
    }
  }
  latencies.sort((a, b) => a - b);
  const percentile = (p: number) =>
    latencies[Math.max(0, Math.ceil(p * latencies.length) - 1)] ?? 0;
  const passed = attempts.filter((a) => a.passed).length;
  return {
    status: passed === attempts.length ? 'pass' : passed ? 'flaky' : 'fail',
    attempts,
    latencyMs: latencies.length
      ? { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) }
      : null,
  };
}

export type ScenarioStep =
  | { kind: 'request'; name: string; request: RequestSpec; checks: Check[] }
  | { kind: 'parallel'; steps: ScenarioStep[] }
  | { kind: 'reconnect'; devices: Record<string, Probe[]> };
export interface ScenarioOptions {
  connection: Connection;
  steps: ScenarioStep[];
  maxOrderings?: number;
}
export interface ScenarioReport {
  status: 'pass' | 'fail' | 'error';
  mode: 'http';
  limitation: string;
  totalOrderings: number;
  executedOrderings: number;
  truncated: boolean;
  orderings: { order: string[]; probes: ProbeResult[] }[];
}
function permutations(values: string[], cap: number): string[][] {
  const out: string[][] = [];
  function visit(prefix: string[], rest: string[]): void {
    if (out.length >= cap) return;
    if (!rest.length) {
      out.push(prefix);
      return;
    }
    rest.forEach((value, i) => {
      visit([...prefix, value], [...rest.slice(0, i), ...rest.slice(i + 1)]);
    });
  }
  visit([], values);
  return out;
}
export async function runScenario(
  options: ScenarioOptions,
): Promise<ScenarioReport> {
  const report: ScenarioReport = {
    status: 'error',
    mode: 'http',
    limitation:
      'HTTP requests only; no Android app, device, or runtime guard integration is verified.',
    totalOrderings: 1,
    executedOrderings: 0,
    truncated: false,
    orderings: [],
  };
  const reconnects: string[][] = [];
  function collect(steps: ScenarioStep[]): void {
    for (const step of steps) {
      if (step.kind === 'reconnect') reconnects.push(Object.keys(step.devices));
      else if (step.kind === 'parallel') collect(step.steps);
    }
  }
  collect(options.steps);
  const cap = options.maxOrderings ?? 1;
  if (
    !Number.isSafeInteger(cap) ||
    cap < 1 ||
    reconnects.length > 1 ||
    reconnects.some((d) => new Set(d).size !== d.length)
  )
    return report;
  const devices = reconnects[0] ?? [];
  for (let i = 2; i <= devices.length; i++) {
    report.totalOrderings *= i;
    if (!Number.isSafeInteger(report.totalOrderings)) return report;
  }
  const orders = permutations(devices, cap);
  report.truncated = orders.length < report.totalOrderings;
  for (const order of orders) {
    const probes: ProbeResult[] = [];
    async function execute(step: ScenarioStep): Promise<void> {
      if (step.kind === 'parallel') {
        await Promise.all(step.steps.map(execute));
        return;
      }
      if (step.kind === 'reconnect') {
        for (const device of order) {
          const actions = step.devices[device];
          if (!actions?.length) {
            probes.push({
              name: `reconnect:${device}`,
              passed: false,
              error: 'No reconnect actions',
            });
            continue;
          }
          for (const probe of actions)
            await execute({ kind: 'request', ...probe });
        }
        return;
      }
      try {
        if (!step.checks.length) throw new Error('Missing assertions');
        const result = await request(options.connection, step.request);
        probes.push({
          name: step.name,
          status: result.status,
          passed: check(result, step.checks),
        });
      } catch {
        probes.push({
          name: step.name,
          passed: false,
          error: 'Step request or configuration failed',
        });
      }
    }
    for (const step of options.steps) await execute(step);
    report.orderings.push({ order, probes });
    report.executedOrderings++;
  }
  report.status = report.orderings.some((o) => !o.probes.length)
    ? 'error'
    : report.orderings.some((o) => o.probes.some((p) => !p.passed))
      ? 'fail'
      : 'pass';
  return report;
}
