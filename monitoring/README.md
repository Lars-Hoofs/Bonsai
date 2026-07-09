# Bonsai monitoring (self-hosted, free)

Prometheus + Grafana, both open-source, running in `docker-compose.yml` on your
own VPS. No paid service. Prometheus scrapes the API's `/metrics`; Grafana shows
usage, errors, latency and resource dashboards.

## Setup (one time)

1. Pick a long random token and put the **same** value in two places:
   - `.env` → `METRICS_TOKEN=...`
   - `monitoring/prometheus/prometheus.yml` → `credentials: ...`
2. Set `GRAFANA_ADMIN_PASSWORD` in `.env`.

## Run

```bash
docker compose up -d api prometheus grafana
```

- **Grafana:** http://<host>:3001 — log in as `admin` / `GRAFANA_ADMIN_PASSWORD`.
  The Prometheus datasource and the **Bonsai — Overview** dashboard are
  auto-provisioned (folder "Bonsai").
- **Prometheus:** http://<host>:9090 (targets, ad-hoc queries).

> In production, keep 9090/3001 behind your firewall or the Caddy reverse proxy;
> only Grafana needs to be reachable by you.

## What you get

The dashboard reads these app metrics (all prefixed `bonsai_`), plus default
Node/process metrics:

| Metric | Shows |
|---|---|
| `bonsai_answers_total{refused}` | answers/min, refusal rate |
| `bonsai_escalations_total` | hand-offs to a human |
| `bonsai_http_request_duration_seconds` | request rate, 5xx errors, p50/p95/p99 latency |
| `bonsai_ingestion_total{status}` | knowledge ingestion successes/failures |
| `bonsai_rate_limit_blocked_total` | throttled requests |
| `bonsai_llm_calls_total`, `bonsai_embedding_calls_total` | AI call volume |
| `process_*`, `nodejs_*` | CPU, memory (RSS), event-loop lag |

Add your own panels/queries in Grafana; changes persist in the `grafana_data`
volume. Alerting can be added later (Grafana or Prometheus Alertmanager) — also
free and self-hosted.
