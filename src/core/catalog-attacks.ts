import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { type SigningKey, signJwt } from './identity.js';
import { detectSigningKey } from './signing.js';
import {
  BackendError,
  command,
  localStatus,
  type StackOptions,
} from './stack.js';

export type Catalog = {
  tables: Array<{
    schema: string;
    name: string;
    kind: string;
    rls: boolean;
    alwaysTriggers?: string[];
  }>;
  functions: Array<{ schema: string; name: string; securityDefiner: boolean }>;
};
type Finding = {
  resource: string;
  check: string;
  outcome: 'fail' | 'info' | 'blocked';
  detail: string;
};

/** JWT probes use GET; exposed RPCs may execute if the gateway accepts invalid credentials. */
function parseRows(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export async function probeCatalog(
  baseUrl: string,
  apiKey: string,
  key: SigningKey,
  catalog: Catalog,
  fetcher: typeof fetch = fetch,
) {
  const base = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) ||
    base.username ||
    base.password
  )
    throw new Error('A loopback HTTP endpoint is required');
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    role: 'authenticated',
    sub: randomUUID(),
    aud: 'authenticated',
    iss: `${baseUrl}/auth/v1`,
    iat: now,
    exp: now + 300,
  };
  const valid = signJwt(claims, key);
  const parts = valid.split('.');
  const badSignature = `${parts[0]}.${parts[1]}.${parts[2]?.startsWith('A') ? 'B' : 'A'}${parts[2]?.slice(1)}`;
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${parts[1]}.`;
  const { sub: _sub, ...noSub } = claims;
  const variants = [
    ['bad signature', badSignature, true],
    ['alg none', none, true],
    ['expired', signJwt({ ...claims, exp: now - 60 }, key), true],
    ['missing sub', signJwt(noSub, key), false],
    ['wrong aud', signJwt({ ...claims, aud: 'unexpected' }, key), false],
    ['wrong iss', signJwt({ ...claims, iss: 'unexpected' }, key), false],
  ] as const;
  const findings: Finding[] = [];
  let inconclusive = catalog.tables.length === 0;
  for (const table of catalog.tables) {
    const resource = `${table.schema}.${table.name}`;
    if (table.kind === 'r' || table.kind === 'p')
      findings.push({
        resource,
        check: 'row level security',
        outcome: table.rls ? 'info' : 'fail',
        detail: table.rls
          ? 'RLS enabled; policy correctness requires scenarios'
          : 'RLS disabled',
      });
    const url = new URL(
      `/rest/v1/${encodeURIComponent(table.name)}?limit=100`,
      base,
    );
    const request = async (token: string) => {
      const response = await fetcher(url, {
        headers: {
          apikey: apiKey,
          authorization: `Bearer ${token}`,
          'Accept-Profile': table.schema,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      return { status: response.status, body: await response.text() };
    };
    const baseline = await request(apiKey);
    if (baseline.status >= 500) inconclusive = true;
    // A denied anonymous read is an empty baseline: any rows returned under a claim variant exceed it.
    const baselineRows: unknown =
      baseline.status >= 200 && baseline.status < 300
        ? parseRows(baseline.body)
        : [];
    for (const [name, token, hard] of variants) {
      const observed = await request(token);
      const success = observed.status >= 200 && observed.status < 300;
      if (observed.status >= 500) inconclusive = true;
      let escalation = false;
      if (success) {
        const rows = parseRows(observed.body);
        if (Array.isArray(rows) && Array.isArray(baselineRows)) {
          escalation = rows.length > baselineRows.length;
        } else inconclusive = true;
      }
      findings.push({
        resource,
        check: name,
        outcome: (hard ? ![401, 403].includes(observed.status) : escalation)
          ? 'fail'
          : 'info',
        detail: hard
          ? `HTTP ${observed.status}; invalid credentials must be rejected`
          : `HTTP ${observed.status}, authenticated baseline HTTP ${baseline.status}; ${escalation ? 'more rows than baseline' : 'no observed escalation'}`,
      });
    }
  }
  for (const fn of catalog.functions)
    if (fn.securityDefiner)
      findings.push({
        resource: `${fn.schema}.${fn.name}`,
        check: 'anonymous security definer',
        outcome: 'info',
        detail:
          'Callable by anon; review intended privilege boundary. RPCs not executed by catalog probes.',
      });
  return {
    status: findings.some((f) => f.outcome === 'fail')
      ? ('fail' as const)
      : inconclusive
        ? ('error' as const)
        : ('pass' as const),
    findings,
    coverage:
      'JWT row comparisons are limited to 100 rows and may require review. Cross-user, write and race behavior requires an explicit scenario.',
  };
}

export async function discoverCatalog(options: StackOptions): Promise<Catalog> {
  await localStatus(options);
  const root = options.projectRoot;
  const config = parseToml(
    await readFile(join(root, 'supabase', 'config.toml'), 'utf8'),
  );
  const api =
    config.api && typeof config.api === 'object' && !Array.isArray(config.api)
      ? (config.api as Record<string, unknown>)
      : {};
  const schemas = Array.isArray(api.schemas)
    ? api.schemas
    : ['public', 'graphql_public'];
  if (!schemas.every((schema) => typeof schema === 'string'))
    throw new BackendError('Invalid exposed API schemas');
  const schemaList = schemas
    .map((schema) => `'${String(schema).replaceAll("'", "''")}'`)
    .join(',');
  const sql = `SELECT json_build_object('tables', COALESCE((SELECT json_agg(json_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'alwaysTriggers',COALESCE((SELECT json_agg(t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND t.tgenabled='A'),'[]'::json))) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN (${schemaList}) AND c.relkind IN ('r','p','v','m')), '[]'::json), 'functions', COALESCE((SELECT json_agg(json_build_object('schema',n.nspname,'name',p.proname,'securityDefiner',p.prosecdef AND has_function_privilege('anon',p.oid,'EXECUTE'))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN (${schemaList})), '[]'::json))`;
  const id = config.project_id;
  if (typeof id !== 'string' || !/^[\w.-]+$/.test(id))
    throw new BackendError('Cannot verify local project identity');
  const output = await command(
    'docker',
    [
      'exec',
      `supabase_db_${id}`,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-At',
      '-c',
      sql,
    ],
    root,
  );
  return JSON.parse(output) as Catalog;
}

