# Vibe / AI integration guide

Instructions for **Vibe AI**, coding agents, and human Dialer developers.

---

## Product roles (do not reverse)

1. **CRM (LeadConnector / Custom CRM)** — source of leads and CRM users.  
2. **Workbench Custom API** — server-side PIT access, authoritative service routing, and durable operational storage.  
3. **Vibe Dialer** — platform UX and orchestration using the Workbench machine API.

Do **not** place the Private Integration Token in Vibe client code or browser requests. Use the
grant-bound Workbench CRM import path so the encrypted PIT stays server-side. The optional Custom CRM
proxy remains available for its existing compatibility use cases.

---

## Required configuration in Dialer

| Setting | Value |
|---------|--------|
| Custom API base | `https://api.example.invalid` |
| Custom API key | Full `sp_live_…` from admin |
| Header on every storage call | `Authorization: Bearer sp_live_…` |
| Content-Type | `application/json` for JSON bodies |

---

## Recommended lifecycle per location session

### A. Bootstrap users (CRM → API)

After CRM users for a location are available in Vibe memory:

```http
POST /api/users/bulk
```

```json
{
  "locationId": "<ghl-location-id>",
  "users": [
    {
      "id": "<stable-id>",
      "username": "<login-or-handle>",
      "email": "<email>",
      "crmUserId": "<ghl-user-id>",
      "crmUserName": "<display name>",
      "role": "agent"
    }
  ]
}
```

**Critical:** choose one stable `id` and use it for login + appointments + rewards + stats.

### B. Agent login

```http
POST /api/users/login
```

```json
{
  "locationId": "<location-id>",
  "email": "<email>",
  "password": "<plain>"
}
```

On success, keep returned `user.id` in session.

Send one credential representation. For OWL-managed bcrypt users, send the current
plaintext `password` and omit `passwordHash`. Use `passwordHash` only instead of
plaintext when authenticating a legacy row that stores that exact opaque value.

On failure, show generic error; Sentinel records the attempt.

### C. Password reset

```http
POST /api/users/reset-password
```

Include `locationId`, `email` (and `userId` when known), plus `password` or `passwordHash`.

### D. Location state

```http
GET  /api/db/sync?locationId=
POST /api/db/sync   { "locationId", "payload" }
```

### D2. Session Harbor (workspace — per operator)

After login, restore the agent’s last CRM contact + widget UI. On contact change, debounced upsert. See [Session Harbor](sessions).

```http
GET  /api/sessions/workspace?locationId=&userId=
PUT  /api/sessions/workspace
POST /api/sessions/workspace/heartbeat
GET  /api/sessions/workspace/resolve-url?locationId=&contactId=
```

**CRM surface rules (required to stop re-login walls):**

1. Prefer `window.open(contactUrl, 'workbench-crm-harbor')` (named window) so CRM cookies stay first-party.  
2. Or use **one** immortal iframe; never destroy/recreate it per contact.  
3. Harbor stores paths and UI state only — **never** CRM cookies or passwords.  
4. Debounce PUT ~250–500ms; heartbeat every 30–60s while active.

### D3. Lead queue restoration

Load the API-owned service mappings before importing or pulling leads:

```http
GET /api/service-pools?locationId=<location-id>
Authorization: Bearer sp_live_...
```

Use the returned `mappings` for the existing `TagMappings` UI. Browser `_sp_tag_mappings` data may
be a compatibility fallback, but it must not overwrite the API catalog. The existing
`POST /api/leads/pull` request continues to pass the selected `serviceType`.

The same service records include `calendarIds` and `defaultCalendarId`. Before opening the booking
UI, resolve the active lead rather than relying on browser configuration:

The location-bound HighLevel Private Integration Token used by the CRM integration must include the
`calendars/events.readonly` scope. Workbench keeps that token encrypted and server-side.

```http
GET /api/calendars/resolve?locationId=<location-id>&leadId=<lead-id>
Authorization: Bearer sp_live_...
```

Submit the returned default or another allowed ID as `calendarId` to `POST /api/appointments`.
Refresh `GET /api/calendars?locationId=...` when OWL configuration changes.

Because a parent page cannot directly modify a cross-origin iframe, Vibe can request an
operator-scoped prefill contract immediately before loading the calendar:

```http
POST /api/leads/booking-context
Authorization: Bearer sp_live_...
X-Operator-Token: <operator-session-token>
Content-Type: application/json

{ "contactId": "CONTACT_ID" }
```

