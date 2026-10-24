# Location data sync

Persist arbitrary location-scoped application state (JSON blob) that Vibe cannot store durably in the CRM alone.

---

## Push (upsert)

```http
POST /api/db/sync
Authorization: Bearer sp_live_...
Content-Type: application/json
```

```json
{
  "locationId": "fixture-field-04",
  "payload": { "any": "json" }
}
```

`payload` may be a JSON object or a string. Objects are stringified for storage.

**Response `200`**

```json
{ "success": true }
```

**Response `400`** — missing `locationId` or `payload`.

---

## Pull

```http
GET /api/db/sync?locationId=fixture-field-04
Authorization: Bearer sp_live_...
```

**Response `200`**

```json
{ "payload": null }
```

or

```json
{ "payload": "{\"any\":\"json\"}" }
```

If the client stored an object, it may be returned as a JSON string; parse as needed.

---

## System config helper

```http
GET /api/system/config
Authorization: Bearer sp_live_...
```

Returns one location snapshot (first row) for bootstrap scenarios:

```json
{
  "success": true,
  "locationId": "…",
  "payload": "…"
}
```

or `{ "success": true, "config": null }` when empty.

Prefer **explicit** `GET /api/db/sync?locationId=` for multi-location production.

---

## Notes

- One row per `locationId` (primary key).  
- Last write wins.  
- Suitable for dialer settings, UI state, caches — not a substitute for CRM lead records.
