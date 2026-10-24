# Leads pool

Optional lead queue for the Dialer. Import leads, then pull/assign to agents.

All routes require the Workbench API key. Dialer queue, detail, pull, status, release, and call-authorization routes also require the opaque login token in `X-Operator-Token`.

CRM-managed lead routes use explicit integration grants for the API key and location. For deployment compatibility, authenticated `GET /api/leads` remains available when no CRM integration has been configured for that location; explicit grants take over as soon as an integration exists.

---

## List and search

```http
GET /api/leads?locationId=LOCATION&status=uncontacted&serviceType=Roofing&limit=50&offset=0
```

Optional filters: `status`, `dncStatus`, `serviceType`, `assignedTo`, and `search`. The API always limits this route to leads assigned to the authenticated operator. OWL owns organization-wide pool and DNC screening views.

Every Dialer lead response uses the same allowlist: `leadId`, `contactId`, `firstName`, `lastName`, `phone`, `city`, `state`, `latitude`, and `longitude`. Complete CRM payloads, email, street address, tags, notes, custom fields, source links, assignment metadata, and compliance state are not returned to the Dialer.

Get one lead with `GET /api/leads/{id}?locationId=LOCATION`.

## Assigned leads for an agent

```http
GET /api/leads/assigned?locationId=fixture-field-04&userId=fixture-user
Authorization: Bearer sp_live_...
X-Operator-Token: <session.token returned by /api/users/login>
```

Login also sets the same opaque session as an `HttpOnly`, `Secure`, `SameSite=None` cookie scoped to `/api`. Cross-origin browser clients must use `credentials: 'include'` on both login and later requests for that fallback to work. Header authentication takes precedence when both are present.

Returns active leads where `status = assigned` and `assignedTo` matches the requested user. Optional `limit` and `offset` use the same response shape as the lead list endpoint.

**Response `200`**

```json
{
  "success": true,
  "leads": [
    {
      "leadId": "crm_contact_123",
      "firstName": "Prospect",
      "lastName": "Customer",
      "phone": "+18135550100",
      "city": "Tampa",
      "state": "FL",
      "latitude": 27.9506,
      "longitude": -82.4572
    }
  ],
  "total": 1,
  "limit": 100,
  "offset": 0
}
```

No assignments is a normal success response:

```json
{ "success": true, "leads": [], "total": 0, "limit": 100, "offset": 0 }
```

| Status | Meaning |
|--------|---------|
| `200` | Assigned leads returned, including an empty result |
| `400` | Missing `locationId` or `userId` |
| `401` | Missing/invalid Workbench API key or operator session. `OPERATOR_SESSION_REQUIRED` means no header/cookie arrived; `OPERATOR_SESSION_INVALID` means the supplied session is invalid or expired. |
| `403` | CRM grant denied or the operator token does not match the API key, location, or user |

This static route must remain registered before `GET /api/leads/:id`; otherwise Express would interpret `assigned` as a lead ID.

---

## Bulk import

```http
POST /api/leads/bulk
```

```json
{
  "locationId": "fixture-field-04",
  "leads": [
    {
      "id": "lead_1",
      "serviceType": "solar",
      "contactData": {
        "name": "Prospect",
        "phone": "+1…",
        "email": "p@example.com"
      }
    }
  ]
}
```

- `contactData` may be an object (stringified) or string.  
- `INSERT IGNORE` — duplicate `id` is skipped.  
- Large batches supported (body limit up to 50mb on this path).
- When `tags`, `tag`, or `contactTags` are present, the API resolves the authoritative
  `serviceType` from the location's OWL service mappings. Without tags, the supplied service is kept.

**Response `200`**

```json
{ "success": true, "count": 1, "skipped": 0 }
```

---

## Pull / assign

```http
POST /api/leads/pull
Authorization: Bearer sp_live_...
X-Operator-Token: <session.token>
```

```json
{
  "locationId": "fixture-field-04",
  "userId": "usr_123",
  "serviceType": "solar",
  "count": 10
}
```

Selects compliant, unassigned leads for that location + service type, marks them `assigned` to the session-bound `userId`, and returns only the Dialer lead allowlist.

Leads are selected newest first. New CRM imports preserve the source contact's `dateAdded` value
when available rather than using only the local insertion time.

**Response `200`**

```json
{
  "success": true,
  "leads": [
    {
      "leadId": "crm_contact_123",
      "firstName": "Prospect",
      "lastName": "Customer",
      "phone": "+18135550100",
      "city": "Tampa",
      "state": "FL",
      "latitude": 27.9506,
      "longitude": -82.4572
    }
  ]
}
```

Empty pool: `{ "success": true, "leads": [] }`.

Uses a transaction with row locks (`FOR UPDATE`) to reduce double-assign races.

After a successful pull, refresh `GET /api/leads/assigned` to restore the agent's active queue across page reloads and devices.

## Authorize a call

Immediately before every outbound dial, send only the contact reference returned in the minimal lead DTO:

```http
POST /api/leads/call-attempts/authorize
Authorization: Bearer sp_live_...
X-Operator-Token: <session.token>
Content-Type: application/json

{ "contactId": "crm_contact_123" }
```

Workbench derives `locationId` and `userId` from the operator session, resolves `contactId` through the CRM source link, and reads jurisdiction from the complete current CRM payload. When required, it falls back to normalized imported fields and the latest EAGLE state fact. CRM timezones that conflict with a dependable state timezone are rejected; in particular, `UTC` is not accepted as a Florida lead timezone. If a split-zone state has no trusted CRM timezone, the server resolves an IANA timezone from stored lead coordinates through a fixed coordinate-only endpoint and caches the validated result for 180 days. Florida leads without an exact trusted zone use the safe overlap of the Eastern and Central company calling windows. No name, address, phone, contact ID, API key, or operator token is sent to the resolver. Client-supplied `state`, `stateCode`, timezone, coordinates, location, and user values are not required or trusted.

