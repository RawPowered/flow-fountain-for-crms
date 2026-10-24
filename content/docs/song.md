# SONG script orchestration

SONG is the versioned call-script and flow-logic system for the Workbench Dialer. Administrators design drafts under the secret admin path at `{ADMIN_BASE_PATH}/song`; Dialers can read only an immutable published runtime graph assigned to their API key, location, service pool, and language.

## Safety model

- Draft saves use optimistic `draftRevision` checks. A stale editor receives `409 SONG_REVISION_CONFLICT` instead of overwriting another session.
- Publish creates a new immutable `song_script_versions` row with a SHA-256 checksum.
- `song_service_assignments` points one tenant/location/service pool to an exact published version.
- `song_service_language_assignments` points each tenant/location/service/language combination to its default published version.
- Every script carries a canonical BCP 47 `languageCode` such as `en-US` or `es-US`. Service cannot be changed after first publication. Administrators can reclassify the language through SONG without changing the published wording or flow.
- Archive removes the active assignment but preserves drafts, versions, audits, and analytics.
- There is no destructive script-delete endpoint.
- Runtime events are append-only. Metadata is capped at 4 KB and secret-bearing keys are removed.
- Admin routes enforce the logged-in administrator's API-key and location scope and write OWL audit events.

## Graph contract

A draft graph contains:

```json
{
  "schemaVersion": 1,
  "startNodeId": "greeting",
  "variables": [
    { "key": "firstName", "label": "First name", "source": "lead.firstName", "defaultValue": "" }
  ],
  "nodes": [
    {
      "id": "greeting",
      "type": "prompt",
      "title": "Greeting",
      "goal": "Confirm the homeowner",
      "prompt": "Hi {{firstName}}, this is {{agentName}}.",
      "helperText": "Confirm the correct person.",
      "required": true,
      "trackAnalytics": true,
      "position": { "x": 360, "y": 70 },
      "actions": [],
      "branches": [
        {
          "id": "confirmed",
          "label": "Confirmed",
          "outcome": "confirmed",
          "targetNodeId": "qualification",
          "condition": null,
          "actions": []
        }
      ]
    }
  ]
}
```

Supported node types include prompt, question, qualification, value, objection, action, appointment, voicemail, disposition, confirmation, and end. Supported actions include call authorization, disposition, appointment booking, release, operator-input capture, runtime-variable assignment, event emission, and script completion. Branches may include an `agentResponse` shown after selection and before advancing.

Branch conditions support `all`/`any` groups with equals, not-equals, contains, not-contains, exists, not-exists, greater-than, less-than, and membership operators.

## Validation and compilation

Publication checks:

- Unique and syntactically valid node, branch, and variable IDs.
- Existing start and branch-target nodes.
- Declared template variables and allowlisted runtime sources.
- Supported condition and action types.
- Maximum 100 nodes, 12 branches per node, 50 variables, and 512 KB per graph.
- Reachability from the start step.
- At least one End, Disposition, or Voicemail terminal.
- A terminal path from every reachable step.

The compiled Dialer graph removes canvas positions, draft state, author identities, validation internals, and version history. Runtime traversal is capped at 100 transitions.

## Variable catalog and picker

The **+ Variable** control opens a searchable field picker instead of inserting the first configured variable. The catalog is scoped to the selected API key and CRM location and combines:

- standard contact, geography, marketing, and operator fields;
- current provider definitions from `crm_object_field_definitions` using their readable field names;
- additional fields discovered during imports in `crm_field_definitions`.

Selecting a field declares it once and inserts `{{variableKey}}` at the saved prompt cursor or replaces the selected prompt text. Existing declarations are marked **Added** and reuse the same key. The catalog may expose thousands of available fields while the published script remains bounded to 50 declared variables.

Dynamic CRM sources use `field.FIELD_ID_OR_KEY`. They are resolved by the API from the assigned lead's current CRM/import data; the dialer does not need to receive the complete lead record.

## Changing an existing script language

