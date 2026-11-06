# supa-multiuser-harness

A planned local test harness for apps whose users share data through Supabase. It will verify migrations, create synthetic users and groups, run multi-device scenarios, and probe authorization and race conditions.

Part of [android-kit](https://github.com/fridaysundaymood/android-kit); usable independently through a CLI or any MCP client, including in CI.

## Status

**Planning stage: there is no code to install yet.** See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the design and milestones. The first milestone covers a local stack manager, migration verification and scheduled-job execution.

## Planned components

| Part | Details |
|---|---|
| Stack manager | Start local Supabase, compare normalized schema dumps, and test migrations over seeded data; refuse remote and linked projects |
| Fixtures | Create synthetic users and local sign-in credentials, supporting detected legacy and current local signing configurations |
| Safe app binding | Use a debug-only runtime guard to reject non-local endpoints, with a secondary APK dex string scan |
| Simulated phones | Run offline, sync and convergence scenarios, with reconnect permutations bounded by a configurable cap |
| Security and races | Exercise authorization and RPCs; repeat races with recorded seeds and failing attempts |

The core, CLI and thin stdio MCP adapter are planned in TypeScript on Node.js LTS, distributed via npm. The Android `harness-client` is a separate, independently versioned Kotlin Gradle artifact. MCP tools use the `backend_*` prefix; CLI commands provide the same operations and JSON results.

## Out of scope

Production-scale load testing and hosting.

## Contributing

The design is open for feedback. Use synthetic examples only: no private app code, production data, or credentials.

## License

[MIT](LICENSE)
