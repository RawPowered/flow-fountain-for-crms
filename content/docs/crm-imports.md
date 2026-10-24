# CRM ingestion

Workbench can pull CRM contacts into the existing dialer lead queue without overwriting existing lead rows. CRM credentials are encrypted at rest and are never returned to machine clients.

---

## Safety model

| Rule | Behavior |
|------|----------|
| Protected operational data | Imports do not replace existing `leads.contactData`; only governed DNC/lifecycle state may change |
| Stable source identity | `(integration_id, external_record_id)` is unique |
| Location binding | Payload location must match the integration location |
| Immutable staging | Every received record is hashed and recorded with its import run |
| Current CRM record | Every linked contact has one replaceable current payload plus immutable per-run staging |
| Collision handling | Cross-location ID collisions receive a generated Workbench lead ID and an audit conflict |
| Default deny | API keys require an explicit integration grant |

Imported custom fields are stored in a discovered field catalog and current typed sidecar values.
The complete contact response is retained in `crm_contact_records.payload_json`; remote payload keys
never create arbitrary SQL columns. This preserves new provider fields automatically without risking
the operational schema.

---

## Configure an integration

Open `{ADMIN_BASE_PATH}/crm-integrations` as an admin. Configure:

- CRM API base URL and encrypted credential.
- Fixed `locationId`.
- Contacts endpoint and response paths.
- Cursor parameter and next-cursor response path.
- Optional API version header and updated-after parameter.
- API-key permissions: read, import, and manage leads.

The default adapter expects records at `contacts`, contact IDs at `id`, and location IDs at `locationId`. All paths are configurable dot paths.

### Primary: LeadConnector Private Integration Token

Click **LeadConnector PIT defaults** and enter the sub-account's Private Integration Token. The
server fixes the upstream origin to `https://services.leadconnectorhq.com`, sends
`Authorization: Bearer <PIT>`, and caps contact pages at 100 records. The PIT must include the
`contacts.readonly` scope and belong to the configured location/sub-account.

The PIT belongs to the integration, not to a Workbench Dialer key. Grant every applicable
Workbench API key access to the same integration. This allows multiple Dialers or alternate API
keys to reuse one encrypted credential without storing duplicate PITs or exposing it to browsers.

A Custom CRM browser contact URL such as
`https://crm.example.invalid/v2/location/{locationId}/contacts/detail/{contactId}` is a CRM
UI route, not an API base URL. The admin form can parse this URL to populate `locationId`; keep the
LeadConnector API base set to `https://services.leadconnectorhq.com`.

Private Integration Tokens are static. Rotate them from HighLevel every 90 days, paste the new
token into the integration, test it, and then expire the old token after the provider's overlap
window. OWL reports whether the stored credential is current, nearing rotation, or due.

For the Custom CRM alternative, click **Custom CRM defaults** in the admin form. This sets the direct source to
`https://crm.example.invalid/backend/contacts/`. Store the Custom CRM API credential in
the integration and grant the calling Workbench key import permission. OWL then exposes the
source under its Leads tab for the matching location.

Example configuration:

```json
{
  "contactsPath": "/contacts/",
  "recordsPath": "contacts",
  "idPath": "id",
  "locationPath": "locationId",
  "locationParam": "locationId",
  "limitParam": "limit",
  "cursorParam": "startAfterId",
  "cursorTimeParam": "startAfter",
  "nextCursorPath": "meta.startAfterId",
  "nextCursorTimePath": "meta.startAfter",
  "updatedAfterParam": "updatedAfter",
  "version": "2021-07-28",
  "defaultServiceType": "Other"
}
```

---

## Validate and backfill

Save a new integration before selecting **Test saved connection**. Testing an unsaved form has no
integration ID and is rejected with `400` instead of being sent to a nonexistent route.

Test upstream access:

```http
POST /api/crm/integrations/{integrationId}/test
```

Before the first CRM import, link production leads already in the queue:

