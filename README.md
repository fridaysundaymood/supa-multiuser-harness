# supa-multiuser-harness

A proposed test kit for Android apps whose users share data through a Supabase backend. One command brings up a local Supabase with every migration verified, creates fake users, groups and sign-in tokens, runs several simulated phones against it in one test process, and ships a standard permission (who can read or write what) and race-condition (many simultaneous requests) attack suite.

Part of [android-kit](https://github.com/fridaysundaymood/android-kit/blob/main/IMPLEMENTATION_PLAN.md); usable on its own.

## Status

**Planning only; not implemented yet.** See the [implementation plan](IMPLEMENTATION_PLAN.md).

## Contributing

Contributions to the plan are welcome. Open an issue to discuss substantial changes or submit a pull request with a focused proposal. Use synthetic schemas and fixtures, never real project data or credentials.

## License

[MIT](LICENSE)
