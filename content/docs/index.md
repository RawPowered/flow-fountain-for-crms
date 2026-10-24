# Workbench Custom API — Developer Documentation

Authoritative reference for **Vibe Dialer**, AI agents, and API developers integrating with `api.example.invalid`.

This wiki is **login-walled** (admin portal). Share excerpts with partners; do not expose the secret admin URL.

---

## Role of this API

| System | Responsibility |
|--------|----------------|
| **GoHighLevel / LeadConnector / Custom CRM CRM** | Lead source, locations, CRM users, custom values |
| **Vibe Dialer** | Platform: dialing UX, CRM calls, orchestration |
| **Workbench Custom API (this service)** | Durable application data plus a controlled, auditable CRM ingestion gateway |

Workbench exposes only configured and allowlisted CRM operations. It is not an unrestricted proxy to the CRM.

---

## Base URL

```
https://api.example.invalid
```

All machine endpoints live under `/api/*` and require a Bearer API key.

Public (no key):

| Path | Description |
|------|-------------|
| `GET /` | Minimal public landing |
| `GET /health` | Liveness: `{ "ok": true }` |

---

## Documentation map

| Guide | Audience |
|-------|----------|
| [Getting started](getting-started) | First connection, keys, smoke tests |
| [Architecture](architecture) | How Vibe, CRM, and this API fit together |
| [Preservation, exports, and platform sync — Phase 0](preservation-sync-phase-0) | Backup boundaries, security policy, RPO/RTO, retention, and Phase 1 entry criteria |
| [Preservation data inventory](preservation-data-inventory) | Schema-complete classification and initial source catalog |
| [Preservation control plane — Phase 1](preservation-control-plane) | Credential vault, registries, export definitions, jobs, manifests, delivery evidence, and admin API |
| [Preservation execution — Phase 2](preservation-execution-phase-2) | Streaming extraction, CSV/XML/XLSX/SQL renderers, encryption, delivery adapters, scheduling, and lease recovery |
| [Authentication](authentication) | API keys, headers, security rules |
| [AI command help](ai-help) | Machine command catalog, validation, terminal help, and OpenAPI |
| [Users & login](users) | Operators, login, reset password, bulk sync |
| [Location sync](location-sync) | `db/sync` and system config |
| [Session Harbor](sessions) | Per-operator workspace: last contact URL, widget state (not CRM cookies) |
| [SONG](song) | Versioned conditional call scripts, service routing, publication, and runtime analytics |
| [HAWK](hawk) | Private Integration automation graphs, execution history, and safe replay |
| [PARROT](parrot) | Registered Python execution bridge, deployment, HAWK integration, and Sentinel correlation |
| [SQL Connection Hub](sql-connections) | Multi-DB connections, per-key table grants, safe table routing |
| [OWL Operations Console](owl) | Super Admin lead, user, dialer, and schedule operations by key/source/location |
| [EAGLE Executive Lead Intelligence](eagle) | CEO CRM lead geography, funnel, marketing performance, and spreadsheet reporting |
| [CRM ingestion](crm-imports) | Encrypted CRM connections, exhaustive contact sync, backfill, and automatic field discovery |
| [Leads](leads) | Search, assigned queues, bulk import, pull, and dispositions |
| [Performance](performance) | Appointments, rewards, stats |
| [Schedules](schedules) | Per-user and location schedules |
| [Logging](logging) | Client errors and auth log ingest |
| [Sentinel](sentinel) | Security posture and traffic monitoring |
| [Errors & status codes](errors) | Consistent error shapes |
| [Vibe / AI integration](vibe-integration) | Checklist and recommended call order for Vibe AI |
| [CORS & browser clients](cors) | Browser origins and preflight |
| [OpenAPI-style endpoint index](endpoint-index) | Full method/path catalog |

---

## Quick auth example

```http
GET /api/db/sync?locationId=YOUR_LOCATION_ID HTTP/1.1
Host: api.example.invalid
Authorization: Bearer sp_live_YOUR_FULL_API_KEY
Accept: application/json
```

```bash
curl.exe -s -H "Authorization: Bearer sp_live_..." \
  "https://api.example.invalid/api/db/sync?locationId=demo"
```

---

## Conventions

- JSON request/response bodies (`Content-Type: application/json`) unless noted.
- **Never** send or log full API keys in tickets or docs after production issue.
- IDs are opaque strings (often CRM / Dialer UUIDs). Use the **same** `userId` for login, appointments, rewards, and stats.
- `locationId` scopes multi-tenant data. Always pass it when the endpoint requires it.
- Timestamps from MySQL are returned as stored (typically ISO-like strings).

---

## Support checklist for integrators

1. Valid **API key** from the admin portal (shown once at creation).
2. Base URL `https://api.example.invalid` (HTTPS).
3. Browser clients: origin allowed via server `CORS_ORIGINS` (ops concern).
4. Users upserted before relying on password login.
5. Sentinel used to verify traffic after go-live.
