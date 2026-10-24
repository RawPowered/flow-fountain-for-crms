# Performance metrics

Record appointments and rewards; read per-user aggregates. Use the **same** `userId` as in the users table.

---

## Create appointment

```http
POST /api/appointments
```

```json
{
  "locationId": "fixture-field-04",
  "leadId": "lead_1",
  "userId": "usr_123",
  "calendarId": "calendar_roofing_primary",
  "appointmentDate": "2026-07-15T15:00:00.000Z"
}
```

**Response `200`**

```json
{ "success": true, "appointmentId": 42, "serviceType": "Roofing", "calendarId": "calendar_roofing_primary" }
```

Resolve the calendar first with `GET /api/calendars/resolve?locationId=...&leadId=...`. If
`calendarId` is omitted and the service has configured calendars, the API selects its default.
An ID assigned to a different service is rejected with `409`.

Default status: `scheduled`.

Appointments booked directly inside the configured CRM calendar are reconciled during outbound-call
authorization. A matching future/current event is deduplicated by `locationId + externalEventId`,
written to this same ledger with source `crm_calendar`, and routes the lead to the Scheduled pool.
Cancelled, invalid, deleted, and stale past events do not create an active restriction.

For controlled debugging, an OWL administrator may create a short-lived, use-limited release:

```http
POST {ADMIN_BASE_PATH}/api/owl/leads/{leadId}/scheduled-call-release
Content-Type: application/json

{
  "apiKeyId": "API_KEY_ID",
  "locationId": "LOCATION_ID",
  "reason": "Reproduce calendar widget issue INC-1234",
  "minutes": 30,
  "uses": 1
}
```

The release does not remove the appointment or move the lead out of Scheduled. It is consumed only
when a call authorization succeeds, expires after at most 24 hours, allows at most five uses, and is
recorded in both OWL audit history and Sentinel control-plane telemetry.

---

## Create reward

```http
POST /api/rewards
```

```json
{
  "locationId": "fixture-field-04",
  "userId": "usr_123",
  "leadId": "lead_1",
  "amount": 25.0,
  "type": "appointment_set"
}
```

**Response `200`**

```json
{ "success": true, "rewardId": 7 }
```

---

## User stats

```http
GET /api/users/{userId}/stats?locationId=fixture-field-04
```

**Response `200`**

```json
{
  "success": true,
  "appointments": [
    { "status": "scheduled", "count": 3 },
    { "status": "completed", "count": 1 }
  ],
  "totalRewards": 75.5
}
```

`totalRewards` is the sum of `rewards.amount` for that user + location (may be `0` or `null`-coalesced to `0`).

---

## Integration tips

1. Upsert user before first metrics write (optional but recommended for reporting joins).  
2. Always pass `locationId` on stats.  
3. Use ISO-8601 timestamps for `appointmentDate` when possible.
