# Multi-user Backend Harness: implementation plan

## Problem

Testing multi-user synchronization through a Supabase relay requires repeatable local migrations, isolated identities and devices, and authorization and race probes. A misconfigured test build must not reach a remote backend.

## Goal and status

Implement a reusable harness for verified local Supabase backends, synthetic multi-user fixtures, safely bound Android test builds, and authorization and race scenarios. Production-scale load testing and hosting are out of scope. Clean and defective fixture integration has run against a local stack; see milestone status below for remaining verification.

## Architecture and contracts

Implement a TypeScript core library on Node.js LTS, distributed as an npm package. A CLI exposes every operation; a thin MCP adapter exposes the same operations as tools over stdio. No MCP client-specific feature is required; optional MCP features degrade gracefully.

Every CLI command supports `--json` and emits the kit-schema v1 envelope: `{ schema_version: "1", tool, operation, run_id, status, classification?, summary, evidence[], artifacts[], started_at, duration_ms }`. CLI exits are 0 for pass, 1 for fail/flaky, and 2 for error/blocked/unsupported. Evidence and artifacts must not contain credentials or tokens.

Read only the optional `backend` section of `android-kit.yaml`, validated using its published JSON Schema; reject unknown keys and never require another tool's section. Store run artifacts under `.android-kit/runs/<run-id>/backend/`. Publish plain Markdown skills with `SKILL.md` frontmatter and an `AGENTS.md` snippet; every skill step names CLI and equivalent MCP tool.

## Components

### Stack manager

- `backend stack up` starts local Supabase with configurable exclusions and health checks.
- `backend stack verify` checks recorded migrations and compares normalized schema dumps from target and fresh scratch apply; retain a readable diff on mismatch.
- `backend stack at <version>`, `backend stack seed <scenario>`, `backend stack migrate`, `backend stack serve-functions`, and `backend run cron` perform local operations.
- Refuse linked or remote projects before mutation. Verify local stack identity and endpoint on every destructive operation.

### Identity and fixture factory

- `backend mint-user` obtains local credentials and signing capabilities from Supabase status. Support HS256 and current asymmetric local signing keys, both legacy and publishable/secret API-key families. Never use opaque keys as signing secrets. Return unsupported with remedy when capability is absent. Obtain refresh tokens only through real local auth.
- YAML scenarios define synthetic users, groups, roles, keys, messages and aged timestamps. Keep secrets in memory, redact output, clean temporary files.

### App binding

- Generate test-only Gradle configuration overlay and debug-only network security config for local emulator/host access.
- The independently versioned Kotlin/JVM `harness-client` guard checks actual client endpoint before requests and rejects non-local endpoints. Integrations must route app test requests through the guard; refuse scenarios if this cannot be established.
- APK dex scan is secondary diagnostic, not proof; R8/dynamic strings may evade detection.
- Provide simulated devices with isolated storage, injected sessions, offline operation and sync.

### Scenario, security and race runners

- `backend run scenario` executes ordered or parallel multi-phone steps, checks convergence and member isolation. Bounded reconnect permutations report total, executed and truncation.
- `backend run attacks` probes discovered tables/RPCs with explicit role, tampered/expired JWT and cross-group expectations.
- `backend run races` performs configurable parallel state-changing RPC calls; records seeds, attempts, inputs, ordering, invariant checks, deadlocks and latency percentiles. Seeds do not control thread scheduling; intermittent failures are flaky.

## MCP tool surface

`backend_doctor`, `backend_stack_up`, `backend_stack_verify`, `backend_stack_at`, `backend_stack_seed`, `backend_stack_migrate`, `backend_stack_serve_functions`, `backend_mint_user`, `backend_run_scenario`, `backend_run_attacks`, `backend_run_races`, `backend_run_cron`, each with CLI equivalent.

1. **M1:** core, CLI, MCP, schema/config, doctor and guidance implemented. Live fixture migration verification passed for the clean schema and detected an intentional schema drift; seed/migrate/cron code remains to be exercised end to end.
2. **M2:** scenario DSL and JWT signing detection implemented; real auth flow supported. Signing unit coverage passes; local identity/API-key family integration remains unverified.
3. **M3:** configurable role/tamper/expiry/cross-group probes and race runner implemented. Live clean fixture passes; defects migration detected cross-board disclosure and lost updates.
4. **M4:** debug runtime guard, APK dex scan and versioned Kotlin client implemented. A disposable guarded fixture passed its debug transport JVM test and built a minified debug APK and R8 release APK. The debug DEX scan found the local endpoint and external URL candidates; the release scan found no local endpoint. No device was available for instrumentation. DEX findings are diagnostic only.
5. **M5:** bounded permutation reporting and cross-platform CI implemented. CI matrix itself not run.

## Kit compatibility

Stack stopped with `--no-backup`; `docker ps -a --filter name=ak-harness` returned no containers.

Verified: lint/build and 23 TypeScript tests pass; 5 standalone JVM tests pass; 2 live JVM integration tests pass on clean fixture. Defect integration detected both seeded issues.
