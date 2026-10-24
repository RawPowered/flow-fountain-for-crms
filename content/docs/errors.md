# Errors & HTTP status codes

## Response shape

Most errors:

```json
{ "error": "Human readable message" }
```

Login failures:

```json
{ "success": false, "error": "Invalid credentials" }
```

---

## Common status codes

| Code | When |
|------|------|
| `200` | Success |
| `201` | Created (e.g. `POST /api/users`) |
| `400` | Missing/invalid parameters |
| `401` | Missing/invalid/revoked API key **or** failed operator login |
| `403` | Forbidden (e.g. admin role, proxy path not allowed) |
| `404` | Resource not found |
| `429` | Rate limit exceeded |
| `500` | Server / database error |
| `503` | Service unavailable (e.g. not installed) |

---

## API key vs operator login

| Scenario | Status | Body |
|----------|--------|------|
| No/invalid Bearer key on `/api/*` | 401 | `{ "error": "Unauthorized" }` |
| Valid key, wrong agent password on `/api/users/login` | 401 | `{ "success": false, "error": "Invalid credentials" }` |

---

## Rate limits (approximate)

| Surface | Limit |
|---------|--------|
| Machine API | ~300 req/min per IP |
| Admin login | ~20 / 15 min per IP |
| Install endpoints | Limited when exposed |

Treat `429` as retry-with-backoff.

---

## Idempotency notes

- Lead bulk: duplicate lead `id` ignored.  
- User upsert: same `id` updates.  
- Location sync: last write wins per `locationId`.