```http
POST /api/crm/integrations/{integrationId}/backfill
```

Backfill parses existing `contactData`, creates source links and discovered values, and does not update the `leads` table. Invalid JSON and identity conflicts are recorded for review.

---

## Run an import

```http
POST /api/crm/integrations/{integrationId}/imports
Content-Type: application/json

{
  "dryRun": true,
  "full": false,
  "pageSize": 100,
  "maxPages": 1,
  "defaultServiceType": "Other"
}
```

The endpoint returns `202` with a `runId`. Poll:

```http
GET /api/crm/imports/{runId}
```

After validating the bounded dry run, start the one-time exhaustive load with `{ "full": true,
"pageSize": 100 }`. A full run intentionally ignores `maxPages`.

Review conflicts with `GET /api/crm/imports/{runId}/conflicts`.

Read the complete current contact payloads without expanding every Dialer lead response:

```http
GET /api/crm/integrations/{integrationId}/contact-records?limit=100&afterId={lastExternalId}
```

Follow `nextAfterId` until it is `null`. Add `includeInactive=true` to include contacts retained in
history but absent from the latest conflict-free full sync. `GET
/api/crm/integrations/{integrationId}/fields` returns both flattened payload fields and the current
provider custom-field definitions.

An administrator can initiate the same import from **OWL -> Leads -> Run full CRM sync**. OWL accepts
granted integrations on the official LeadConnector API origin or HTTPS `example.invalid`,
provided the integration location matches the selected key and location.

LeadConnector pages are capped at 100 contacts, but a full sync has no normal page-count cutoff.
Workbench follows the compound `startAfter` and `startAfterId` cursor until the upstream returns an
empty page, a short terminal page, or no continuation cursor. A 100,000-page ceiling exists only to
stop a defective or circular provider cursor. The saved checkpoint, expected upstream count, page
count, and completion reason are exposed in run status for recovery and reconciliation.

Direct `services.leadconnectorhq.com` integrations use the recommended `POST /contacts/search`
endpoint with explicit `page` and `pageLimit` values. Custom CRM and compatibility integrations use
compound cursors derived from the last returned contact's `id` and `dateAdded`; response
`meta.startAfter*` values are not authoritative because the legacy endpoint can echo stale metadata.
Pages are processed sequentially with a 250 ms default interval (`pageDelayMs` in integration
configuration, 0-5000 ms). Overlapping records are counted once, and a page with no new contact IDs
is retried with backoff before the run fails.

At the start of every live LeadConnector sync, Workbench requests all custom-field definitions with
`model=all`. Each contact is then stored in three forms: immutable run staging, a complete current
JSON record, and typed current field values for querying. Missing contacts are marked non-current
only after a conflict-free full run reaches a valid terminal condition; records are not deleted.
New operational leads preserve CRM `dateAdded`, and Dialer assignment selects the newest available
lead first.

`model=all` discovers field definitions for contacts, opportunities, and supported custom models.
This contact sync stores every custom-field value returned on each contact. It does not claim to
snapshot separate opportunity or custom-object records; those require their own provider resource
endpoints and should be added as independent object syncs so contact completeness is never inferred
from a different object feed.

Every imported contact is classified independently for DNC screening. Missing result tags and the
legacy `dnd` tag are treated as pending, not clean. `dnc-blocked` routes to DNC, `dnc-review` routes
to non-callable screening, and `dnc-clean` and `dnc-wireless` are clean outcomes. Incremental imports update only the operational DNC state and
lifecycle routing for existing leads. The protected `leads.contactData` value remains add-only,
while `crm_contact_records` and `lead_import_values` are refreshed to reflect the current CRM data.

Recommended rollout:

1. Backfill existing leads.
2. Run one-page dry run.
3. Run one live page.
4. Repeat the same page and confirm all records are skipped.
5. Run the exhaustive full import and reconcile `recordsFetched` against `expectedRecords` when supplied.
6. Enable incremental imports only after counts are verified.
