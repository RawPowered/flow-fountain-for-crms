# Endpoint index

Base: `https://api.example.invalid`  
Unless noted, all `/api/*` routes require:

```http
Authorization: Bearer sp_live_...
```

---

## Public

| Method | Path | Auth |
|--------|------|------|
| GET | `/` | None |
| GET | `/health` | None |

---

## AI command discovery

Authenticated machine help for Vibe and API agents. See [AI command help](ai-help).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/help` | JSON command catalog; supports `q`, `category`, and `format=text` |
| GET | `/api/help/{command}` | Exact requirements and example for one command |
| POST | `/api/help/validate` | Validate path/query/body shape without executing |
| GET | `/api/help/openapi.json` | OpenAPI 3.1 document |

---

## PARROT control plane

Session-authenticated administrative routes under `{ADMIN_BASE_PATH}`. See [PARROT](parrot).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `{base}/api/parrot/bootstrap` | Scoped health, catalog, and run history |
| GET | `{base}/api/parrot/health` | Python bridge readiness |
| GET | `{base}/api/parrot/catalog` | Registered Python scripts |
| GET | `{base}/api/parrot/runs` | Scoped PARROT runs |
| GET | `{base}/api/parrot/runs/{id}` | One run with sanitized evidence |
| POST | `{base}/api/parrot/runs` | Manual governed script execution |
| GET | `{base}/api/parrot/imports/schema` | Live Python package schema and CRM field export |
| POST | `{base}/api/parrot/imports/preview` | Validate portable PARROT JSON |
| POST | `{base}/api/parrot/imports/apply` | Import or re-import PARROT drafts |
| GET | `{base}/api/parrot/scripts/{id}/export` | Export one managed script package |

---

## Location / system

| Method | Path | Body / query |
|--------|------|----------------|
| POST | `/api/db/sync` | `{ locationId, payload }` |
| GET | `/api/db/sync` | `?locationId=` |
| GET | `/api/system/config` | — |

---

## SQL Connection Hub

Grant-gated multi-DB table router. **No raw SQL.** See [sql-connections](sql-connections).

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/sql/connections` | Connections + table grants for **this** API key |
| GET | `/api/sql/{slug}/tables` | Granted tables (introspect) |
| GET | `/api/sql/{slug}/tables/{table}/columns` | Column meta |
| GET | `/api/sql/{slug}/{table}` | List rows (`limit`, `offset`, `filter[col]`) |
| GET | `/api/sql/{slug}/{table}/{pk}` | One row |
| POST | `/api/sql/{slug}/{table}` | Insert |
| PUT/PATCH | `/api/sql/{slug}/{table}/{pk}` | Update |
| DELETE | `/api/sql/{slug}/{table}/{pk}` | Delete |

Admin (session): `{ADMIN_BASE_PATH}/connections`

---

## Session Harbor (workspace)

Per-operator dialer continuity. **Does not** store CRM cookies. See [sessions](sessions).

| Method | Path | Body / query |
|--------|------|----------------|
| PUT | `/api/sessions/workspace` | `{ locationId, userId, state, clientTabId?, expectedRevision?, leaseSeconds? }` |
| GET | `/api/sessions/workspace` | `?locationId=&userId=` |
| DELETE | `/api/sessions/workspace` | `locationId`, `userId` (query or body) |
| POST | `/api/sessions/workspace/heartbeat` | `{ locationId, userId, clientTabId?, leaseSeconds? }` |
| GET | `/api/sessions/workspace/resolve-url` | `?locationId=&contactId=` or `?path=` |

---

## Users

| Method | Path | Body / query |
|--------|------|----------------|
| GET | `/api/users` | `?locationId=` |
| POST | `/api/users` | user object |
| POST | `/api/users/bulk` | `{ locationId, users[] }` |
| POST | `/api/users/login` | identity + password/passwordHash |
| POST | `/api/users/reset-password` | locationId, email/userId/username, password/passwordHash |
| GET | `/api/users/:userId` | optional `?locationId=` |
| PUT | `/api/users/:userId` | user fields + locationId |
| PUT | `/api/users/:userId/password` | `{ locationId, passwordHash }` |
| GET | `/api/users/:userId/schedule` | `?locationId=` |
| PUT | `/api/users/:userId/schedule` | `{ locationId, scheduleData }` |
| GET | `/api/users/:userId/stats` | `?locationId=` |

---

## Leads

