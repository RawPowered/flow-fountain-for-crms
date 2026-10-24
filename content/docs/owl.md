# OWL Operations Console

OWL is the Super Admin operations console for the dialing system. It manages supported dialer records through fixed, parameterized domain commands. OWL never accepts raw SQL and never exposes database credentials.

Admin UI:

```text
{ADMIN_BASE_PATH}/owl
```

OWL requires an authenticated administrator session. Its routes are not machine API endpoints and do not accept a Dialer Bearer key as administrator authentication.

### Administrative authority

Administrative identity is deliberately separated from dialer identity. Role titles shown in OWL
are presentation labels; authorization uses fixed server-side principal types and capabilities.

| Authority | Storage | Display title | Scope | May delegate |
|-----------|---------|---------------|-------|--------------|
| Root owner | `admin_users` | Root Custodian | Entire platform | System Stewards, Workspace Custodians, dialer users |
| Platform administrator | `platform_administrators` | System Steward | Entire platform except root ownership | Workspace Custodians and dialer users |
| Tenant administrator | `tenant_administrators` | Workspace Custodian | One active API key and its granted CRM locations | Dialer users only |
| Dialer user | `users` | Dialer Operator or Dialer Lead | One operational location | Nothing |

The installer creates the only application-managed `admin_users` root record. OWL has no route for
creating, replacing, disabling, or demoting that record. Only the root owner can create a System
Steward. Tenant administrators cannot select another API key through UI manipulation or direct HTTP
requests, and locations are intersected with that key's enabled CRM integration grants.

Administrative and dialer passwords are hashed with bcrypt at cost 12. Creation requires 12-128
characters containing upper-case, lower-case, and numeric characters. Passwords and password hashes
are never returned or written to OWL audit payloads. Successful login regenerates the session ID;
admin cookies remain HTTP-only and SameSite Strict.

---

## Context model

Every OWL operation has three explicit context values:

| Context | Purpose |
|---------|---------|
| API key | Determines which database sources and grants are available |
| Source | Selects the legacy core database or one SQL Connection Hub database |
| Location | Restricts operational rows to one dialing location |

The header selectors are authoritative. Changing any selector reloads the console; context is not inferred from a row submitted by the browser.

### Legacy core behavior

`core` is the default source for every active API key. This preserves the historical deployment model where most keys operate against the platform database without an explicit SQL Connection Hub grant.

Additional sources appear only when the selected API key has a connection grant. OWL does not fall back from a denied secondary source to core. Select `core` explicitly when legacy data is intended.

---

## Safety boundaries

- Domain operations only; no SQL editor or arbitrary query parameter.
- Parameterized values and fixed table/column identifiers.
- Secondary sources require the selected key's table operation grant.
- Secondary source column allowlists are enforced for reads and writes.
- Mutations require `SELECT` access for before/after audit snapshots in addition to their write operation.
- Location IDs are required for operational data changes.
- Lead bulk assignment is limited to 500 unique lead IDs per request.
- Every OWL mutation writes an audit event to the core `owl_audit_events` table.
- Database passwords remain encrypted in SQL Connection Hub and are never returned to OWL.

If a capability or required column is not granted, that operation returns `403` rather than silently using another source.

---

## Operator modules

| Module | Operations |
|--------|------------|
| Service Pools | CRM tag mappings, Dialer routing inventory, controlled reclassification, and lifecycle destinations |
| Leads | Search/filter, edit controlled fields, bulk assign, bulk unassign |
| Users | Create credentialed dialer users and delegate permitted administrative accounts |
| Dialers | Monitor user workspace state and latest API login activity |
| Schedules | Inspect and upsert per-user dialer schedules |
| Audit | Review OWL actions by key, source, location, actor, and entity |

### DNC screening workflow

The **DNC Screening** lifecycle card includes **Screen leads** for the selected core location.
The queue contains leads whose lifecycle is in the DNC Screening pool and whose `dncStatus` is
`pending` or `review`. Pending leads are ordered first so existing review holds cannot starve new
screening work.

