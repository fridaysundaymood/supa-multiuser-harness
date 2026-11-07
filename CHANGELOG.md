# Changelog

## Unreleased

- Develop the local backend harness and independently versioned Kotlin client.
- Verify local schema drift against a fresh migration apply and exercise the debug-only app binding on a fixture build.
- Fix PostgreSQL client argument ordering on Windows for seeding, cron, and status.
- Report occupied Supabase startup ports with a configuration remedy without exposing command output.
- Add a guarded shutdown operation for the local `ak-harness` stack.
- Add a file-free local default security suite and a non-overwriting starter for application-specific scenarios.
- Add an opt-in seeded-fixture regression for missing-subject access, disabled RLS, anonymous writes, write rollback, and trigger safety (replica-mode write probes; `ENABLE ALWAYS` trigger tables blocked).
