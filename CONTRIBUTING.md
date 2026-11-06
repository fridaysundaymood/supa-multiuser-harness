# Contributing

Use Node 24 and Java 21. Install dependencies with `npm ci`; run `npm run lint`, `npm run build`, and `npm test` before submitting. Use only synthetic local fixtures. Never run against a linked project, commit credentials, or use another person's emulator or local stack. Integration tests require Docker and a local Supabase CLI and must clean up their own resources.
