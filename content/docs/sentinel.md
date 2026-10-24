# Sentinel monitoring & OpSec response

Sentinel is the **OpSec console** for operators (admin portal session). Integrators do not call it with the Dialer API key.

Open: **`{ADMIN_BASE_PATH}/sentinel`**

After upgrading: `npm run migrate` (schema 25 adds short-lived encrypted HTTP evidence and its access ledger).

---

## OpSec doctrine

1. **Human-in-the-loop by default** — detect and queue; block when an admin confirms (custom rules may opt into auto-block).
2. **Blocklist applies to `/api/*` only** — admin portal uses its own session + optional `ADMIN_IP_ALLOWLIST`.
3. **Generic deny** — blocked clients receive `403 { "error": "Forbidden" }` (no “you are blacklisted” message).
4. **No secrets** in events, cases, exports, or forensic evidence (passwords, full API keys, tokens, credentials, and cookies are redacted before encryption).
5. **RDAP/WHOIS is best-effort** — server-side, cached; never on the hot request path.

---

## Console tabs

| Tab | Purpose |
|-----|---------|
| **Posture** | Score 0–100, grade, KPIs (incl. review backlog + new first-fail IPs), chart, recommended actions |
| **Threats** | Live findings — Investigate, View case, WHOIS, Block IP |
| **Review** | Durable threat **cases** — mark review / watch / dismiss / block with audit trail |
| **New IPs** | First-contact IPs whose first API hit was auth failure (401/403) |
| **Blocks** | IP blocklist CRUD (enforced before API key auth) |
| **Rules** | Custom flagging rules (safe condition builder, no raw SQL) |
| **Logins** | Filterable operator login / reset / auth_log events |
| **Traffic** | Filterable public API and OWL/EAGLE/SONG/admin request log with actor, action, outcome, per-key stats, top paths, status histogram, and root-only evidence drill-down |
| **Investigate** | Unified login + API timeline; WHOIS + Block for filtered IP |

### Command bar

- **Window:** 1h / 6h / 24h / 3d / 7d  
- **Auto-refresh:** Off / 15s / 30s / 60s  
- **Export:** CSV for threats, cases, blocks, new-ips, logins, API events; copy markdown IR report  

---

## What it observes

### A. API traffic (`api_sentinel_events`)

Sentinel covers every public `/api/*` request and every request entering the secret admin control plane. The searchable event tier records the normalized surface, admin/operator actor, action, opaque entity reference, outcome, HTTP status, latency, IP, and request ID needed for incident correlation.

Control-plane surfaces are `owl`, `eagle`, `song`, `admin`, and `sentinel`. The logger captures the internal mounted route before Express restores the outer URL, so the secret `ADMIN_BASE_PATH` is never persisted. Dynamic route identifiers are replaced with `:id` in the path and retained only as bounded opaque `entity_id` values when useful.

The searchable `api_sentinel_events` tier never stores request bodies, query strings, response bodies, CRM records, script prompts, demographic values, credentials, API keys, cookies, or CSV contents. OWL and SONG mutation audits remain separate operational records.

Every `/api/*` request: method, path, status, duration, key prefix, IP, UA, locationId, error class (`unauthorized`, `blocked`, `rate_limit`, …).

### B. Login security (`api_login_events`)

| Source | event_type |
|--------|------------|
| `POST /api/users/login` | `login` |
| `POST /api/users/reset-password` | `password_reset` |
| `POST /api/logs` | `auth_log` |

### C. IP sightings (`sentinel_ip_sightings`)

First-seen / last-seen per IP, first path/status, auth-fail vs success counters — powers **New IPs** radar.

### D. HTTP forensic evidence (`sentinel_http_envelopes`)

Recent events may have a separately stored request/response envelope. The Traffic table exposes **Inspect** only to the root administrator. A reveal requires an investigation purpose of at least eight characters and writes an append-only row to `sentinel_forensic_access`.

The envelope contains request and response headers, JSON or plain-text payloads, content types, byte counts, truncation state, and the request correlation ID. Before storage Sentinel:

- redacts authorization, cookies, API keys, credentials, passwords, secrets, tokens, and common contact PII;
- omits HTML, CSV, multipart, binary, and unknown body types;
- omits bodies larger than `SENTINEL_FORENSIC_MAX_BODY_BYTES` rather than retaining a potentially sensitive prefix;
- encrypts the redacted envelope using AES-256-GCM;
- signs the plaintext envelope and request ID with HMAC-SHA-256 and verifies it before every reveal;
- expires evidence independently after `SENTINEL_FORENSIC_RETENTION_DAYS` (seven days by default).

The six drawer views are Overview, Request headers, Request payload, Response headers, Response payload, and Integrity. Copy exports only the currently displayed redacted view. IP and path pivots open the existing correlated Investigate timeline.

This design follows useful federal audit principles without claiming certification: AU-2/AU-3 event content, AU-9 protection of audit information, AU-11 bounded retention, AC-6 least privilege, and SI-4 monitoring. Controls are implemented as data minimization, separation of metadata and evidence, root-only need-to-know access, mandatory purpose, integrity verification, correlation IDs, and access auditing.

---

## Threat rules (server-side)

