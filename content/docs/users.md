# Users & login

Operators (dialer agents) live in the `users` table. Vibe should upsert CRM-linked users here, then use login and performance endpoints with the same `id`.

All routes require:

```http
Authorization: Bearer sp_live_...
Content-Type: application/json
```

---

## User object

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | **Primary key** — stable Dialer/CRM id |
| `locationId` | string | Location / tenant scope |
| `username` | string | Display / login name |
| `email` | string | Email (normalized lowercase on write for login/reset) |
| `passwordHash` | string | Write-only; never returned on GET |
| `role` | string | e.g. agent, manager |
| `crmUserId` | string | CRM / GHL user id |
| `crmUserName` | string | CRM display name |
| `phone` | string | Optional |
| `createdAt` | string | Server timestamp |

---

## List users

```http
GET /api/users?locationId={locationId}
```

**Response `200`**

```json
{
  "success": true,
  "users": [
    {
      "id": "usr_123",
      "locationId": "xL8dd…",
      "username": "jane",
      "email": "jane@example.com",
      "role": "agent",
      "crmUserId": "ghl_…",
      "crmUserName": "Jane Agent",
      "phone": null,
      "createdAt": "2026-07-11T12:00:00.000Z"
    }
  ]
}
```

---

## Create / upsert user

```http
POST /api/users
```

```json
{
  "id": "usr_123",
  "locationId": "fixture-field-04",
  "username": "jane",
  "email": "jane@example.com",
  "passwordHash": "optional-on-create",
  "role": "agent",
  "crmUserId": "ghl_user_id",
  "crmUserName": "Jane Agent",
  "phone": "+1…"
}
```

**Response `201`** — `{ "success": true, "user": { … } }` (no `passwordHash`).

Upsert: same `id` updates fields via `ON DUPLICATE KEY UPDATE`.

---

## Bulk upsert

```http
POST /api/users/bulk
```

```json
{
  "locationId": "fixture-field-04",
  "users": [
    { "id": "usr_1", "username": "a", "email": "a@example.com", "crmUserId": "…" },
    { "id": "usr_2", "username": "b", "email": "b@example.com", "crmUserId": "…" }
  ]
}
```

**Response `200`** — `{ "success": true, "count": 2 }`

Use after loading CRM users for a location.

---

## Get one user

```http
GET /api/users/{userId}
GET /api/users/{userId}?locationId={locationId}
```

**Response `200`** — `{ "success": true, "user": { … } }`  
**Response `404`** — `{ "error": "User not found" }`

---

## Update user

```http
PUT /api/users/{userId}
```

Body same shape as create (`locationId` required for upsert semantics).

---

## Login (observed by Sentinel)

```http
POST /api/users/login
```

```json
{
  "locationId": "fixture-field-04",
  "email": "jane@example.com",
  "username": "optional-if-no-email",
  "userId": "optional",
  "password": "plain-text-password"
}
```

Provide **at least one** identity field and **either** `password` or `passwordHash`.
For bcrypt-managed users, send `password` and omit `passwordHash`. `passwordHash` is
the legacy alternative for rows that still store an opaque client-side hash; it is
not an additional field to send beside plaintext.

| Result | HTTP | Body |
|--------|------|------|
| Success | 200 | `{ "success": true, "user": { id, locationId, username, email, role, crmUserId, crmUserName } }` |
| Bad credentials | 401 | `{ "success": false, "error": "Invalid credentials" }` |
| Missing fields | 400 | `{ "success": false, "error": "…" }` |

**Verification rules**

- The API queries the installed **Core database (legacy)** `users` table and scopes the
  identity lookup to the submitted `locationId`. The same Legacy pool stores the issued
  operator session.
- If stored hash looks like bcrypt (`$2a$` / `$2b$` / `$2y$`), `password` is checked with bcrypt.  
- Otherwise, `password` or `passwordHash` is compared to stored value with timing-safe equality (Dialer opaque hashes).
- When both fields are supplied for a bcrypt account, valid plaintext takes precedence and the optional legacy client hash is ignored. A wrong plaintext password is recorded internally as `password_mismatch` while the caller still receives the uniform 401 response.

**Security**

- Failures do not reveal whether email/user exists.  
- Every attempt is recorded in Sentinel login events (no passwords stored).

---

## Reset password

```http
POST /api/users/reset-password
```

```json
{
  "locationId": "fixture-field-04",
  "email": "jane@example.com",
  "userId": "usr_123",
  "username": "optional",
  "passwordHash": "new-hash",
  "password": "optional-plain-min-6-chars"
}
```

| Field | Role |
|-------|------|
| `locationId` | Required |
| `email` | Lookup + stored on user |
| `userId` / `username` | Lookup (order: userId → username → email) |
| `passwordHash` or `password` | New credential (`password` is bcrypt-hashed server-side) |

If no user matches but **`userId`** is provided, a shell user is created.

**Response** includes `success`, `created`, `userId`, `locationId`, `email`.

Also available: `PUT /api/users/{userId}/password` with
`{ locationId, password }`. Plaintext is transmitted only over HTTPS and bcrypt-hashed
by the API before storage. The older `passwordHash` input remains temporarily accepted
for deployed legacy clients, but new clients must send `password` (creates a shell user
if missing).

---

## Recommended CRM → API mapping

| CRM field | API field |
|-----------|-----------|
| User id | `id` and `crmUserId` |
| Name | `crmUserName` / `username` |
| Email | `email` |
| Location | `locationId` |

Use the **same** `id` for login, appointments, rewards, and stats.