Use `booking.defaultCalendarId` to select the service calendar and inject only the returned
`booking.fields` or `booking.queryParams` into the calendar widget. The endpoint is limited to the
operator currently assigned to the lead, uses `Cache-Control: no-store`, and never returns the CRM
credential. Do not persist this response in browser storage or application logs.

After agent login and workspace restoration, load that agent's active assignments:

```http
GET /api/leads/assigned?locationId=<location-id>&userId=<stable-user-id>
Authorization: Bearer sp_live_...
X-Operator-Token: <session.token returned by /api/users/login>
```

Use the same stable `user.id` returned by `/api/users/login`. Treat `200` with `leads: []` as a normal empty queue. Each lead contains only `leadId`, `firstName`, `lastName`, `phone`, `city`, `state`, `latitude`, and `longitude`. Never expect `contactData`, email, address, tags, notes, custom fields, source links, owner IDs, or DNC state in the Dialer.

Send the Workbench machine key in `Authorization` and the login session in `X-Operator-Token` on list, assigned, pull, detail, status, release, and call-authorization requests. The API rejects a token that does not match the API key, location, or `userId`.

The header value must be the current `session.token` returned by a successful `POST /api/users/login`; adding the header name with an empty, stale, or user ID value does not authenticate the request. Store the token in memory and rebuild the API headers after every successful login:

```js
const loginResponse = await fetch('https://api.example.invalid/api/users/login', {
  method: 'POST',
  credentials: 'include',
  headers: {
    Authorization: `Bearer ${WORKBENCH_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ locationId, username, password }),
});
const login = await loginResponse.json();
const operatorToken = login?.session?.token;
if (!loginResponse.ok || !operatorToken) throw new Error('Operator login did not return session.token');