1. Select **Scrub lead** for one lead, or **Scrub all pending leads** for a server-bounded batch.
2. OWL extracts valid 10-digit North American numbers from Primary Phone, Alternative Phone, and
   Phone 3, deduplicates them, and validates every value through provider-sized DNCScrub batches.
   Every OWL scrub and re-scrub entry point may promote a documented clean alternate into Primary
   Phone while moving the prior Primary value into that alternate's slot.
3. Documented callable result codes (`C`, `E`, `O`, `X`, `W`, `G`, `H`, `Y`) become `clean`.
   Only list matches (`D` external DNC and `P` Internal/Project DNC) become terminal `blocked`
   results. Provider prohibitions that are not proof of a DNC-list match (`B`, `I`, `M`, `L`, `F`,
   `V`) become non-callable `review` holds and remain in DNC Screening.
4. Unknown codes, missing responses, provider errors, and timeouts remain pending. A contact without
   a valid phone moves to **No Phone** and is removed from repeat DNCScrub batches. Neither state is
   Dialer assignable.

No number with provider result `B`, another review code, an unknown result, or a DNC-list result is
promoted. No Answer recovery additionally requires a different clean Alternative Phone or Phone 3;
when none exists, OWL fails closed and HAWK routes the contact to outcome review instead of requeueing
the same number.

After a definitive all-phone scrub, OWL writes one CRM contact note listing each phone slot, formatted
number, provider result code, and result label. The note also records which alternate was promoted.
Phone values remain excluded from OWL API responses, audit metadata, and Sentinel telemetry.

**Scrub all pending leads** selects only `pending` records. It uses a fixed cutoff and
`dncLastRescrubAt`, so every pending row is attempted once per resumable run even when DNCScrub omits
a result or returns an unknown code. A `B` result moves to `review` and will not be selected again by
that action. Use **Re-scrub review holds** only after correcting or intentionally
revalidating DNCScrub project, coverage, geography, campaign, or source-data configuration. That action
uses a fixed cutoff and `dncLastRescrubAt`, so every review hold is attempted once per resumable run
even when the provider returns `B` again.

OWL preserves DNCScrub's sanitized `Reason` text and adds a stable review category:

| Codes | OWL category | Handling |
|-------|--------------|----------|
| `D` | DNC registry match | Blocked; the reason identifies National, State, Litigator, or combined matches |
| `P` | Internal DNC match | Terminal DNC; only a governed Internal DNC correction may change it |
| `B` | Configuration or coverage | Non-callable review; may represent an uncovered/configured no-call area code rather than a person-level registry match |
| `I`, `M` | Invalid contact data | Non-callable review for phone-data correction |
| `L`, `F`, `V` | Jurisdiction restriction | Non-callable review; wireless solicitation restrictions remain authoritative |

Review holds never become callable automatically. They identify outcomes needing a compliance
administrator to verify project coverage, geography configuration, jurisdiction rules, or source data.
They are excluded from the terminal DNC population so OWL's DNC count represents actual external or
Internal/Project DNC matches.

For a location where the provider's Florida behavior makes `B` inconclusive, **Release B holds to dial
population** provides an explicit administrative override. It releases only rows whose stored result is
`B` and category is `configuration_or_coverage`. The action preserves the provider code and reason,
records `owl_review_override` / `manual_configuration_override`, creates per-lead DNC pulse evidence,
writes an OWL audit containing the administrator's reason, clears ownership, moves the rows to the first
enabled assignable pool, and synchronizes the clean operational state to GHL. It cannot release `D` or
`P` true-DNC matches, or `I`, `M`, `L`, `F`, and `V` data/jurisdiction review codes.
The release changes DNC queue eligibility only; consent, channel preferences, local calling windows,
Florida attempt limits, and other pre-call compliance controls continue to apply.

The DNC dialog shows every result and reason from the latest run; the Leads table retains the latest
provider code, reason, category, and review flag after the dialog is closed.