| Rule | Severity (typical) | Trigger |
|------|--------------------|---------|
| `login_fail_ip` | high/critical | ≥5 login failures / IP / 1h |
| `login_fail_identity` | high/critical | ≥5 failures / identity / 1h |
| `login_spray` | critical | ≥3 identities + ≥6 fails from one IP / 1h |
| `api_key_spray` | high/critical | ≥10 HTTP 401 / IP / 1h |
| `api_error_spike` | medium/high | ≥30% errors with ≥20 requests in window |
| `password_reset_burst` | medium | ≥5 password_reset / IP / 1h |
| `new_path_errors` | low/medium | Path with high error ratio |
| `slow_api` | low | Latency samples ≥2000ms |
| `first_auth_fail_ip` | medium/high | New IP, first contact auth-fail, 0 successes |
| `custom:{id}` | as configured | Admin custom rules |
| `control_plane_denied` | high/critical | Repeated denied OWL/EAGLE/SONG/admin requests by IP and surface |
| `anonymous_control_write` | critical | Any successful control-plane mutation without an admin principal |
| `eagle_export_burst` | medium/high | Three or more full EAGLE lead exports per actor in one hour |

High/critical findings (and selected medium) are **synced into Review cases** (deduped by fingerprint). Dismissed cases are not re-opened for 24h unless severity escalates to critical.

### Posture score

Starts at 100; penalties for critical/high/medium findings, API error rate, 401 rate, login fail rate, unreviewed critical cases, new first-fail IP volume.

| Score | Grade |
|-------|--------|
| 90–100 | healthy |
| 70–89 | watch |
| 40–69 | elevated |
| 0–39 | critical |

---

## Response controls

### IP blocklist

- Admin **Blocks** tab or one-click from Threats / New IPs / Investigate / case detail.
- Enforced by `ipBlockGate` **before** rate-limit and API key auth.
- Sources: `manual` | `threat_case` | `auto_rule`.
- Optional expiry; revoke anytime.
- Blocked attempts are still logged (`error_class=blocked`) for visibility.

### Threat cases (Review)

| Status | Meaning |
|--------|---------|
| `open` | Auto-created / needs attention |
| `under_review` | Analyst is working it |
| `watching` | Keep visible without blocking |
| `blocked` | Linked IP was blocked |
| `dismissed` | Not action-worthy (cooldown before re-open) |

Every transition writes `sentinel_case_actions` audit rows.

### Custom rules

Safe JSON conditions only:

- `source`: `api` | `login` | `either`
- `groupBy`: `ip` | `identity` | `path`
- `minCount`, `windowMinutes`
- optional: `statusCode`, `outcome`, `pathContains` / `pathPrefix`, `method`, `errorClass`

Actions: create case (default); optional **auto-block** IP for 24h (off by default).

### New first-fail IPs

An IP whose **first recorded sighting** was HTTP 401/403 (or blocked). Highlighted while still new in the selected window. Prefer review over auto-block on shared NAT egress.

### WHOIS / RDAP

`GET {base}/api/sentinel/intel/:ip` — server queries RDAP (`rdap.org`), caches ~7 days. UI drawer from Threats, Review, New IPs, Investigate.

---

## Admin JSON APIs (session + admin role)

| Method | Path |
|--------|------|
| GET | `{base}/api/sentinel/summary?hours=24` |
| GET | `{base}/api/sentinel/threats?hours=24` |
| POST | `{base}/api/sentinel/threats/sync` |
| GET | `{base}/api/sentinel/events?...` |
| GET | `{base}/api/sentinel/capabilities` |
| POST | `{base}/api/sentinel/events/:id/evidence` (root only; body `{ "reason": "..." }`) |
| GET | `{base}/api/sentinel/forensic-access` (root only) |
| GET | `{base}/api/sentinel/logins?...` |
| GET | `{base}/api/sentinel/timeline?...` |
| GET | `{base}/api/sentinel/cases` |
| GET | `{base}/api/sentinel/cases/:id` |
| POST | `{base}/api/sentinel/cases/:id/review\|dismiss\|watch\|block\|note` |
| GET/POST/DELETE | `{base}/api/sentinel/blocks` … |
| GET/POST/PUT/DELETE | `{base}/api/sentinel/rules` … |
| GET | `{base}/api/sentinel/new-ips?hours=24` |
| GET | `{base}/api/sentinel/intel/:ip` |
| GET | `{base}/api/sentinel/export?type=logins\|events\|threats\|cases\|blocks\|new-ips` |
| POST | `{base}/api/sentinel/purge` |

Common query params: `hours`, `limit`, `offset`, `ip`, `locationId`, `q`, `outcome`, `eventType`, `status`, `method`, `path`, `errorClass`, `surface`, `action`, `actorId`.

---

## Integrator guidance

1. Prefer `POST /api/users/login` so failures appear as credential failures.  
2. After go-live, confirm Posture, Threats, and Review reflect expected traffic.  
3. Use Investigate + WHOIS + Export for incident tickets.  
4. Retention: `SENTINEL_RETENTION_DAYS` (default 30) for searchable events and `SENTINEL_FORENSIC_RETENTION_DAYS` (default 7) for evidence.  
5. Use a specific incident or troubleshooting reason for every evidence reveal; the reason becomes part of the access audit.  
6. Block carefully on shared egress IPs used by legitimate dialers.

## Related

- [Authentication](authentication)  
- [Architecture](architecture)  
- [Errors](errors)
