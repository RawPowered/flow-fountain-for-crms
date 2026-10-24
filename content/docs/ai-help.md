# AI command help

Workbench exposes an authenticated, machine-readable command catalog for Vibe AI, terminal agents, and API debugging tools. It describes the currently deployed API version, command paths, required inputs, optional inputs, examples, and authorization rules.

The help surface requires the same Workbench Bearer key as every other `/api/*` route. It never returns API secrets, CRM credentials, passwords, or admin URLs.

---

## Terminal help

```bash
curl.exe -s \
  -H "Authorization: Bearer %WORKBENCH_API_KEY%" \
  "https://api.example.invalid/api/help?format=text"
```

PowerShell:

```powershell
$headers = @{ Authorization = "Bearer $env:WORKBENCH_API_KEY" }
Invoke-RestMethod -Headers $headers "https://api.example.invalid/api/help"
```

Search the catalog:

```http
GET /api/help?q=assigned
GET /api/help?category=leads
GET /api/help?q=proxy&format=text
```

---

## One command

Commands use stable IDs such as `leads.assigned`, `users.login`, `proxy.request`, and `telemetry.error`.

```http
GET /api/help/leads.assigned
GET /api/help/leads.assigned?format=text
```

The response includes the method, path, required and optional fields, examples, operational notes, generated `curl.exe`, and validation payload.

---

## Validate without executing

```http
POST /api/help/validate
Content-Type: application/json

{
  "command": "leads.assigned",
  "query": {
    "locationId": "fixture-field-04",
    "userId": "fixture-user"
  }
}
```

```json
{
  "success": true,
  "command": "leads.assigned",
  "valid": true,
  "missing": [],
  "warnings": [],
  "request": {
    "method": "GET",
    "url": "https://api.example.invalid/api/leads/assigned?locationId=fixture-field-04&userId=fixture-user",
    "body": null,
    "curl": "curl.exe ..."
  }
}
```

Validation performs no API operation and no CRM request. It checks request shape only; grants, record existence, CRM scopes, and database state are evaluated by the real endpoint.

Dialer lead commands require two headers. Keep the machine credential in `Authorization: Bearer ...` and pass `session.token` from `/api/users/login` as `X-Operator-Token`. Command detail, validation, text help, and OpenAPI expose this requirement and generate `$OPERATOR_SESSION_TOKEN` placeholders. Browser integrations may also use the secure operator cookie fallback by setting `credentials: 'include'` on login and subsequent calls. Lead responses are restricted to `leadId`, name, phone, city, state, latitude, and longitude; OWL/EAGLE retain complete CRM data.

---

## OpenAPI

```http
GET /api/help/openapi.json
```

The OpenAPI 3.1 document includes Bearer authentication, command operation IDs, parameters, body fields, examples, and `x-workbench-requirements` metadata.

---

## Vibe AI bootstrap instruction

```text
Before calling or debugging a Workbench API command, request GET /api/help with the
existing Workbench Bearer key. Search with ?q= when needed. Retrieve exact requirements
with GET /api/help/{command}. Before executing a command, POST the proposed path/query/body
to /api/help/validate and correct every missing field. Never print or persist Bearer tokens.
Use /api/help/openapi.json when an OpenAPI import is supported.
```

The command catalog is authoritative for request shape. The walled documentation remains authoritative for architecture, security rationale, and operational rollout procedures.
