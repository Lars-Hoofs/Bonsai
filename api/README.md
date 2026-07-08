# Bonsai API

The Bonsai multi-tenant chatbot backend API: a NestJS service providing
schema-per-tenant Postgres isolation, OIDC authentication, RBAC, API keys,
and append-only audit logging.

## Running tests

```sh
pnpm test        # unit tests
pnpm test:int    # integration tests (requires Docker for testcontainers)
```

## Running in development

```sh
pnpm start:dev
```

## Running migrations

```sh
pnpm build
pnpm migrate     # applies pending control-plane migrations
```

Control-plane migrations also run automatically at application boot
(`src/main.ts`), so this is primarily useful as an explicit predeploy step.

## More documentation

See the repo-root [`README.md`](../README.md) for the full quickstart, and
`docs/superpowers/specs` / `docs/superpowers/plans` for the design spec and
implementation plan.
