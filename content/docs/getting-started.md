# Getting started

## Prerequisites

- Node app live at your Custom API host (e.g. `https://api.example.invalid`)
- Install completed (MySQL connected)
- At least one **API key** created in the admin portal

## 1. Obtain an API key

1. Sign in to the **secret admin URL** (from install / `.env` `ADMIN_BASE_PATH`).
2. Open **API Keys** → **Generate**.
3. Copy the full secret once (`sp_live_…`). It is not shown again.
4. Paste into Vibe Dialer **Operations → Custom API Key** (or equivalent).

Revoke compromised keys immediately and create a new one.

## 2. Configure the Dialer / client

| Setting | Value |
|---------|--------|
| Custom API base URL | `https://api.example.invalid` |
| Custom API key | Full `sp_live_…` secret |
| Auth header | `Authorization: Bearer <key>` |

Do **not** use the old single-env `API_KEY` model. Keys live in MySQL and are multi-key capable.

## 3. Health check

```http
GET /health
```

```json
{ "ok": true }
```

No API key required. Does not expose install state or product internals.

## 4. Authenticated smoke test

```http
GET /api/db/sync?locationId=YOUR_LOCATION_ID
Authorization: Bearer sp_live_...
```

| Result | Meaning |
|--------|---------|
| `200` + `{ "payload": null }` | Key valid; no blob stored yet |
| `200` + `{ "payload": "..." }` | Key valid; data present |
| `401` `{ "error": "Unauthorized" }` | Bad/missing/revoked key |
| Browser CORS error | Origin not allowlisted (see [CORS](cors)) |

## 4.1 Discover available commands

```http
GET /api/help?format=text
Authorization: Bearer sp_live_...
```

Use `GET /api/help/{command}` for exact requirements and `POST /api/help/validate` before executing a new command. See [AI command help](ai-help).

## 5. Minimal integration sequence (Vibe)

Recommended order after an agent opens a location:

1. `POST /api/users` or `POST /api/users/bulk` — upsert CRM-linked operators  
2. `POST /api/users/login` — verify dialer password when using stored credentials  
3. `GET/POST /api/db/sync` — load/save location app state  
4. Performance: `POST /api/appointments`, `POST /api/rewards`, `GET /api/users/:id/stats`  
5. Optional: `POST /api/logs` for client auth telemetry (also feeds Sentinel)

## 6. Verify with Sentinel

Admin → **Sentinel**:

- API events should show `200` for your paths  
- Login events should show `login` success/failure after `POST /api/users/login`

## Environment (operators only)

Integrators usually do not need server env access. Operators set:

| Variable | Purpose |
|----------|---------|
| `CORS_ORIGINS` | Browser Dialer origins, e.g. `https://client.example.invalid` |
| `ADMIN_BASE_PATH` | Secret admin UI path |
| `DB_*` | MySQL |

See install docs / `.env.example` on the server for the full list.
