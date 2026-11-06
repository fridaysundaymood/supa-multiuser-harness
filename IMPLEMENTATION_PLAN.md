# Multi-user Backend Harness: implementation plan

## Problem

Testing multi-user synchronization through a Supabase relay can require repeated ad-hoc work:

- A partially applied or unrecorded migration can block subsequent migrations and requires investigation before proceeding.
- Multi-device tests need isolated storage, local test identities, and a debug-only endpoint override; a misconfigured build could otherwise target a remote backend.
- Race and authorization probes are often rewritten for each project.
- Migration safety on representative data is commonly verified by manually seeding an older schema, migrating it, and running scheduled jobs.

## Goal

A reusable harness (CLI + MCP tools + small client libraries) that brings up a verified local backend, creates realistic multi-user fixtures, points app builds at it safely, and ships a standard attack and race suite.

Non-goals: load testing at production scale; hosting.

## Components

### 1. Stack manager
- `stack up`: start Supabase local with configurable service exclusions; wait for health.
- `stack verify`: assert every repo migration is recorded and the schema hash matches a fresh apply into a scratch database; report drift precisely.
- `stack at <version>`: reset to a migration version, then `stack seed <scenario>`, then `stack migrate` to test a migration over live-like data.
- `stack serve-functions`: serve edge functions with a generated env file (no real secrets), returning the URL.
- Never touches a linked/remote project; refuses `--linked`.

### 2. Identity and fixture factory
- `mint_user()` → `{sub, access_jwt, refresh_token}` signed with the local secret (HS256) or a configured local ES256 key.
- Scenario DSL (YAML): users, groups, approvals, roles, keys/epochs, inbox messages, acknowledgements, deletion requests, aged timestamps (`created_at: -400d`).
- Fixtures respect schema constraints (e.g. public-key format checks).

### 3. App binding (safe local pointing)
- Generates a test-only build config overlay (Gradle property file or `BuildConfig` override) for the local URL and anon key; enables cleartext only for `10.0.2.2`/`localhost` in a debug-only network security config overlay.
- Verifies the built APK's `BuildConfig` endpoint before install; refuses to run sync scenarios if it points anywhere non-local.
- Android library `harness-client` for instrumented tests: a simulated device with isolated storage, injected session, and helpers for offline operation, synchronization, and edits.

### 4. Scenario runner
- Multi-phone scripts: `phones: [A, B, C]`, ordered/parallel steps (`A.offline`, `A.add`, `B.add`, `A.online`, `sync all`, `assert converge`).
- Built-in invariants: convergence (same ledger digest on all phones), no lost messages, epoch consistency, removed member isolation.
- Order permutation mode: run the same scenario across all orderings of reconnects (bounded n!).

### 5. Security and race suite
- Role matrix: anon/authenticated/web/service tokens + tampered tokens (alg none, wrong key, expired, wrong aud/iss, missing sub) against every table and RPC discovered from the catalog.
- Cross-tenant authorization: two groups, every cross-group read/write.
- Races: N parallel calls (default 30) per state-changing RPC with invariant checks after; deadlock detection (`40P01`); latency percentiles.
- Cron execution: run scheduled job bodies directly against seeded data.
- Outputs a findings table plus a passed-attacks table.

## MCP tool surface

`stack_up`, `stack_verify`, `stack_at`, `stack_seed`, `stack_migrate`, `mint_user`, `run_scenario`, `run_attack_suite`, `run_races`, `run_cron`.

## Milestones

1. **M1:** stack manager with verify/at/migrate; seed an in-repo synthetic schema at an earlier migration, apply a later migration, and run a scheduled job in one command.
2. **M2:** identity + scenario DSL; synthetic groups with aged timestamps.
3. **M3:** attack and race suite; detect a deliberately vulnerable synthetic schema and pass against its corrected counterpart.
4. **M4:** app binding + simulated device library; run two- and three-device scenarios and an equal-timestamp divergence probe against a synthetic fixture app.
5. **M5:** order-permutation mode and CI integration.

## Testing

- Self-test fixtures: a tiny schema with one known RLS hole and one known race; the suite must find both.
- Regression on the synthetic migration fixtures.

## Risks

- Supabase CLI behavior changes between versions (`--linked` deprecation, agent-mode `--yes`): pin CLI version, wrap calls.
- Simulated phones in one process can miss process-level bugs: keep a two-device mode via Device Lab leases.

## Kit compatibility

This tool is also a component of [android-kit](https://github.com/fridaysundaymood/android-kit/blob/main/IMPLEMENTATION_PLAN.md). From its first milestone it follows the kit composability rules: the shared result schema (`kit-schema`), its own section in `android-kit.yaml`, artifacts under `.android-kit/runs/<run-id>/<tool>/`, prefixed MCP tool names, a library-first design with thin CLI and MCP adapters, and tests against the shared synthetic `kit-fixture-app`.
