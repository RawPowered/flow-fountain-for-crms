# HAWK automation center

HAWK is the tenant-scoped automation control plane for Workbench. It owns small,
independently versioned automations that react to CRM data, execute through
server-side integrations, and retain a replayable history. It complements
GoHighLevel Workflows; it does not attempt to modify or impersonate the native
workflow product.

## Product boundary

- **OWL** supplies API portfolios, locations, CRM field knowledge, and the audit trail.
- **EAGLE** supplies business metrics that later HAWK triggers can evaluate.
- **SONG** supplies the established draft-revision, graph validation, and immutable publish pattern.
- **Sentinel** observes every HAWK control-plane request and every execution lifecycle.
- **HAWK** owns flow definitions, published versions, executions, step attempts, and replay.

GoHighLevel Private Integration Tokens (PITs) remain encrypted in
`crm_integrations`. A browser receives connection metadata only. Every live
action resolves a grant-bound integration on the server and requires
`allow_manage_leads`.

## Release plan

### Phase 1: durable automation kernel and operator workspace

1. Add tenant/location-scoped flow drafts with optimistic revision checks.
2. Validate a bounded directed graph containing trigger, condition, action, and end nodes.
3. Publish immutable, checksummed versions and activate or pause flows independently.
4. Execute safe tests, retain execution and step history, inspect input/output, and replay.
5. Support server-side HighLevel contact updates and tag actions through an authorized PIT.
6. Surface the HAWK workspace alongside OWL, EAGLE, SONG, and Sentinel.
7. Record definition changes through OWL and classify HAWK activity in Sentinel.

### Phase 2: live trigger adapters

1. Add signed inbound-event adapters and idempotent webhook receipts.
2. Add PIT-backed polling cursors for contact, opportunity, appointment, and form changes where
   no supported Private Integration webhook registration exists.
3. Add tag-added/removed, field-changed, record-created/updated, appointment, and opportunity triggers.
4. Add a durable worker lease, retry policy, per-location concurrency, and rate-limit backoff.

PITs are static scoped access tokens; they are not Marketplace applications and do not by
themselves register webhook subscriptions. HAWK therefore treats webhook delivery and polling as
explicit adapters rather than assuming that a PIT silently enables events.

### Phase 3: broader actions and data intelligence

1. Opportunities, tasks, conversations, calendars, notes, associations, and custom objects.
2. OWL and EAGLE metric triggers, SQL allowlist lookups, schedules, delays, and fan-out.
3. Expression builder, reusable subflows, templates, and environment promotion.

## Live CRM authoring catalog

HAWK uses the existing CRM importer as its metadata source. A catalog refresh calls HighLevel's
v3 location custom-fields API with `model=all`, then stores contact and opportunity field IDs,
keys, types, picklist metadata, and object models in `crm_object_field_definitions`. The browser
receives only this metadata. The same refresh calls the v3 Object Schema API, stores standard and
custom objects in `crm_object_definitions`, and ingests each returned schema's fields into the
shared field catalog. The PIT therefore needs both `locations/customFields.readonly` and
`objects/schema.readonly`. Standard fields and observed payload fields are merged into the same
searchable catalog.

Conditions, field-change triggers, action inputs, and update-contact targets use the catalog's
dropdown/search controls. Custom fields resolve at runtime through
`trigger.customFields.FIELD_ID`; inbound custom-field arrays are normalized to that shape before
execution. Update-contact custom fields use HighLevel's `{ id, field_value }` representation.

### Adaptive authoring workspace

The canvas library, step editor, and execution history can be collapsed independently. The step
editor can expand into a wider authoring surface, and **Focus code** combines those controls for
custom JavaScript or Python work without changing the saved graph contract.

The Data tab is an insertable variable browser rather than a static payload dump. Operators can
search the live CRM catalog, filter by object, inspect trigger paths and previous-step outputs, and
insert a selected variable into the current condition, mapping, data action, or code input. Value
mappings explicitly distinguish live fields, fixed values, and mixed templates. Picklist metadata
from HighLevel appears as selectable condition suggestions.

Safe tests default to a guided field/value composer and continuously generate the equivalent JSON.
JSON mode remains available for nested payloads, expert testing, and imported examples, so the
visual authoring path and portable automation-package path use one runtime input contract.

## Portable JSON automation packages

The HAWK import format is `hawk-automation-1`. The workspace provides an AI rules file, sample
package, static base schema, and a generated Live CRM Schema. The generated schema embeds the
selected connection's current runtime paths, field IDs, types, writable targets, picklist values,
objects, triggers, actions, and operators.

