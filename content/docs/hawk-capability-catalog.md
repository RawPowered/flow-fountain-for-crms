# HAWK capability catalog

HAWK exposes one server-owned capability catalog to the workspace, validation engine, live-schema
download, JSON importer, dry-run planner, and PIT executor. A capability is not considered shipped
when only its palette label exists.

## Action tranche 2

| Action | HighLevel scope | Execution contract |
|---|---|---|
| Update Contact | `contacts.write` | `PUT /contacts/{contactId}` |
| Create or Update Contact | `contacts.write` | `POST /contacts/upsert`; HAWK injects `locationId` |
| Add / Remove Tags | `contacts.write` | `POST` / `DELETE /contacts/{contactId}/tags` |
| Create Contact Note | `contacts.write` | `POST /contacts/{contactId}/notes` |
| Create Contact Task | `contacts.write` | `POST /contacts/{contactId}/tasks` |
| Create / Update Opportunity | `opportunities.write` | `POST /opportunities/` / `PUT /opportunities/{id}` |
| Send Message | `conversations/message.write` | `POST /conversations/messages` |
| Create Appointment | `calendars/events.write` | `POST /calendars/events/appointments`; HAWK injects `locationId` |
| Create / Update Object Record | `objects/record.write` | `POST` / `PUT /objects/{schemaKey}/records`; schema key is restricted to discovered objects |
| Set Flow Data | none | Execution-local data store |
| Custom Code | none | Separately isolated runner only |

The initial reference IDs for pipelines, stages, calendars, and users remain runtime, imported, or
fixed inputs. The next catalog-ingestion tranche should synchronize these resources into governed
reference tables so the workspace can display names and searchable dropdowns while preserving IDs
in the graph.

## Trigger definitions

Manual execution is ready immediately. CRM event definitions are valid draft contracts, but their
automatic delivery state is explicitly `adapter_required` until a signed inbound adapter or durable
PIT polling cursor is enabled.

| Object | Trigger definitions |
|---|---|
| Contact | created, updated, tag added/removed, selected field changed, DND changed |
| Opportunity | created, updated, pipeline stage changed, status changed |
| Appointment | created, updated, deleted |
| Task | created, completed |
| Conversation | inbound message, outbound message |
| Form | submitted |
| Custom object | record created, record updated; filtered by discovered schema key |

## Delivery architecture

1. A signed inbound adapter maps HighLevel event names onto HAWK trigger IDs.
2. A receipt store enforces `(location, event type, upstream id)` idempotency before execution.
3. Poll-only resources use leased cursors with overlap windows, rate-limit backoff, and the same
   normalized receipt contract.
4. Trigger payloads pass through `normalizeTriggerData`, field discovery, redaction, and Sentinel
   before graph execution.
5. Activation must reject an adapter-backed flow when its selected location has no healthy adapter.

## Next recursive tranches

1. **Reference catalogs:** pipelines/stages, calendars, users, conversation providers, message
   templates, and object associations.
2. **Control nodes:** delay-until, bounded retry, parallel fan-out, join, and reusable subflow.
3. **Read actions:** get/search contact, opportunity, object record, free slots, and conversation;
   store results under `steps.NODE.response`.
4. **Outbound integrations:** allowlisted HTTP request with connection-owned credentials; never put
   credentials in a graph.
5. **OWL/EAGLE triggers:** metric threshold, snapshot completed, data-quality regression, and
   governed segment membership.

## Official HighLevel references

- Private Integration tokens: https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken/
- Contacts: https://marketplace.gohighlevel.com/docs/ghl/contacts/contacts/
- Opportunities: https://marketplace.gohighlevel.com/docs/ghl/opportunities/opportunities/
- Calendars: https://marketplace.gohighlevel.com/docs/ghl/calendars/calendars/
- Conversations: https://marketplace.gohighlevel.com/docs/ghl/conversations/messages/
- Objects: https://marketplace.gohighlevel.com/docs/ghl/objects/records/
- Webhook events: https://marketplace.gohighlevel.com/docs/tags/webhook-events/