export async function runCatalogAttacks(options: StackOptions) {
  const status = await localStatus(options);
  const key = detectSigningKey(status);
  const apiKey = status.ANON_KEY || status.PUBLISHABLE_KEY;
  if (!status.API_URL || !apiKey || !key)
    throw new BackendError(
      'Local API credentials or JWT signing material unavailable; configure local signing keys',
      'unsupported',
    );
  const catalog = await discoverCatalog(options);
  const report = await probeCatalog(status.API_URL, apiKey, key, catalog);
  const config = parseToml(
    await readFile(
      join(options.projectRoot, 'supabase', 'config.toml'),
      'utf8',
    ),
  );
  const id = config.project_id;
  if (typeof id !== 'string' || !/^[\w.-]+$/.test(id))
    throw new BackendError('Cannot verify local project identity');
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  for (const table of catalog.tables) {
    if (table.kind !== 'r' && table.kind !== 'p') continue;
    const resource = `${table.schema}.${table.name}`;
    if (table.alwaysTriggers?.length) {
      report.findings.push({
        resource,
        check: 'anonymous write',
        outcome: 'blocked',
        detail: `ALWAYS-enabled triggers fire in replica mode and may have external effects; write probes skipped: ${table.alwaysTriggers.join(', ')}`,
      });
      report.status = report.status === 'fail' ? 'fail' : 'error';
      continue;
    }
    const relation = `"${table.schema.replaceAll('"', '""')}"."${table.name.replaceAll('"', '""')}"`;
    // Superuser session with replica mode: ordinary triggers (pg_net, webhooks, audit) do not fire.
    // RLS still applies because the probe switches to anon before writing. Everything rolls back.
    const sql = `
BEGIN;
CREATE TEMP TABLE harness_write_results (operation text, result text, affected bigint);
GRANT INSERT ON harness_write_results TO anon;
SET LOCAL session_replication_role = replica;
SELECT count(*) FROM ${relation};
SET LOCAL ROLE anon;
DO $claims$ BEGIN PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true); END $claims$;
DO $probe$
DECLARE op text; stmt text; col text; affected bigint; result text;
BEGIN
  SELECT a.attname INTO col FROM pg_attribute a
    WHERE a.attrelid = ${quote(relation)}::regclass AND a.attnum > 0
      AND NOT a.attisdropped AND a.attgenerated = ''
      AND has_column_privilege('anon', a.attrelid, a.attnum, 'UPDATE')
    ORDER BY a.attnum LIMIT 1;
  FOREACH op IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
    affected := 0;
    IF NOT has_table_privilege('anon', ${quote(relation)}, op) THEN
      result := 'denied';
    ELSE
      stmt := CASE op
        WHEN 'INSERT' THEN ${quote(`INSERT INTO ${relation} DEFAULT VALUES`)}
        WHEN 'UPDATE' THEN CASE WHEN col IS NULL THEN NULL ELSE format('UPDATE %s SET %I = %I', ${quote(relation)}, col, col) END
        ELSE ${quote(`DELETE FROM ${relation}`)} END;
      IF stmt IS NULL THEN
        result := 'indeterminate';
      ELSE
        BEGIN
          EXECUTE stmt;
          GET DIAGNOSTICS affected = ROW_COUNT;
          RAISE EXCEPTION USING ERRCODE = 'ZX001';
        EXCEPTION
          WHEN SQLSTATE 'ZX001' THEN result := CASE WHEN affected > 0 THEN 'allowed' ELSE 'indeterminate' END;
          WHEN insufficient_privilege THEN result := 'denied';
          WHEN OTHERS THEN result := 'indeterminate';
        END;
      END IF;
    END IF;
    INSERT INTO harness_write_results VALUES (op, result, affected);
  END LOOP;
END $probe$;
RESET ROLE;
SELECT count(*) FROM ${relation};
SELECT json_agg(row_to_json(r)) FROM harness_write_results r;
ROLLBACK;`;
    const output = await command(
      'docker',
      [
        'exec',
        `supabase_db_${id}`,
        'psql',
        '-X',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-At',
        '-c',
        sql,
      ],
      options.projectRoot,
    );
    const lines = output.trim().split(/\r?\n/);
    const [before, after, json] = lines.slice(-3);
    const results = JSON.parse(json ?? 'null') as Array<{
      operation: string;
      result: string;
      affected: number;
    }>;
    if (!Array.isArray(results) || before !== after)
      throw new BackendError(
        'Anonymous write probe rollback could not be verified',
      );
    for (const result of results) {
      const failed =
        result.result === 'allowed' || result.result === 'indeterminate';
      report.findings.push({
        resource,
        check: 'anonymous write',
        outcome: failed ? 'fail' : 'info',
        detail: `${result.operation}: ${result.result}; affected ${result.affected}; before/after row counts ${before}/${after}. Replica mode (ordinary triggers suppressed), anon RLS applied; rolled back.`,
      });
      if (failed) report.status = 'fail';
    }
  }
  report.coverage +=
    ' Anonymous writes run as superuser in replica mode inside one rolled-back transaction; tables with ALWAYS-enabled triggers are blocked, not probed. Indeterminate granted writes fail conservatively.';
  return report;
}
