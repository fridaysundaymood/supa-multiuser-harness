import {
  type Check,
  type Connection,
  type Probe,
  type RequestSpec,
  runAttacks,
} from './suites.js';

export interface AutomaticResourcePolicy {
  /** OpenAPI path, e.g. /tasks or /rpc/search_tasks. */
  path: string;
  /** Explicit request and expected outcome for every actor being tested. */
  roles: Array<{
    actor: string;
    request: Omit<RequestSpec, 'actor'>;
    checks: Check[];
  }>;
  /** A safe request against this resource used to test rejected credentials. */
  credentialRequest: Omit<RequestSpec, 'actor'>;
  /** Signed expired JWTs for the same actors, obtained from the local auth configuration. */
  expiredTokens: Record<string, string>;
  /** Requests targeting another group's synthetic fixtures and their expected outcomes. */
  crossGroup: Array<{ name: string; request: RequestSpec; checks: Check[] }>;
}

export interface AutomaticAttackOptions {
  connection: Connection;
  policies: AutomaticResourcePolicy[];
}

/** Discover exposed resources and exercise only explicitly described, synthetic requests. */
export async function runAutomaticAttacks(options: AutomaticAttackOptions) {
  const discovery = await runAttacks({
    connection: options.connection,
    probes: [],
  });
  const resources = [
    ...discovery.discovered.tables.map((name) => `/${name}`),
    ...discovery.discovered.rpcs.map((name) => `/rpc/${name}`),
  ];
  const fail = (reason: string) => ({
    ...discovery,
    status: 'error' as const,
    coverage: reason,
  });
  if (!resources.length)
    return fail('Discovery failed or exposed no resources.');
  const policies = new Map(
    options.policies.map((policy) => [policy.path, policy]),
  );
  if (
    policies.size !== options.policies.length ||
    resources.some((path) => !policies.has(path)) ||
    options.policies.some((policy) => !resources.includes(policy.path))
  )
    return fail(
      'Every discovered resource requires exactly one explicit policy.',
    );

  const actors = Object.keys(options.connection.tokens);
  const tokens = { ...options.connection.tokens };
  const probes: Probe[] = [];
  for (const resource of resources) {
    const policy = policies.get(resource);
    if (!policy) return fail(`Missing policy for ${resource}.`);
    const expectedPath = `/rest/v1${resource}`;
    const matches = (path: string) => path.split('?')[0] === expectedPath;
    if (
      !actors.length ||
      policy.roles.length !== actors.length ||
      new Set(policy.roles.map((role) => role.actor)).size !== actors.length ||
      actors.some(
        (actor) => !policy.roles.some((role) => role.actor === actor),
      ) ||
      !policy.crossGroup.length ||
      !matches(policy.credentialRequest.path) ||
      policy.roles.some(
        (role) => !matches(role.request.path) || !role.checks.length,
      ) ||
      policy.crossGroup.some(
        (fixture) =>
          !matches(fixture.request.path) ||
          !fixture.checks.length ||
          !actors.includes(fixture.request.actor),
      )
    )
      return fail(`Incomplete policy for ${resource}.`);
    for (const role of policy.roles) {
      const token = tokens[role.actor];
      const expired = policy.expiredTokens[role.actor];
      const parts = token?.split('.');
      const expiredParts = expired?.split('.');
      let expiration: unknown;
      try {
        if (expiredParts?.length === 3 && expiredParts.every(Boolean)) {
          const payload: unknown = JSON.parse(
            Buffer.from(expiredParts[1] ?? '', 'base64url').toString(),
          );
          if (payload && typeof payload === 'object' && 'exp' in payload)
            expiration = payload.exp;
        }
      } catch {
        expiration = undefined;
      }
      if (
        parts?.length !== 3 ||
        parts.some((part) => !part) ||
        !expired ||
        expired === token ||
        typeof expiration !== 'number' ||
        !Number.isFinite(expiration) ||
        expiration >= Date.now() / 1000
      )
        return fail(
          `A JWT and distinct expired JWT are required for ${resource}.`,
        );
      const tamperedActor = `__automatic_${probes.length}_tampered`;
      const expiredActor = `__automatic_${probes.length}_expired`;
      if (tamperedActor in tokens || expiredActor in tokens)
        return fail('Reserved actor name collision.');
      const signature = parts[2];
      if (!signature) return fail('JWT signature is missing.');
      parts[2] = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
      tokens[tamperedActor] = parts.join('.');
      tokens[expiredActor] = expired;
      probes.push(
        {
          name: `${resource}: role ${role.actor}`,
          request: { ...role.request, actor: role.actor },
          checks: role.checks,
        },
        {
          name: `${resource}: tampered JWT ${role.actor}`,
          request: { ...policy.credentialRequest, actor: tamperedActor },
          checks: [{ kind: 'status', equals: 401 }],
        },
        {
          name: `${resource}: expired JWT ${role.actor}`,
          request: { ...policy.credentialRequest, actor: expiredActor },
          checks: [{ kind: 'status', equals: 401 }],
        },
      );
    }
    for (const fixture of policy.crossGroup)
      probes.push({
        name: `${resource}: cross-group ${fixture.name}`,
        request: fixture.request,
        checks: fixture.checks,
      });
  }
  const report = await runAttacks({
    connection: { ...options.connection, tokens },
    probes,
  });
  return {
    ...report,
    coverage:
      'Role, tampered and expired JWT, and explicit cross-group probes for every discovered resource.',
  };
}
