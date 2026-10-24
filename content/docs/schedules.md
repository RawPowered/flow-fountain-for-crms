# Schedules

Per-user schedule documents (JSON) scoped by location.

---

## Get user schedule

```http
GET /api/users/{userId}/schedule?locationId={locationId}
```

**Response `200`**

```json
{ "success": true, "schedule": null }
```

or

```json
{
  "success": true,
  "schedule": { "mon": ["09:00-17:00"], "timezone": "America/Chicago" }
}
```

---

## Put user schedule

```http
PUT /api/users/{userId}/schedule
```

```json
{
  "locationId": "fixture-field-04",
  "scheduleData": {
    "mon": ["09:00-17:00"],
    "timezone": "America/Chicago"
  }
}
```

Upserts by `userId`.

**Response `200`** — `{ "success": true }`

---

## List schedules for a location

```http
GET /api/schedules?locationId={locationId}
```

Joins users for display names when present.

**Response `200`**

```json
{
  "success": true,
  "schedules": [
    {
      "userId": "usr_123",
      "username": "jane",
      "crmUserName": "Jane Agent",
      "schedule": { }
    }
  ]
}
```