Authorization checks assignment ownership, submitted weekly schedule, DNC clearance, 8:00 AM-7:00 PM lead-local marketing hours, and Florida's rolling 24-hour attempt limit. Detailed decisions remain in OWL's compliance ledger.

```json
{ "success": true, "allowed": true, "authorizationId": "..." }
```

A denial is compact and may include `nextEligibleAt`:

```json
{ "success": false, "error": "Call not authorized", "code": "MARKETING_COMPLIANCE_BLOCK", "reason": "outside_marketing_hours" }
```

`POST /api/leads/{contactId}/call-attempts/authorize` remains as a compatibility alias.

## Service pool catalog

```http
GET /api/service-pools?locationId=LOCATION
```

Returns service rules, CRM tag keywords, calendar IDs, the default calendar, the fallback service, and a Vibe-compatible `mappings`
object. The Dialer should load this instead of treating `_sp_tag_mappings` in browser storage as
authoritative.

Resolve tags without writing a lead:

```http
POST /api/service-pools/classify
Content-Type: application/json

{ "locationId": "LOCATION", "tags": ["roof-repair", "priority"] }
```

Load or resolve scheduling calendars:

```http
GET /api/calendars?locationId=LOCATION
GET /api/calendars/resolve?locationId=LOCATION&serviceType=Roofing
GET /api/calendars/resolve?locationId=LOCATION&leadId=LEAD_ID
```

Each result provides `calendarIds`, `defaultCalendarId`, and `configured`. Calendar IDs are opaque,
location-scoped values managed in OWL. The Dialer must only submit an ID returned for the resolved
lead service.

---

## Status values

| status | Meaning |
|--------|---------|
| `uncontacted` | Available for pull |
| `assigned` | Assigned to an agent |
| `dnc_pending` | Quarantined until a recognized scrub result is imported |
| `no_phone` | Held outside phone systems until CRM supplies a valid phone; then returns to DNC Screening |
| `do_not_call` | Blocked and never assignable |

Further status transitions can be extended later if Vibe requires them.

Controlled transitions use `PATCH /api/leads/{id}/status` with `locationId`, `status`, and optional `lastContacted`. Ownership is taken from `X-Operator-Token`; callers cannot assign a different user. Release an assignment with `POST /api/leads/{id}/release` and `{ "locationId": "..." }`.

Status transitions are governed by OWL lead pool rules for the core source and location. Default
outcome statuses include `do_not_call`/`dnc`, `not_interested`, `appointment`/`scheduled`,
`closed_won`, `closed_lost`, and `closed_dnq`/`dnq`. The destination pool determines whether the
current owner is preserved, cleared, or required. Unmapped statuses are rejected by the controlled
status endpoint.

## DNCScrub pulse

Create a verified browser pulse for one lead:

```http
POST /api/leads/{leadId}/dnc-pulse
Content-Type: application/json

{
  "locationId": "LOCATION_ID",
  "url": "https://webapi.dncscrub.com/gohighlvl/contact-scrub.html?contactId=CONTACT_ID&locationId=LOCATION_ID&t=VENDOR_TOKEN"
}
```

`url` is optional. When omitted, Workbench uses the granted LeadConnector PIT to read
`GET /contacts/{contactId}/notes` and locate the DNCScrub note link even when the CRM Notes panel
does not render it. If no valid link exists, the endpoint returns `409` and leaves the lead pending.

The caller needs the integration's manage-leads grant. Workbench verifies the lead, location,
external CRM contact ID, exact HTTPS origin, and exact DNCScrub page path. It returns an
`action: browser_navigation` URL for Vibe to open. Workbench does not fetch the page because the
page's JavaScript performs the actual scrub/status requests. The vendor token is not stored;
only issuance metadata is written to `dnc_pulse_events`.

```js
const pulse = await response.json();
window.open(pulse.url, 'workbench-dnc-pulse');
```

After the widget finishes, refresh that one lead from LeadConnector:

```http
POST /api/leads/{leadId}/dnc-refresh
Content-Type: application/json

{ "locationId": "LOCATION_ID" }
```

This reads the current contact tags through the stored PIT and atomically updates `dncStatus` and
the lifecycle pool. Vibe may poll this endpoint while it remains `pending`; it must not request or
assign the lead until the response is `clean`.

### Screening states

`dncStatus` is independent from lifecycle status and is always one of:

| DNC state | Recognized CRM tags | Assignment behavior |
|-----------|---------------------|---------------------|
| `blocked` | `dnc-blocked`, legacy `dnc`, `do not call`, `do-not-call`, `do_not_call` | Routed to DNC and unassigned |
| `review` | `dnc-review` | Held non-callable in DNC Screening; not counted as a DNC-list match |
| `clean` | `dnc-clean`, `dnc-wireless` | May enter Available and be assigned |
| `pending` | No recognized result, including legacy `dnd` | Routed to DNC Screening and unassigned |

Blocked tag precedence wins if a record contains both blocked and clean tags. Assignment, release
to Available, controlled assignment-status changes, Dialer pull, and appointment creation all fail
closed unless `dncStatus = clean`.

Schema version 13 performs a one-time quarantine of existing `uncontacted` and `assigned` rows:
they are unassigned and moved to DNC Screening with `dncStatus=pending`. A full CRM import then
promotes recognized clean results or moves blocked results to DNC.