const assignedResponse = await fetch(
  `https://api.example.invalid/api/leads/assigned?locationId=${encodeURIComponent(locationId)}&userId=${encodeURIComponent(login.user.id)}`,
  {
    credentials: 'include',
    headers: {
      Authorization: `Bearer ${WORKBENCH_API_KEY}`,
      'X-Operator-Token': operatorToken,
    },
  }
);
```

Workbench also issues the operator token as an `HttpOnly`, `Secure`, `SameSite=None` host cookie scoped to `/api`. Browser clients that use `credentials: 'include'` for login and subsequent API calls can use this as a fallback. The explicit `X-Operator-Token` header remains the primary and most diagnosable transport. On `OPERATOR_SESSION_REQUIRED`, verify the request in DevTools actually contains the header; on `OPERATOR_SESSION_INVALID`, discard the stored token and log in again.

Recommended lead lifecycle:

1. Restore current assignments with `GET /api/leads/assigned`.
2. Request more work with `POST /api/leads/pull` when the assigned queue is empty or below the Dialer threshold.
3. Refresh `GET /api/leads/assigned` after a successful pull.
4. Immediately before dialing, call `POST /api/leads/call-attempts/authorize` with `{ contactId: lead.leadId }`; do not send state, timezone, location, or user. Authorization reconciles the contact against every calendar configured for its service pool.
5. Place the call only after HTTP `201` with `allowed: true`. Treat `409 APPOINTMENT_ALREADY_SCHEDULED` as terminal: refresh the queue because Workbench has routed the lead to Scheduled. Treat `503 CALENDAR_VERIFICATION_UNAVAILABLE` as a retryable safety stop and honor `nextEligibleAt` when present.
6. Persist outcomes with `PATCH /api/leads/{leadId}/status`.
7. Return an assignment to the pool with `POST /api/leads/{leadId}/release` when authorized.
8. Let OWL own DNC screening, CRM details, pool administration, compliance decisions, and reassignment; the Dialer receives only API-approved work.

### SONG script discovery and selection

Do not add script tables or direct SQL to the Vibe server template. Search the tenant-scoped SONG catalog with the same Bearer key and operator token used for assigned leads:

```js
const scriptQuery = new URLSearchParams({
  serviceType: lead.serviceType,
  languageCode: selectedLanguageCode,
  q: searchText,
  limit: '25',
});
const catalogResponse = await fetch(`https://api.example.invalid/api/song/scripts?${scriptQuery}`, {
  credentials: 'include',
  headers: {
    Authorization: `Bearer ${WORKBENCH_API_KEY}`,
    'X-Operator-Token': operatorToken,
  },
});
if (!catalogResponse.ok) throw new Error(`SONG catalog failed: ${catalogResponse.status}`);
const { scripts } = await catalogResponse.json();
```

Use `scriptId` as the saved selection value and `name` only as its display label. Load the selected graph and preserve Dynamic Greetings through the resolver:

```js
const runtimeResponse = await fetch('https://api.example.invalid/api/song/runtime/resolve', {
  method: 'POST',
  credentials: 'include',
  headers: {
    Authorization: `Bearer ${WORKBENCH_API_KEY}`,
    'X-Operator-Token': operatorToken,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    serviceType: lead.serviceType,
    languageCode: selectedLanguageCode,
    scriptId: selectedScriptId,
    leadId: lead.leadId,
    runtimeContext: { greeting, localTime, weatherSummary, appointmentType },
  }),
});
```

Use canonical BCP 47 values such as `en-US` and `es-US`. The connector may derive a preferred language from a trusted CRM field or an explicit operator choice, but must not infer it from a person's name. If no explicit script selection exists, send `languageCode` and omit `scriptId`; SONG returns the default published assignment for that service and language. Omitting both preserves the legacy `en-US` service default. Refresh the catalog after login, location, service, or language changes, or after `SONG_RUNTIME_NOT_FOUND`; never manufacture an ID or match a runtime by name.

For normal lead collection, queue the granted CRM integration through Workbench rather than sending
the PIT from Vibe. A Workbench `sp_live_...` key identifies the Dialer and its integration grant; it
is not the upstream credential. The server retrieves the encrypted, location-bound PIT and sends it
only to `services.leadconnectorhq.com`.

### E. Performance

```http
POST /api/appointments
POST /api/rewards
GET  /api/users/{userId}/stats?locationId=
```

### F. Optional telemetry

```http
POST /api/logs    { id, locationId, username, status, userAgent, email?, userId? }
POST /api/errors  { id, locationId, userId?, username?, email?, ... }
```

---

## Identity rules for AI implementers

1. Never invent random user ids per request if a CRM id exists.  
2. Map `crmUserId` consistently.  
3. Scope all multi-tenant reads by `locationId`.  
4. Do not store the Custom API key in public client repos.  
5. Prefer `POST /api/users/login` over only local password checks so security posture is visible.  
6. Treat empty `payload: null` on sync as normal (first run).

---

## What not to build against this API

| Avoid | Why |
|-------|-----|
| Expecting `/backend/locations/.../customValues` here | That is CRM (Custom CRM), unless ops enable optional proxy |
| Single shared env `API_KEY` only | Replaced by multi-key portal keys |
| Public `/admin` path | Admin is obfuscated; integrators get keys from operators |
| Returning `passwordHash` from GET users | Intentionally omitted |

---

## Verification checklist (AI / QA)

- [ ] `GET /health` → `{ ok: true }`  
- [ ] `GET /api/db/sync?locationId=test` with Bearer → not 401  
- [ ] `POST /api/users` then `GET /api/users?locationId=` includes user  
- [ ] `POST /api/users/login` success and failure both behave correctly  
- [ ] `GET /api/leads?locationId=` with both credentials returns only the operator's leads and the eight allowlisted fields  
- [ ] `GET /api/service-pools?locationId=` returns current service/tag mappings
- [ ] `GET /api/leads/assigned?locationId=&userId=` with `X-Operator-Token` returns only that agent's active assignments  
- [ ] Assigned-leads empty state returns `200`, not `404`  
- [ ] `POST /api/leads/call-attempts/authorize` accepts only `{ contactId }` and returns a compact authorization or denial  
- [ ] `POST /api/appointments` + stats reflect counts  
- [ ] Browser Dialer: no CORS error **to api.example.invalid**  
- [ ] CRM CORS errors (if any) acknowledged as CRM-side, not Custom API defects  
- [ ] `PUT`/`GET` `/api/sessions/workspace` round-trip for a user  
- [ ] Contact A → B without remounting CRM surface → no CRM re-login  
- [ ] Dialer refresh restores last `crm.path` / contact from Harbor  

---

## Support packet for operators

When asking for help, provide:

1. Request method + path (no secrets)  
2. HTTP status  
3. Approximate time (UTC)  
4. `locationId` / `userId` (non-secret)  
5. Whether Sentinel shows the request  

Never paste full `sp_live_` keys into chats or tickets.
