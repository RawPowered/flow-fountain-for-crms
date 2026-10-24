# Authentication

## Overview

Two separate auth systems:

| Audience | Mechanism | Used for |
|----------|-----------|----------|
| **Machines** (Vibe Dialer) | `Authorization: Bearer sp_live_…` | All `/api/*` routes |
| **Humans** (operators of this server) | Session cookie after admin password | Admin portal, docs, Sentinel, keys |

This document focuses on **machine API keys**.

---

## API keys

### Format

```
sp_live_<cryptographically random>
```

- Full secret shown **once** at creation in the admin portal.
- Database stores **SHA-256 hash** + short **prefix** only.
- Never log or commit full keys.

### Request header

```http
Authorization: Bearer sp_live_xxxxxxxx
```

Also accepted (less preferred):

```http
Authorization: sp_live_xxxxxxxx
```

Accidental surrounding quotes on the secret are stripped server-side.

### Creating and rotating keys

1. Admin portal → **API Keys** → Generate (name e.g. `Production Dialer`).  
2. Store secret in Dialer Operations panel.  
3. To rotate: create new key → update Dialer → confirm Sentinel traffic → **Revoke** old key.

### Failed auth

```json
HTTP/1.1 401 Unauthorized
{ "error": "Unauthorized" }
```

Sentinel records 401s and attributes traffic to key prefix when valid.

---

## Operator login (Dialer users)

Separate from API keys. After the Dialer has a valid API key, agents authenticate with:

```http
POST /api/users/login
Authorization: Bearer sp_live_...
Content-Type: application/json
```

See [Users & login](users). Login success/failure is recorded in **Sentinel → Login security**.

Operator credentials are verified server-side against the `users` table in the installed
core database, shown in OWL as **Core database (legacy)**. The lookup is scoped by
`locationId` plus `userId`, `username`, or `email`; a browser-side user record cannot
authenticate by itself. Sentinel control health reports this store as
`authentication_database` and verifies its required columns, credential coverage, and
login indexes without reading or exposing any password value.

---

## Security rules for integrators

1. Use **HTTPS** only in production.  
2. Prefer server-side or secure storage of the API key; do not embed in public mobile apps without a backend.  
3. Do not put the API key in query strings or public repos.  
4. One key per environment (preview vs production) is recommended.  
5. CORS must allow the Dialer origin for browser apps (ops: `CORS_ORIGINS`).

---

## Admin portal (humans)

- Path is **not** `/admin`. It is a high-entropy path in `ADMIN_BASE_PATH`.  
- Not linked from the public site.  
- Docs and Sentinel require an admin session.  
- Integrators normally receive **API keys** from operators, not admin passwords.