The queue table is a compact, 40-row paged view. It returns only the display name and DNC evidence needed
by the dialog, never the complete CRM `contactData` document. Queue counts still cover the entire pending
and review population, and bulk scrub runs continue independently of the visible page.

Clean results move from DNC Screening to the first enabled assignable pool. Blocked results move to
the terminal DNC pool and clear ownership. OWL stores the result source, provider code, sanitized
reason, and check time on the lead. Subsequent CRM imports cannot downgrade an API result to pending
merely because a result tag is absent; an explicit blocked CRM tag can still enforce a block.
Here, `clean` means the configured DNC scrub did not block the number or an administrator explicitly
released an eligible `B` hold; `dncSource` and `dncDecisionCategory` distinguish those cases. It is not
evidence of consent, an established-business relationship, or reassigned-number clearance; those
policies remain separate.

Configure `DNC_SCRUB_KEY` only in the protected Node environment or hosting secret store. The optional
`DNC_SCRUB_PROJECT_ID` and `DNC_SCRUB_CAMPAIGN_ID` can pin specific provider rules when those identifiers
are known. When omitted, DNCScrub resolves the context associated with the API key; its public API
documentation does not define that selection behavior. Restart the application after changes.
The key is sent in the upstream `loginId` header and is never sent to the
browser, stored in SQL, included in a URL, or written to OWL/Sentinel logs. Provider phone values and
raw response bodies are also excluded from logs. Sentinel records the actor, action, scoped API key,
location, lead/batch entity, status, duration, and outcome. OWL audit records only sanitized result
metadata and aggregate counts. Batch HTTP responses contain compact result evidence and a bounded
top-reason summary so normal 50-record responses remain within Sentinel's forensic body limit; a
forensic `truncated` marker describes evidence capture only and does not mean the application response
failed.

OWL defaults to 50 numbers per synchronous provider POST. Larger OWL actions are resumable runs: each
Workbench request selects at most one configured provider batch, commits that batch, and continues from
the fixed run cutoff. This keeps provider latency inside common web-request timeouts even though
DNCScrub documents a much larger API maximum. A process-wide scheduler defaults to 30 requests per
minute, leaving substantial headroom below the documented 100 POST requests/minute limit. Every
initial request and retry obtains a scheduler slot. HTTP 429,
5xx, network, and timeout retries use bounded exponential backoff and honor `Retry-After` up to five
seconds. Configure `DNC_SCRUB_REQUESTS_PER_MINUTE` only if a lower account-specific limit applies;
the application clamps it to a safety maximum of 30. `DNC_SCRUB_BATCH_SIZE` is likewise clamped to
50, so legacy environments that still specify `500` cannot recreate the former oversized OWL call.

The legacy CRM tag-check routes remain available for operational compatibility. API results are the
authoritative screening source used by the OWL interface.

### Channel pools and No Phone

Phone DNC and CRM do-not-disturb preferences are channel-specific. OWL maintains one canonical lead
while independently classifying Phone, Email, and SMS:

| CRM evidence | Phone | Email | SMS |
|--------------|-------|-------|-----|
| `DND Phone` | Blocked | Unchanged | Unchanged |
| `DND Email` | Unchanged | Blocked | Unchanged |
| `DND SMS` | Unchanged | Unchanged | Blocked |
| No valid phone | Unavailable; lifecycle moves to **No Phone** | Available only with a valid email and no `DND Email` | Unavailable |

The Email and SMS cards are overlapping channel memberships, not lifecycle statuses, so the same
lead may appear in both without being duplicated. `available` means the contact has usable channel
data and no matching CRM DND tag. It is not proof of opt-in, consent, an EBR, or campaign permission;
send-time unsubscribe, consent, quiet-hours, and campaign policies still apply.

CRM imports refresh channel membership automatically. **Check for phones** on the No Phone card
re-reads the current CRM contact in batches of up to 500. A contact still lacking a valid phone stays
in No Phone. A restored phone moves only to DNC Screening and must receive a definitive clean scrub
before it can enter phone systems. Sentinel and OWL Audit record the batch action without logging
phone numbers, email addresses, CRM credentials, or raw contact bodies.

