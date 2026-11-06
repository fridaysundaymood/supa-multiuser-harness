# Multi-user Backend Harness: implementation plan

## Problem

Testing multi-user synchronization through a Supabase relay requires repeatable local migrations, isolated identities and devices, and authorization and race probes. A misconfigured test build must not reach a remote backend.

## Goal and status

Plan a reusable harness for a verified local backend, synthetic multi-user fixtures, safely bound Android test builds, and authorization and race scenarios. This repository is planning-only; none of the commands or artifacts below exists yet. Production-scale load testing and hosting are out of scope.

## Architecture and contracts

Implement a TypeScript core library on Node.js LTS, distributed as an npm package. A CLI exposes every operation; a thin MCP adapter exposes the same operations as tools over stdio. No MCP client-specific feature is required; optional features such as progress and elicitation degrade gracefully. The CLI works independently in a shell or CI; Bun is optional.

Every CLI command supports `--json` and emits the `kit-schema` v1 JSON Schema package envelope: `{ schema_version: "1", tool, operation, run_id, status: pass|fail|flaky|blocked|unsupported|error, classification?: app|test|environment|config, summary, evidence[], artifacts[], started_at, duration_ms }`. `fail` means the thing under test failed; `error` means the tool itself failed; `blocked` means a precondition or policy refused the operation; `unsupported` means a capability is unavailable, never silently skipped. CLI exits are 0 for pass, 1 for fail or flaky, and 2 for error, blocked, or unsupported. Evidence and artifacts must not contain credentials or tokens.

Read only the optional `backend` section of `android-kit.yaml`, validated using its published JSON Schema; reject unknown keys and never require another tool's section. Store run artifacts under `.android-kit/runs/<run-id>/backend/`. Publish plain Markdown skills with `SKILL.md` frontmatter and an `AGENTS.md` snippet; every skill step names both its CLI command and equivalent MCP tool, without assuming any agent product.

## Components

### Stack manager

- `backend stack up`: start local Supabase with configurable service exclusions and wait for health.
- `backend stack verify`: confirm every repository migration is recorded, then compare normalized schema dumps from the target and a fresh scratch apply. Normalize known nondeterministic dump metadata without removing schema semantics; retain a readable diff as evidence on mismatch.
- `backend stack at <version>`, `backend stack seed <scenario>`, and `backend stack migrate`: reset to a migration, seed synthetic data, then migrate forward. `backend stack serve-functions` serves functions using a generated local-only environment file; `backend run cron` executes scheduled job bodies against seeded data.
- Refuse linked or remote projects, including `--linked`, before any mutation. Verify the local stack identity and endpoint on every destructive operation; do not rely on a caller-supplied claim that a project is local.

### Identity and fixture factory

- `backend mint-user` obtains local credentials and signing capabilities from `supabase status` for the running stack, never from hardcoded secrets or keys. Support legacy HS256 JWT secrets and current local asymmetric signing keys, selecting an available supported algorithm and key from the detected local configuration. Support both legacy anon/service JWTs and current publishable/secret API key formats as API keys; do not treat opaque API keys as JWT signing secrets. If signing material or a compatible local auth flow is unavailable, return `unsupported` with a remedy rather than fabricate a token. Obtain a refresh token only through a real local auth flow; otherwise report it unavailable.
- YAML scenarios define synthetic users, groups, roles, keys, messages and aged timestamps; fixtures respect schema constraints. Keep secrets in memory where possible, redact output and clean up temporary files.

### App binding

- Generate a test-only Gradle configuration overlay for the local URL and API key and a debug-only network security configuration for local emulator/host access.
- The separate Kotlin/JVM Android `harness-client` Gradle artifact has its own semver and release lifecycle. Its debug-only runtime guard checks the actual endpoint used by the client before any request and refuses non-local endpoints; release builds cannot enable the test override. The guard handles approved emulator host aliases and loopback explicitly, not arbitrary remote hosts. Integration requires routing the app's test client through the guard; refuse scenarios when that integration cannot be established.
- Scan APK dex strings for non-local endpoint candidates as a secondary diagnostic, not proof of safety: R8 may inline constants or construct strings dynamically. Do not use `BuildConfig` inspection as the safety gate.
- Provide instrumented-test simulated devices with isolated storage, injected sessions, offline operation, synchronization and edits.