Preview validates graph topology and live catalog references before any write. Apply supports
`skip`, `clone`, and `replace_draft` conflict policies and always creates or updates drafts; import
never publishes or activates an automation.

## Custom code boundary

`code.run` supports JavaScript and Python contracts, but code is never evaluated by the API
process. Live publishing is blocked until `HAWK_CODE_RUNNER_URL` points to a separately isolated
runner. The runner receives only rendered `inputs`, source, runtime name, and hard limits. It does
not receive the Private Integration Token, database credentials, SQL access, host filesystem
access, or HAWK's network authority. Dry-run tests return the execution plan without running code.

### Phase 4: production operations

1. Dead-letter queues, bounded live replay, compensating actions, and execution cancellation.
2. Version comparison, dependency impact analysis, SLO dashboards, and Sentinel alert policies.
3. Per-step retention/redaction policies and exportable audit evidence.

## Graph contract

```json
{
  "schemaVersion": 1,
  "startNodeId": "trigger",
  "nodes": [
    {
      "id": "trigger",
      "type": "trigger",
      "name": "Tag added",
      "config": { "event": "contact.tag_added", "tag": "new-lead" },
      "nextNodeId": "source_check",
      "position": { "x": 360, "y": 50 }
    },
    {
      "id": "source_check",
      "type": "condition",
      "name": "Lead source is paid",
      "config": {
        "field": "trigger.source",
        "operator": "in",
        "value": ["Facebook", "Google"]
      },
      "routes": [
        { "label": "Yes", "when": true, "targetNodeId": "add_tag" },
        { "label": "No", "when": false, "targetNodeId": "end" }
      ],
      "position": { "x": 360, "y": 190 }
    },
    {
      "id": "add_tag",
      "type": "action",
      "name": "Add processed tag",
      "action": "ghl.add_tags",
      "config": {
        "contactId": "{{trigger.contactId}}",
        "tags": ["lead-processed"]
      },
      "nextNodeId": "end",
      "position": { "x": 360, "y": 340 }
    },
    {
      "id": "end",
      "type": "end",
      "name": "Complete",
      "config": {},
      "position": { "x": 360, "y": 490 }
    }
  ]
}
```

The server-owned action catalog includes contact update/upsert, tag add/remove, contact notes and
tasks, opportunity create/update, message sending, appointment creation, discovered custom-object
record create/update, `data.set`, and the isolated-runner contract `code.run`. The complete fields,
defaults, required PIT scopes, and supported trigger definitions are emitted in the Live CRM Schema
and documented in [HAWK capability catalog](hawk-capability-catalog.md). Template values use paths such as `{{trigger.contactId}}` and
`{{steps.NODE_ID.response.id}}`. Secrets and authorization headers are never
valid template inputs.

## Execution and replay safety

- Tests always run in `dry_run` mode and make no upstream changes.
- A live run requires an active published flow and an explicit live confirmation.
- Replay creates a new execution linked by `replay_of_execution_id`; it never mutates the original.
- Replay defaults to `dry_run`. Live replay requires the same explicit confirmation as a live run.
- Runtime traversal is bounded, cycles are rejected at publish time, and stored payloads are recursively redacted and size-limited.
- HighLevel 429 and rate-limit headers are captured as operational metadata, never as credentials.

## Phase 1 administrative endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/hawk/bootstrap` | Scoped portfolios, locations, connections, and catalogs |
| GET | `/api/hawk/catalog` | Search-ready live object and field catalog |
| POST | `/api/hawk/catalog/refresh` | Refresh custom-field metadata through the server-side PIT |
| GET | `/api/hawk/imports/schema` | Download a schema containing current CRM values |
| POST | `/api/hawk/imports/preview` | Validate a JSON automation package and live field references |
| POST | `/api/hawk/imports/apply` | Import validated flows as drafts |
| GET/POST | `/api/hawk/flows` | List or create flows |
| GET | `/api/hawk/flows/{id}` | Load one editable flow |
| PUT | `/api/hawk/flows/{id}/draft` | Optimistic draft save |
| POST | `/api/hawk/flows/{id}/validate` | Validate a draft graph |
| POST | `/api/hawk/flows/{id}/publish` | Create an immutable version |
| POST | `/api/hawk/flows/{id}/state` | Activate or pause a published flow |
| POST | `/api/hawk/flows/{id}/test` | Execute the draft in dry-run mode |
| POST | `/api/hawk/flows/{id}/execute` | Explicit live execution of the published graph |
| GET | `/api/hawk/executions` | Filterable history |
| GET | `/api/hawk/executions/{id}` | Execution, step log, and redacted data |
| POST | `/api/hawk/executions/{id}/replay` | Linked safe replay |

Run `npm run migrate` after deployment to add the HAWK tables.
