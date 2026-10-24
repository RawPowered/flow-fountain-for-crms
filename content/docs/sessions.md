# Session Harbor — dialer workspace continuity

Preserve **where an agent was** across dialer refreshes and contact changes. This is **not** a CRM cookie vault.

---

## What problem this solves

Vibe Dialer opens the white-label CRM (e.g. Custom CRM) in a frame or companion window so agents can navigate contacts via URL:

```text
https://crm.example.invalid/v2/location/{locationId}/contacts/detail/{contactId}
```

If the dialer remounts that surface on every contact change—or loses widget/contact context on refresh—the CRM often shows a **re-login wall**. Browser security also prevents this API from reading or re-injecting cookies for `crm.example.invalid`.

**Session Harbor** stores a per-operator **workspace snapshot** (active contact path, widget geometry, dialer UI hints). The **dialer** is responsible for keeping a **stable CRM browsing context**.

| Layer | Owner | Responsibility |
|-------|--------|----------------|
| Stable CRM surface | Dialer | Named window **or** single immortal iframe — never destroy on contact switch |
| Workspace memory | This API | `PUT`/`GET` `/api/sessions/workspace` |
| CRM auth cookies | CRM domain only | First-party session on Custom CRM / GHL |

---

## Hard constraints (read this)

1. **Do not** send CRM cookies, passwords, or tokens in workspace `state`. Requests containing forbidden keys are rejected (`400`).
2. This API **cannot** set cookies for `crm.example.invalid`.
3. Prefer **named window**: `window.open(url, 'workbench-crm-harbor')` so CRM cookies behave as first-party.
4. If you keep an iframe: create it **once**; only change `src` for contacts.

---

## Endpoints

All require:

```http
Authorization: Bearer sp_live_...
Content-Type: application/json
```

### Put workspace

```http
PUT /api/sessions/workspace
```

```json
{
  "locationId": "fixture-field-04",
  "userId": "<stable-dialer-user-id>",
  "state": {
    "schemaVersion": 1,
    "crm": {
      "origin": "https://crm.example.invalid",
      "locationId": "fixture-field-04",
      "contactId": "fixture-field-11",
      "path": "/v2/location/fixture-field-04/contacts/detail/fixture-field-11",
      "surface": "named_window",
      "windowName": "workbench-crm-harbor"
    },
    "widget": { "x": 40, "y": 60, "w": 1100, "h": 720, "minimized": false },
    "dialer": { "mode": "power", "queueCursor": 12, "filters": {} },
    "updatedAtClient": "2026-07-11T15:00:00.000Z"
  },
  "clientTabId": "optional-tab-uuid",
  "expectedRevision": 1,
  "leaseSeconds": 120
}
```

**Response `200`**

```json
{
  "success": true,
  "workspace": {
    "locationId": "…",
    "userId": "…",
    "revision": 2,
    "state": { "…": "…" },
    "crmContactId": "fixture-field-11",
    "crmPath": "/v2/location/…/contacts/detail/…",
    "clientTabId": "…",
    "leaseUntil": "…",
    "updatedAt": "…"
  }
}
```

**Response `409`** — `expectedRevision` mismatch (another tab wrote). Body includes current `workspace`.

**Response `400`** — missing fields or forbidden secret keys in `state`.  
**Response `413`** — state larger than `WORKSPACE_MAX_BYTES` (default 256kb).

Omit `expectedRevision` for last-write-wins. Use `0` when creating the first row with optimistic locking.

---

### Get workspace

```http
GET /api/sessions/workspace?locationId=…&userId=…
```

```json
{ "success": true, "workspace": null }
```

or `{ "success": true, "workspace": { … } }`.

---

### Heartbeat

```http
POST /api/sessions/workspace/heartbeat
```

```json
{
  "locationId": "…",
  "userId": "…",
  "clientTabId": "…",
  "leaseSeconds": 120
}
```

Touches `updated_at` and extends optional lease. **404** if no workspace yet (call `PUT` first).

Suggested dialer interval: **30–60 seconds** while the agent is active.

---

### Delete workspace

```http
DELETE /api/sessions/workspace?locationId=…&userId=…
```

(or same fields in JSON body)

Default product guidance: **keep** workspace across logout so next login restores last contact; only delete if you need a full reset.

---

### Resolve CRM URL

```http
GET /api/sessions/workspace/resolve-url?locationId=fixture-field-04&contactId=fixture-field-11
```

```json
{
  "success": true,
  "origin": "https://crm.example.invalid",
  "path": "/v2/location/fixture-field-04/contacts/detail/fixture-field-11",
  "url": "https://crm.example.invalid/v2/location/fixture-field-04/contacts/detail/fixture-field-11"
}
```

Origin comes from server env `CRM_APP_ORIGIN` (fallback: the Custom CRM CRM application origin).

Optional `path=` query rewrites a path or full URL to the configured origin.

---

## Dialer integration checklist

1. After `POST /api/users/login`, **GET** workspace.  
2. Restore widget geometry from `state.widget`.  
3. Open CRM surface **once**:
   - Named window: `window.open(url, state.crm.windowName || 'workbench-crm-harbor')`
   - Iframe: set `src` on a single long-lived element  
4. On contact change: navigate the **same** surface → debounced **PUT** (250–500 ms).  
5. Heartbeat every 30–60 s.  
6. On dialer refresh: GET → reattach to named window / immortal iframe with last `crm.path`.  
7. Never put CRM session cookies in Harbor.

### Named window snippet

```js
const WINDOW_NAME = 'workbench-crm-harbor';

function openContact(url) {
  return window.open(url, WINDOW_NAME);
}

// Contact switch — reuses the same browsing context
openContact(nextContactUrl);

// After dialer refresh
const ws = await fetchWorkspace(locationId, userId);
if (ws?.state?.crm) {
  const url =
    ws.state.crm.path
      ? `${ws.state.crm.origin || CRM_ORIGIN}${ws.state.crm.path}`
      : await resolveUrl(locationId, ws.state.crm.contactId);
  openContact(url);
}
```

---

## Ops

After deploy, apply schema:

```bash
npm run migrate
```

| Env | Purpose |
|-----|---------|
| `CRM_APP_ORIGIN` | CRM app base for `resolve-url` |
| `WORKSPACE_MAX_BYTES` | Max state size (default `262144`) |

---

## Related

- [Vibe / AI integration](vibe-integration) — full lifecycle  
- [Architecture](architecture) — system roles  
- [Location sync](location-sync) — location-wide blob (not per-user workspace)  
- [Users & login](users) — operator identity for `userId`
