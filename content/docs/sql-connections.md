# SQL Connection Hub

Administrate **additional MySQL databases** and **which API keys** may use them. Clients never receive DB passwords; they call a grant-gated table router under `/api/sql/*`.

---

## Security model

| Principle | Behavior |
|-----------|----------|
| Default deny | API keys have **zero** SQL access until an admin grants a connection + tables |
| No raw SQL | Only structured table routes with parameterized values |
| Identifier allowlist | Table/column names must match `[A-Za-z_][A-Za-z0-9_]*` |
| Op allowlist | Per-table SELECT / INSERT / UPDATE / DELETE |
| Optional column allowlist | Restrict which columns may be written/filtered |
| Encrypted passwords | Connection secrets stored AES-256-GCM (key derived from `SESSION_SECRET`) |
| Platform DB separate | Installer/control-plane MySQL stays on `getPool()`; data targets are named connections |

**Do not** grant production API keys write access to sensitive tables without need. Prefer a **read-only MySQL user** on the remote database.

---

## Admin UI

After login:

```text
{ADMIN_BASE_PATH}/connections
```

1. **Create connection** — slug, host, port, database, user, password, max rows  
2. **Test** — verifies connectivity without exposing secrets  
3. **Grant API key** — pick key, add tables + ops, save  
4. **Load table names** — optional introspect helper for admins  

Disable a connection to cut off all keys immediately.

---

## Machine API (Bearer key)

All routes require `Authorization: Bearer sp_live_…`.

### Discover grants for this key

```http
GET /api/sql/connections
```

```json
{
  "success": true,
  "connections": [
    {
      "slug": "reporting-db",
      "name": "Reporting replica",
      "canIntrospect": true,
      "tables": [
        {
          "tableName": "orders",
          "allowSelect": true,
          "allowInsert": false,
          "allowUpdate": false,
          "allowDelete": false,
          "primaryKey": "id",
          "allowedColumns": null
        }
      ]
    }
  ]
}
```

### List granted tables

```http
GET /api/sql/{slug}/tables
```

Requires grant `canIntrospect`. Returns only tables listed on the grant.

### Columns

```http
GET /api/sql/{slug}/tables/{table}/columns
```

### Read rows

```http
GET /api/sql/{slug}/{table}?limit=50&offset=0&orderBy=id&orderDir=desc&filter[status]=open
```

Equality filters only: `filter[col]=value` or `where[col]=value`.

### Read one

```http
GET /api/sql/{slug}/{table}/{primaryKeyValue}
```

### Insert

```http
POST /api/sql/{slug}/{table}
Content-Type: application/json

{ "status": "open", "amount": 10 }
```

### Update

```http
PUT /api/sql/{slug}/{table}/{primaryKeyValue}
PATCH /api/sql/{slug}/{table}/{primaryKeyValue}
```

### Delete

```http
DELETE /api/sql/{slug}/{table}/{primaryKeyValue}
```

---

## Example: second product database

1. Create MySQL user `api_ro` with `SELECT` on `other_app.*`.  
2. Admin → SQL connections → slug `other-app`, credentials for `api_ro`.  
3. Grant Dialer key only `customers` table, SELECT.  
4. Dialer:

```bash
curl.exe -s -H "Authorization: Bearer sp_live_..." \
  "https://api.example.invalid/api/sql/other-app/customers?limit=20"
```

---

## Ops notes

- After deploy: `npm run migrate` (tables `sql_connections`, `sql_connection_grants`, `sql_table_grants`).  
- Changing `SESSION_SECRET` breaks decryption of stored DB passwords — re-enter passwords on each connection.  
- Max rows per query is capped per connection (default 500, max 5000).  
- Sentinel logs `/api/sql/...` like any other API path.

---

## Related

- [Authentication](authentication) — API keys  
- [Architecture](architecture)  
- [Errors](errors)
