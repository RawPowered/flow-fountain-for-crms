# Logging & client errors

Endpoints for Dialer client telemetry. All require the API key.

---

## System errors

### Ingest

```http
POST /api/errors
```

```json
{
  "id": "err_unique_id",
  "locationId": "xL8dd…",
  "userId": "usr_123",
  "username": "jane",
  "type": "js_error",
  "message": "Something failed",
  "details": "stack or json",
  "url": "https://dialer.example/page"
}
```

**Response `200`** — `{ "success": true }`

### User identity resolution

The authoritative identity source is the `users` table. The API first resolves `locationId + userId`, then falls back to a non-generic `username` or `email` within the same location.

Retrieve valid values with:

```http
GET /api/users?locationId={locationId}
```

Use `users[].id` as `userId` and `users[].username` as `username`. Values such as `system`, `Admin`, `unknown`, and `anonymous` are treated as placeholders, not user identities.

Successful ingest responses include the resolved identity:

```json
{
  "success": true,
  "identity": {
    "resolved": true,
    "matchedBy": "userId",
    "userId": "usr_123",
    "username": "jane",
    "email": "jane@example.com"
  }
}
```

If an error occurs before a user is known, the event is still stored with `identity.resolved: false`; generic placeholders are stored as `NULL`.

### List

```http
GET /api/errors?locationId={locationId}
```

Latest 100 for the location.

### Clear

```http
DELETE /api/errors?locationId={locationId}
```

---

## Auth logs (client-reported)

### Ingest

```http
POST /api/logs
```

```json
{
  "id": "log_unique_id",
  "locationId": "xL8dd…",
  "username": "jane",
  "status": "success",
  "userAgent": "Mozilla/…",
  "email": "optional@example.com",
  "userId": "optional"
}
```

Identity is resolved from `users` with the same rules as `/api/errors`. Resolved `userId`, `username`, and `email` are stored in `auth_logs` **and** mirrored into **Sentinel login events** as `event_type: auth_log`.

Outcome mapping (case-insensitive `status`):

| status contains | Sentinel outcome |
|-----------------|------------------|
| success, ok, authenticated | `success` |
| fail, error, denied, invalid | `failure` |
| other | `unknown` |

Prefer **`POST /api/users/login`** for real credential verification; use `/api/logs` for supplemental client telemetry.

### List

```http
GET /api/logs?locationId={locationId}
```

Latest 100 for the location.
