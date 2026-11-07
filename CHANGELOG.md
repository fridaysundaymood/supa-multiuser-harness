# Changelog

## Unreleased

- Develop the local backend harness and independently versioned Kotlin client.
- Verify local schema drift against a fresh migration apply and exercise the debug-only app binding on a fixture build.
- Fix PostgreSQL client argument ordering on Windows for seeding, cron, and status.
- Report occupied Supabase startup ports with a configuration remedy without exposing command output.
- Add a guarded shutdown operation for the local `ak-harness` stack.
