# Architecture

## System context

```
┌──────────────────────────────────────┐
│  CRM stack                           │
│  GoHighLevel / LeadConnectorHQ       │
│  White-label: Custom CRM Solutions    │
│  crm.example.invalid           │
│  → leads, locations, CRM users       │
└──────────────────┬───────────────────┘
                   │ Vibe talks to CRM
                   │ (not via Custom API)
                   ▼
┌──────────────────────────────────────┐
│  Vibe Dialer (platform)              │
│  e.g. client.example.invalid       │
│  → UX, dialing, CRM orchestration    │
│  → Custom API for durable storage    │
└──────────────────┬───────────────────┘
                   │ HTTPS + Bearer API key
                   ▼
┌──────────────────────────────────────┐
│  Workbench Custom API                 │
│  api.example.invalid                    │
│  MySQL: users, metrics, blobs, …     │
└──────────────────────────────────────┘
```

## What this API stores

| Domain | Tables (conceptual) | Primary endpoints |
|--------|---------------------|-------------------|
| Operators | `users` | `/api/users/*` |
| Location app state | `location_data` | `/api/db/sync` |
| Lead pool | `leads` | `/api/leads/*` |
| Performance | `appointments`, `rewards` | appointments, rewards, stats |
| Schedules | `user_schedules` | schedule endpoints |
| Client telemetry | `system_errors`, `auth_logs` | errors, logs |
| Dialer workspace | `dialer_workspaces` | `/api/sessions/workspace` (Session Harbor) |
| SQL hub | `sql_connections`, `sql_connection_grants`, `sql_table_grants` | admin connections + `/api/sql/*` |
| Security | `api_keys`, `api_login_events`, `api_sentinel_events`, `sentinel_http_envelopes`, `sentinel_forensic_access` | admin Sentinel; public API plus OWL/EAGLE/SONG control-plane signals and root-only redacted evidence |

## Identity model

### Machine (Dialer → API)

- **API key** (`sp_live_…`) identifies the *integration*, not a human.
- Header: `Authorization: Bearer <key>`.
- Multiple keys allowed; revoke per key.

### Operator (agent in Dialer)

- Row in `users` with:
  - `id` — stable Dialer/CRM user id (**use everywhere**)
  - `locationId` — tenant / location scope
  - `crmUserId` / `crmUserName` — CRM linkage
  - `email`, `username`
  - `passwordHash` — dialer password storage (opaque or bcrypt)

**CRM user → Dialer user → API user** is assembled in Vibe:

1. Vibe loads CRM users from Custom CRM / GHL (Vibe’s responsibility).  
2. Vibe upserts into this API (`POST /api/users` or bulk).  
3. Vibe authenticates agents via `POST /api/users/login`.  
4. Vibe records performance with the same `userId`.

This API does **not** need CORS access to Custom CRM for that pipeline.

## Multi-tenancy

Soft multi-tenancy via **`locationId`** on nearly all records. Always scope list/login/stats by location when available.

## Security layers

| Layer | Mechanism |
|-------|-----------|
| Public site | Minimal landing; no admin links |
| Admin portal | Secret path + session + bcrypt |
| Machine API | Hashed multi-keys, rate limits |
| Browser clients | CORS allowlist |
| Observation | Sentinel API traffic + login events |

## Out of scope

- Replacing GHL/Custom CRM APIs  
- Hosting the Dialer UI  
- Email delivery / SMS  
- OAuth to GHL (unless added later)
