# Bonsai

Bonsai is a multi-tenant, EU-hosted AI customer-service chatbot platform. The
backend is an API-first NestJS service providing schema-per-tenant Postgres
isolation, OIDC authentication, RBAC, API keys, and append-only audit
logging — the compliance-grade foundation the rest of the product builds on.

## Quickstart

Start the local dependencies (Postgres with pgvector, Redis):

```sh
docker compose up -d postgres redis
```

Install dependencies and run the test suites:

```sh
cd api
pnpm install
pnpm test        # unit tests
pnpm test:int    # integration tests (requires Docker for testcontainers)
```

Run the API in watch mode:

```sh
pnpm start:dev
```

## API documentation

Once the API is running, interactive OpenAPI/Swagger docs are served at
[`/docs`](http://localhost:3000/docs).

## Production deployment

`docker compose up -d` builds and runs the full stack — Postgres, Redis, the
API, and Caddy as a TLS-terminating reverse proxy in front of it (see
`Caddyfile` and `docker-compose.yml`). Copy `.env.example` to `.env` and fill
in the OIDC configuration before deploying.

## Documentation

- Design spec: `docs/superpowers/specs/2026-07-08-bonsai-backend-design.md`
- Phase 1 implementation plan: `docs/superpowers/plans/2026-07-08-phase1-platform-foundation.md`