### Re-scrubbing the DNC pool

Use **Re-scrub DNC pool** in the DNC Screening dialog to re-evaluate leads currently held in the
terminal DNC pool. The action requires an explicit confirmation and processes at most
`DNC_SCRUB_BATCH_SIZE` leads per Workbench request (50 by default). OWL continues through the run in
ordered, rate-spaced batches and retains a fixed run cutoff, so an interrupted run can resume without
reprocessing completed batches.

A true DNC result remains blocked until DNCScrub returns a recognized, definitive clean code. Repeated
`D`/`P` results stay in DNC. A non-list prohibition (`B`, `I`, `M`, `L`, `F`, `V`) moves the lead from
terminal DNC to a non-callable review hold; a clean result moves it to the first enabled assignable
pool. Missing responses, unknown result codes, and provider errors preserve the previous blocked
decision and are shown as unresolved.

OWL stores `dncLastRescrubAt` separately from the last definitive `dncCheckedAt` decision. Changed
decisions include sanitized before/after evidence in the OWL batch audit, while Sentinel records the
administrator, tenant scope, location, action, outcome, and timing without credentials or phone values.
The existing process-wide DNCScrub throttle and retry policy applies to every re-scrub batch.

### Pulling leads from CRM

The Leads module can queue an exhaustive full sync from a configured LeadConnector PIT or
`example.invalid` integration. A source appears only when:

- OWL is operating on the legacy `core` source.
- The integration location equals the selected OWL location.
- The selected API key has the integration's import grant.
- The integration is enabled, uses the official LeadConnector API origin or HTTPS on
  `example.invalid`, and has an encrypted credential.

Use **CRM integrations -> LeadConnector PIT defaults** to configure the primary source:

```text
Base URL:      https://services.leadconnectorhq.com
Contacts path: /contacts/
Auth scheme:   Bearer
Version:       2021-07-28
```

The Workbench API key selects and authorizes the integration; it is not sent upstream. The
separate encrypted PIT authenticates the LeadConnector request. OWL polls the import
run and refreshes lead pools when it completes. It follows every CRM cursor until exhaustion,
stores the complete current contact payload and custom fields, and does not replace existing
`leads.contactData`.

Dialer monitoring is based on `dialer_workspaces` and `api_login_events`. A secondary source without these granted tables will show the user roster but no corresponding monitoring data.

### Service pool routing

A Dialer lead pool is a service pool. Rules are stored in `owl_service_pools`, scoped by database
source and location, resolve CRM tags into the durable `leads.serviceType` value, and assign the
allowed/default scheduling calendars returned to the Dialer.

The public release starts with no service pools or keyword mappings. Add your own
service names, keywords, fallback, and calendars in the administration interface.

Matching is case-insensitive substring matching in configured service order. The first match wins.
CRM imports and `POST /api/leads/bulk` use these rules for new leads. Existing leads are never
overwritten by ingestion. OWL can preview reclassification before an administrator applies it;
leads without tags retain their current service.

Service routing and lifecycle routing are independent. Changing a lead's service does not change
its status or owner, and changing its lifecycle destination does not change its service.

### Lifecycle destination routing

Pool definitions are stored in the core control plane and scoped by selected database source and
location. They do not add a new column to existing lead tables. Instead, each pool groups one or
more durable `leads.status` values and defines the canonical status written when a lead is moved.

