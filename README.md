# supa-multiuser-harness

**Test apps whose users share data through Supabase: many users, many phones, one local command.**

If your app lets people share lists, projects, or team workspaces, the hard bugs live between users: someone reads data they shouldn't, two phones edit at once and one change is lost, a migration breaks old data. This harness brings up a local Supabase with every migration verified, creates realistic fake users and groups, runs several simulated phones in one test, and attacks your permissions and RPCs.

Part of [android-kit](https://github.com/fridaysundaymood/android-kit), a toolkit combining five tools for end-to-end Android development. Works on its own; no other kit tool required.

## Status

> **Planning stage: there is no code to install yet.** This repo holds the design in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Star or watch it to follow progress. First milestone: local stack manager: verify migrations, reset to an older schema, seed data, migrate forward, and run scheduled jobs in one command.

## Who it's for

- Android developers with a Supabase backend and shared/multi-user data.
- Anyone who wants Row Level Security and race conditions tested automatically, not by hand.

## What it will do

| Part | Details |
|---|---|
| Stack manager | Start local Supabase, prove every migration is applied and the schema matches a fresh apply, test migrations over seeded old data. Refuses to touch remote/linked projects |
| Fixtures | Mint local sign-in tokens; YAML scenarios for users, groups, roles, messages, and aged timestamps |
| Safe app binding | Points debug builds at the local backend and checks the APK before running, so tests never hit production |
| Simulated phones | Scripts like `A goes offline, A adds, B adds, A comes online, sync, assert all phones agree`, including every reconnect order |
| Attack suite | Tampered and expired tokens against every table and RPC, cross-group reads/writes, 30 parallel calls per write RPC, deadlock detection |

Results come as a findings table plus a list of attacks that passed.

## Out of scope

Production-scale load testing and hosting.

## Contributing

The design is open for feedback. Open an issue to question scope, suggest a feature, or discuss an approach before sending a pull request. Use synthetic examples only: no private app code, production data, or credentials.

## License

[MIT](LICENSE)