### Scenario, security and race runners

- `backend run scenario` executes ordered or parallel multi-phone steps and checks convergence, message retention, epoch consistency and removed-member isolation. Permutation mode explores reconnect orderings only up to a configurable `max-orderings` cap; report the total, executed orderings and any truncation explicitly rather than claiming exhaustive coverage.
- `backend run attacks` exercises discovered tables and RPCs with role matrices, tampered or expired JWTs and cross-group reads and writes; record passed and failed probes.
- `backend run races` makes configurable parallel calls to state-changing RPCs with invariant checks and deadlock detection. Configurable repeat counts and seeds are recorded with each attempt; report the failing attempt, seed, inputs and ordering where observable so it can be rerun. A seed does not guarantee reproduction of thread scheduling. Report latency percentiles and distinguish intermittent failures as `flaky`.

## MCP tool surface

`backend_doctor`, `backend_stack_up`, `backend_stack_verify`, `backend_stack_at`, `backend_stack_seed`, `backend_stack_migrate`, `backend_stack_serve_functions`, `backend_mint_user`, `backend_run_scenario`, `backend_run_attacks`, `backend_run_races`, `backend_run_cron`. Each has the equivalent CLI operation described above, including `backend doctor`.

## Production readiness

- Support Windows, macOS and Linux. On Windows, require Docker Desktop with a working WSL2 backend; document installation, integration and filesystem caveats. Doctor checks the Docker engine is running and reachable, the Supabase CLI is in the supported `>=2.0.0 <3.0.0` range, and the required Node.js LTS, Android SDK/adb, Java and Gradle versions match declared supported ranges; report missing or incompatible prerequisites and actionable fixes. Pin exact versions in CI and declare the verified ranges in release documentation; gate unsupported CLI behaviors by capability detection.
- Use semver and maintain a CHANGELOG for the npm package and independently versioned Gradle artifact. Plan SECURITY.md and CONTRIBUTING.md in M1.
- CI runs unit tests on all three operating systems and local-stack, Android and migration integration tests wherever the required Docker and emulator capabilities are available; unavailable coverage is reported, not silently passed.
- Emit structured, secret-redacted logs. Track run state and owned resources for crash or interrupt recovery; cleanup and reruns are idempotent and never remove resources not owned by the run. No telemetry.

## Milestones and testing

1. **M1:** core, CLI, MCP adapter, schema/config contracts, doctor, security and contribution guidance; verify migrations, seed an earlier synthetic schema, migrate and run a scheduled job. Exercise normalized diffs and remote/linked refusal.
2. **M2:** local identity detection and scenario DSL; cover legacy and asymmetric signing, both API key families, unavailable credentials and secret redaction.
3. **M3:** authorization and race suites; detect deliberately vulnerable synthetic fixtures and pass their corrected counterparts. Test configurable repetitions, seeds and attempt reporting.
4. **M4:** debug runtime guard, secondary dex scan and independently versioned client artifact; test local and non-local endpoint rejection, R8 builds, and two- and three-device scenarios.
5. **M5:** bounded permutation mode and CI integration; test the cap and explicit partial-coverage reporting.

Simulated devices in one process can miss process-level bugs; provide a separate two-device mode using an optional device provider, without requiring another kit tool. Test interruption and rerun recovery across milestones.

## Kit compatibility

This tool can be composed by [android-kit](https://github.com/fridaysundaymood/android-kit/blob/main/IMPLEMENTATION_PLAN.md) as a TypeScript library and tested against the shared synthetic fixture app. It remains usable independently through the CLI or any MCP client.