Draft scripts can change language as part of a normal draft save. For a published script, use the **Apply language to published script** control in the Variables tab. SONG performs the change as one transaction:

- reads the currently published immutable graph rather than unpublished draft edits;
- creates a new immutable version with the selected canonical BCP 47 language;
- moves the language-specific default assignment to that version;
- restores another published script as the former language default when one is available;
- updates the legacy English service default when moving into or out of `en-US`;
- records `song.script.language_change` in the OWL/Sentinel audit stream.

The scoped administrative endpoint is:

```http
POST {ADMIN_BASE_PATH}/api/song/scripts/SCRIPT_ID/language
Content-Type: application/json

{
  "apiKeyId": "TENANT_API_KEY_ID",
  "locationId": "CRM_LOCATION_ID",
  "languageCode": "es-US"
}
```

Published reclassification does not publish later draft wording. Save and publish those edits separately.

## Dialer runtime

Discover published scripts before loading a graph:

```http
GET /api/song/scripts?serviceType=Roofing&languageCode=es-US&q=initial%20outreach&limit=25
Authorization: Bearer WORKBENCH_API_KEY
X-Operator-Token: OPERATOR_SESSION_TOKEN
```

The catalog is scoped by the Bearer key, operator-session location, optional service type, and optional BCP 47 language code. It returns only `scriptId`, service, `languageCode`, name, description, current published version metadata, checksum, `isDefault`, and `isLanguageDefault`. It never returns drafts or graph content. Results place the language default first, then the service default, and then sort by name. Use the stable `scriptId` for selection; names are display and search values and are not guaranteed identifiers.

Use both credentials:

```http
GET /api/song/runtime?serviceType=Roofing&languageCode=es-US&scriptId=SCRIPT_ID&leadId=LEAD_ID
Authorization: Bearer WORKBENCH_API_KEY
X-Operator-Token: OPERATOR_SESSION_TOKEN
```

The operator session supplies and cross-checks the API key and location. When `scriptId` is supplied, SONG loads that script only if its current published version belongs to the same API key, location, service type, and supplied language. When `scriptId` is omitted but `languageCode` is present, SONG loads the language-specific default. When both are omitted, SONG loads the legacy `en-US` service default for backward compatibility; publishing another language never replaces that fallback. When `leadId` is supplied, the lead must be assigned to that operator (unless the operator is an administrator), and `runtime.variableValues` contains only values declared by the published script.

For Dynamic Greetings and weather-aware calls, use the resolver endpoint. The Vibe app remains responsible for deriving local time and weather from its existing city/state/latitude/longitude logic:

```http
POST /api/song/runtime/resolve
Authorization: Bearer WORKBENCH_API_KEY
X-Operator-Token: OPERATOR_SESSION_TOKEN
Content-Type: application/json

{
  "serviceType": "Roofing",
  "languageCode": "es-US",
  "scriptId": "SCRIPT_ID",
  "leadId": "LEAD_ID",
  "runtimeContext": {
    "greeting": "Good afternoon",
    "localTime": "2:15 PM",
    "weatherSummary": "Clear, 78 F",
    "appointmentType": "inspection"
  }
}
```

Only those four runtime context keys are accepted. They populate declared `runtime.*` variables without changing the published script.

## Importing the existing Vibe flow

SONG's **Actions > Import Vibe scripts** workflow accepts the existing service configuration, previews the generated flows, and applies them only after validation. Each service becomes an editable eight-stage SONG draft with identity, reason, address, diagnosis, trust, appointment, confirmation, and wrap-up steps plus controlled terminal dispositions.

The import dialog includes a canonical sample, a JSON Schema, and concise AI generation rules. AI-generated stages should use the rich stage object shown below. Wording properties such as `text`, `helperText`, `response`, and `negativePathText` must always be strings; SONG rejects an object or array at the exact property path instead of coercing it to `[object Object]`.