| Required pool | Default statuses | Ownership | Lifecycle |
|---------------|------------------|-----------|-----------|
| DNC Screening | `dnc_pending`, `pending_dnc`, `dnd` | Clear owner | Non-assignable |
| No Phone | `no_phone` | Clear owner | Non-assignable holding pool |
| Available | `uncontacted` | Clear owner | Dialer assignable |
| Assigned | `assigned` | Require owner | Active |
| Working | `contacted` | Keep owner | Active |
| Scheduled | `appointment`, `scheduled` | Keep owner | Active |
| DNC | `do_not_call`, `dnc` | Clear owner | Terminal |
| Not Interested | `not_interested` | Clear owner | Terminal |
| Closed Won | `closed_won` | Keep owner | Terminal |
| Closed Lost | `closed_lost` | Clear owner | Terminal |
| Closed DNQ | `closed_dnq`, `dnq` | Clear owner | Terminal |
| Invalid | `invalid` | Clear owner | Terminal |

Required lifecycle pools cannot be disabled. At least one enabled pool must remain Dialer
assignable. Status aliases cannot be assigned to more than one pool in the same source/location.

Ownership policies are enforced server-side:

- **Clear owner** writes `assignedTo = NULL`.
- **Keep owner** changes status without changing `assignedTo`.
- **Require owner** rejects the move unless a valid user in the selected location is supplied.

The Dialer's `POST /api/leads/pull` reads the enabled assignable pools and writes the configured
Assigned destination. Controlled status updates reject values that are not routed to an enabled
pool. Existing unknown statuses remain visible in OWL as **Unmapped** until an administrator adds
them to a rule.

Creating an appointment also routes its lead to the configured Scheduled destination in the same
database transaction while applying the Scheduled pool's ownership policy.

### Call Center outcomes (HAWK → OWL)

Custom Manual Call dispositions (GHL `Call_outcome`):

| Disposition | Stored / matched values | CRM tag | OWL pool |
|-------------|-------------------------|---------|----------|
| No Answer | `no_answer`, `No Answer` | `cc-await-retry` | — (hold) |
| Voicemail | `voicemail`, `Voicemail` | `cc-await-retry` | — (hold) |
| Follow Up | `follow_up`, `Follow Up` (+ legacy `callback`) | `cc-await-callback` | — (hold) |
| Requested Appointment | `requested_appointment`, `Requested Appointment` (+ legacy `scheduled`) | `cc-scheduled` | Scheduled → `appointment` |
| Not Interested | `not_interested`, `Not Interested` | `cc-not-interested` | Not Interested → `not_interested` |
| Incorrect Number | `incorrect_number`, `Incorrect Number`, `wrong_number`, `Wrong Number` | `cc-invalid` | **Invalid** → `invalid` |
| No Longer At Address | `no_longer_at_address`, `No Longer At Address` | `cc-invalid` | **Invalid** → `invalid` |

HAWK **Manual Call Outcome Router** stamps tags/status text, writes a dials history row, and runs
`workbench.apply_call_outcome` for OWL terminals (`scheduled`, `not_interested`, `invalid`).

**Closed Won / Lost / DNQ** are not written to OWL from HAWK yet. Use CRM tags
(`cc-converted-sale` / `cc-closed-won`, `cc-closed-lost`, `cc-dnq`). OWL **recheck** skips those
tags plus `cc-invalid` / `cc-not-interested` / `cc-scheduled` so “Queue missing” / `cc-recheck`
cannot re-enroll them while the tag remains.

---

## Required tables

OWL recognizes these domain tables:

| Table | Used by |
|-------|---------|
| `leads` | Pools, lead management, assignment |
| `users` | Users, assignment validation, dialer roster, schedule labels |
| `user_schedules` | Schedule monitoring and updates |
| `dialer_workspaces` | Dialer workspace monitoring |
| `api_login_events` | Latest dialer login activity |

Core uses the existing legacy schema. For a secondary source, table and column names must match this domain contract. OWL does not dynamically create or alter operational tables.

---

## Admin route catalog

