---

name: backend
description: Run synthetic local backend checks.
---

1. Check prerequisites with `backend doctor --json` or `backend_doctor`.
2. Start the local stack with `backend stack up --json` or `backend_stack_up`.
3. Verify migrations with `backend stack verify --json` or `backend_stack_verify`.
4. Run a scenario using `backend run scenario scenario.yaml --json` or `backend_run_scenario` with `file`.
5. Run attack probes using `backend run attacks attacks.yaml --json` or `backend_run_attacks` with `file`.
6. Run race probes using `backend run races races.yaml --json` or `backend_run_races` with `file`.
