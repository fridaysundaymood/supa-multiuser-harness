---

name: backend
description: Run synthetic local backend checks.
---

1. Check prerequisites with `backend doctor --json` or `backend_doctor`.
2. Start the local stack with `backend stack up --json` or `backend_stack_up`.
3. Verify migrations with `backend stack verify --json` or `backend_stack_verify`.
4. Run the file-free local security suite with `backend default-suite --json` or `backend_default_suite` (also `backend run attacks --json` / `backend_run_attacks` without `file`). Review informational findings as well as failures. Anonymous write checks use rolled-back transactions; the suite does not prove cross-tenant isolation, all write or RPC authorization, or race correctness.
5. Create an application-specific starter with `backend init-scenario --json` or `backend_init_scenario`; optionally pass a file path (`file` for MCP). The default is `harness-scenario.yaml` and existing files are not overwritten. Adapt it for synthetic data and explicit expectations without committing credentials.
6. Run a scenario using `backend run scenario scenario.yaml --json` or `backend_run_scenario` with `file`.
7. Run explicit attack probes using `backend run attacks attacks.yaml --json` or `backend_run_attacks` with `file`.
8. Run race probes using `backend run races races.yaml --json` or `backend_run_races` with `file`.
9. Stop the verified local stack with `backend stack down --json` or `backend_stack_down`.