| Method | Path | Body / query |
|--------|------|--------------|
| GET | `/api/service-pools` | `?locationId=`; authoritative service/tag mappings |
| POST | `/api/service-pools/classify` | `{ locationId, tags }`; resolve without writing |
| GET | `/api/calendars` | `?locationId=`; service calendar catalog |
| GET | `/api/calendars/resolve` | `?locationId=&serviceType=` or `?locationId=&leadId=` |
| GET | `/api/leads` | `X-Operator-Token`; own assignments only; `?locationId=&status=&serviceType=&search=&limit=&offset=` |
| GET | `/api/leads/assigned` | `X-Operator-Token`; active assignments: `?locationId=&userId=&limit=&offset=` |
| GET | `/api/leads/:id` | `X-Operator-Token`; own assigned lead; `?locationId=` |
| POST | `/api/leads/bulk` | `{ locationId, leads[] }` |
| POST | `/api/leads/pull` | `X-Operator-Token`; `{ locationId, userId, serviceType, count? }` |
| POST | `/api/leads/call-attempts/authorize` | `X-Operator-Token`; preferred method: `{ contactId }` |
| POST | `/api/leads/:id/call-attempts/authorize` | `X-Operator-Token`; compatibility alias |
| POST | `/api/leads/:id/dnc-pulse` | `{ locationId, url? }`; discover or issue allowlisted browser pulse |
| POST | `/api/leads/:id/dnc-refresh` | `{ locationId }`; refresh state from current CRM tags |
| PATCH | `/api/leads/:id/status` | `X-Operator-Token`; `{ locationId, status, lastContacted? }` |
| POST | `/api/leads/:id/release` | `X-Operator-Token`; `{ locationId }` |

---

## SONG runtime

| Method | Path | Body / query |
|--------|------|--------------|
| GET | `/api/song/scripts` | `X-Operator-Token`; `?serviceType=&languageCode=&q=&limit=`; published summaries only |
| GET | `/api/song/runtime` | `X-Operator-Token`; `?serviceType=&languageCode?=&scriptId?=&leadId?=` |
| POST | `/api/song/runtime/resolve` | `X-Operator-Token`; `{ serviceType, languageCode?, scriptId?, leadId?, runtimeContext? }` |
| POST | `/api/song/events` | `X-Operator-Token`; append-only runtime event |

---

## CRM ingestion

Integration and location access is grant-gated per API key. LeadConnector PIT credentials are
encrypted on the integration and may be shared by granting multiple Workbench keys access to that
same location-bound integration. See [crm-imports](crm-imports).

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/crm/integrations` | Integrations granted to this key |
| POST | `/api/crm/integrations/:id/test` | Test upstream access |
| GET | `/api/crm/integrations/:id/fields` | Discovered fields |
| POST | `/api/crm/integrations/:id/imports` | Queue dry-run, full, or incremental import |
| GET | `/api/crm/integrations/:id/imports` | Import history |
| POST | `/api/crm/integrations/:id/backfill` | Link existing leads without editing them |
| GET | `/api/crm/imports/:runId` | Import status and counters |
| GET | `/api/crm/imports/:runId/conflicts` | Import conflict audit |

---

## Performance

| Method | Path | Body |
|--------|------|------|
| POST | `/api/appointments` | `{ locationId, leadId, userId, appointmentDate, calendarId? }` |
| POST | `/api/rewards` | `{ locationId, userId, leadId, amount, type }` |

---

## Schedules

| Method | Path | Query / body |
|--------|------|----------------|
| GET | `/api/schedules` | `?locationId=` |

---

## Telemetry

| Method | Path | Body / query |
|--------|------|----------------|
| POST | `/api/errors` | error object with `locationId` and optional `userId`, `username`, `email` |
| GET | `/api/errors` | `?locationId=` |
| DELETE | `/api/errors` | `?locationId=` |
| POST | `/api/logs` | auth log with `locationId` and user identity fields |
| GET | `/api/logs` | `?locationId=` |

---

## Admin portal (session; not for Dialer)

| Area | Path pattern |
|------|----------------|
| Login | `{ADMIN_BASE_PATH}/login` |
| Dashboard | `{ADMIN_BASE_PATH}/` |
| API keys | `{ADMIN_BASE_PATH}/keys` |
| CRM integrations | `{ADMIN_BASE_PATH}/crm-integrations` |
| OWL operations | `{ADMIN_BASE_PATH}/owl` |
| EAGLE executive intelligence | `{ADMIN_BASE_PATH}/eagle` |
| SONG script orchestration | `{ADMIN_BASE_PATH}/song` |
| HAWK automation center | `{ADMIN_BASE_PATH}/hawk` |
| Docs | `{ADMIN_BASE_PATH}/docs` |
| Sentinel | `{ADMIN_BASE_PATH}/sentinel` |

`ADMIN_BASE_PATH` is secret (install / `.env`). Not public.

OWL's admin-session JSON routes are under `{ADMIN_BASE_PATH}/api/owl/*`. They are documented in [OWL Operations Console](owl) and are intentionally excluded from the Bearer-key machine API catalog.

HAWK's admin-session JSON routes are under `{ADMIN_BASE_PATH}/api/hawk/*`. They cover scoped flow
drafts, validation, immutable publication, activation, safe tests, live executions, history, and
replay; see [HAWK automation center](hawk). Private Integration credentials remain server-side.

Service administration uses `/api/owl/service-pools`; lifecycle administration uses
`/api/owl/pool-management`, `/api/owl/pool-rules/{poolKey}`, and `/api/owl/pools/move`. These routes
require a Super Admin session and record mutations in the OWL audit log.
