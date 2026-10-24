# CORS & browser clients

## When CORS matters

If Vibe Dialer runs **in a browser** on origin `https://vibedial.example.com` and calls `https://api.example.invalid`, the browser enforces CORS.

Server-side / native clients **do not** need CORS.

---

## What operators configure

On the API server `.env` (then restart Node):

```env
CORS_ORIGINS=https://client.example.invalid,https://client.example.invalid
CORS_ALLOW_ALL=false
```

Exact origins only (scheme + host, no path, no trailing slash).

Debug-only (open any origin):

```env
CORS_ALLOW_ALL=true
```

---

## Allowed request headers (preflight)

The API allows at least:

- `Authorization`
- `Content-Type`
- `Accept`
- `Version`
- `X-Request-Id`
- `X-Requested-With`
- `Origin`

Methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`.

---

## CRM / Custom CRM CORS is separate

Calls from the Dialer **to** `https://crm.example.invalid/...` are controlled by **that** host’s CORS policy—not by this API.

| Request target | Who sets CORS |
|----------------|---------------|
| `api.example.invalid` | This server (`CORS_ORIGINS`) |
| `crm.example.invalid` | Custom CRM / LeadConnector / GHL |

This Custom API is for **storage**. CRM CORS issues must be fixed with the CRM/white-label provider or Vibe’s CRM integration approach.

---

## Preflight test

```bash
curl.exe -i -X OPTIONS "https://api.example.invalid/api/db/sync" ^
  -H "Origin: https://client.example.invalid" ^
  -H "Access-Control-Request-Method: GET" ^
  -H "Access-Control-Request-Headers: authorization"
```

Expect `Access-Control-Allow-Origin` reflecting the Dialer origin when configured.