All paths below are relative to `{ADMIN_BASE_PATH}` and require an admin session.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/owl` | Operations console |
| GET | `/api/owl/bootstrap` | Active keys and sources for a selected key |
| GET | `/api/owl/locations` | Locations visible in the selected context |
| GET | `/api/owl/summary` | Context totals |
| GET | `/api/owl/pools` | Lead pool aggregates |
| GET | `/api/owl/service-pools` | Service rules, tag mappings, and service metrics |
| PUT | `/api/owl/service-pools` | Create or update a service tag rule |
| PUT | `/api/owl/service-pool-calendars` | Set `serviceType`, allowed calendar IDs, and default ID |
| POST | `/api/owl/service-pools/move` | Move selected leads to a service |
| POST | `/api/owl/service-pools/reclassify` | Preview or apply CRM tag classification |
| GET | `/api/owl/pool-management` | Pool rules, live counts, and unmapped statuses |
| PUT | `/api/owl/pool-rules/{poolKey}` | Create or update a governed pool rule |
| POST | `/api/owl/pools/move` | Move selected leads using destination ownership policy |
| GET | `/api/owl/leads` | Filtered lead list |
| GET | `/api/owl/lead-sources` | Granted LeadConnector PIT or Custom CRM sources |
| POST | `/api/owl/leads/pull` | Queue an exhaustive full CRM contact sync |
| GET | `/api/owl/leads/pulls/{runId}` | Read pull progress and counters |
| GET | `/api/owl/dnc-screening` | List pending and review-held leads, with separate counts |
| POST | `/api/owl/dnc-screening/{leadId}/scrub` | Scrub one pending lead through DNCScrub |
| POST | `/api/owl/dnc-screening/scrub` | Scrub one configured provider batch of new pending leads through DNCScrub |
| POST | `/api/owl/dnc-review-rescrub` | Explicitly re-scrub every review hold once in a resumable cutoff-bound run |
| POST | `/api/owl/dnc-review-release` | Explicitly release only provider `B` configuration/coverage holds into the assignable population |
| POST | `/api/owl/no-phone/refresh` | Re-read up to 500 No Phone contacts and route restored phones to DNC Screening |
| POST | `/api/owl/dnc-screening/{leadId}/tag-check` | Check one lead against current CRM result tags |
| POST | `/api/owl/dnc-screening/tag-check` | Check up to 50 pending leads from paginated CRM contact feeds |
| PATCH | `/api/owl/leads/{id}` | Update controlled lead fields |
| POST | `/api/owl/leads/assign` | Assign lead IDs to one user |
| POST | `/api/owl/leads/unassign` | Return lead IDs to the available pool |
| GET | `/api/owl/users` | Location users |
| POST | `/api/owl/users` | Create a user |
| PATCH | `/api/owl/users/{id}` | Edit a user |
| GET | `/api/owl/access/accounts` | List delegated accounts visible to the current authority |
| POST | `/api/owl/access/accounts` | Create an allowed delegated administrative account |
| GET | `/api/owl/dialers` | Dialer/workspace status |
| GET | `/api/owl/schedules` | Location schedules |
| PUT | `/api/owl/schedules/{userId}` | Upsert a schedule |
| GET | `/api/owl/audit` | OWL mutation history |

The context query parameters are `apiKeyId`, `source`, and, where required, `locationId`. Mutation bodies carry the same context and the domain-specific values.

Calendar assignment body:

```json
{
  "apiKeyId": "WORKBENCH_KEY_ID",
  "source": "core",
  "locationId": "LOCATION_ID",
  "serviceType": "Roofing",
  "calendarIds": ["calendar_roofing", "calendar_roofing_overflow"],
  "defaultCalendarId": "calendar_roofing"
}
```

The default must be one of the allowed IDs. Removing every ID leaves that service unconfigured;
the Dialer calendar catalog reports `configured: false`.

---

## Deployment

After upgrading, apply the current schema version (39):

```bash
npm run migrate
```

This creates the delegated platform/tenant administrator tables and OWL control tables plus the current CRM contact and custom-field catalogs. Existing lead, user, assignment,
workspace, and schedule rows are not migrated or overwritten. Default pool rules are seeded
lazily for each source/location when OWL or the Dialer first resolves its routing policy.

Related: [SQL Connection Hub](sql-connections), [Leads](leads), [Schedules](schedules), [Sentinel](sentinel).