```json
{
  "services": [
    {
      "serviceType": "Roofing",
      "languageCode": "en-US",
      "scriptName": "Roofing - Vibe Legacy Flow",
      "reason": "a roof inspection",
      "mainScript": {
        "identity": {
          "text": "{getGreeting()}, is this {contact.firstName}?",
          "type": "question",
          "answers": [
            { "id": "identity_confirmed", "label": "Yes, confirmed", "action": "proceed" },
            { "id": "identity_wrong", "label": "Wrong person", "action": "show_negative_path", "negativePathText": "Thanks for letting me know. I have the wrong number.", "negativePathOutcome": "Wrong Number" }
          ]
        },
        "reason": {
          "text": "This is {agent.firstName} calling about your request in {contact.city}.",
          "type": "statement",
          "answers": [{ "id": "reason_continue", "label": "Continue", "action": "proceed" }]
        },
        "address": { "text": "What is the current service address?", "type": "question", "answers": [{ "id": "address_confirmed", "label": "Address confirmed", "action": "proceed" }] },
        "diagnosis": { "text": "What made you reach out?", "type": "question", "answers": [] },
        "trust": { "text": "Workbench is licensed, bonded, and insured.", "type": "statement", "answers": [{ "id": "trust_continue", "label": "Continue", "action": "proceed" }] },
        "appointment": { "text": "Which inspection time works better?", "type": "question", "answers": [{ "id": "appointment_booked", "label": "Appointment booked", "action": "book_appointment" }] },
        "confirmation": { "text": "Perfect. I have you scheduled.", "type": "statement", "answers": [{ "id": "confirmation_continue", "label": "Continue", "action": "proceed" }] }
      },
      "concerns": [
        { "id": "leak", "label": "Active leak", "response": "We should address that quickly.", "action": "jump_to_stage", "targetStage": "appointment" }
      ],
      "outcomes": ["Appointment Booked", "Follow Up", "Not Interested", "Wrong Number"]
    }
  ]
}
```

Legacy placeholders for greeting, contact first name/city/state/address, agent first name, and selected service are translated into SONG variables. Conflict handling is explicit: `skip` is the default, `clone` creates another draft, and `replace_draft` updates only the editable draft while leaving published versions unchanged until an administrator republishes.

Record flow events:

```http
POST /api/song/events
Authorization: Bearer WORKBENCH_API_KEY
X-Operator-Token: OPERATOR_SESSION_TOKEN
Content-Type: application/json

{
  "scriptId": "SCRIPT_ID",
  "versionId": "VERSION_ID",
  "leadId": "LEAD_ID",
  "nodeId": "qualification",
  "branchId": "qualified",
  "eventType": "branch_selected",
  "outcome": "qualified"
}
```

Event types are `script_started`, `node_viewed`, `branch_selected`, `action_started`, `action_completed`, `action_failed`, `script_completed`, and `script_abandoned`.

## Administration endpoints

These routes exist only under the secret admin base path and require an administrator session:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/song/bootstrap` | API portfolios, locations, service pools, node/action catalogs, and scoped variable catalog |
| POST | `/api/song/imports/vibe/preview` | Convert and validate Vibe service JSON without writing |
| POST | `/api/song/imports/vibe/apply` | Import validated drafts using an explicit conflict policy |
| GET | `/api/song/scripts` | List scripts for an API key and location |
| POST | `/api/song/scripts` | Create a draft |
| GET | `/api/song/scripts/{id}` | Load the editable draft |
| PUT | `/api/song/scripts/{id}/draft` | Save using `expectedRevision` |
| POST | `/api/song/scripts/{id}/validate` | Validate without publishing |
| POST | `/api/song/scripts/{id}/publish` | Create and assign an immutable version |
| POST | `/api/song/scripts/{id}/clone` | Create an independent draft copy |
| POST | `/api/song/scripts/{id}/archive` | Archive and remove active assignment |
| GET | `/api/song/scripts/{id}/versions` | Published version history |
| GET | `/api/song/scripts/{id}/analytics` | Node and outcome runtime metrics |

Run `npm run migrate` after deployment to apply the current schema version (27).
