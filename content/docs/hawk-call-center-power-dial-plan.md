# HAWK Call Center and HighLevel Manual Call plan

## Architecture decision

- **Contact** is the person and retains the `Call Center` membership tag while the lead remains callable.
- **OWL/HAWK** is the eligibility authority. Every initial or repeat dial request must pass through `cc-recheck`.
- **HighLevel Manual Actions** is the actual Power Dial queue. Only a published HighLevel workflow containing a **Manual Call** action creates this queue item.
- **Dial Pipeline opportunity** is one active call cycle per contact/service. It is the manager-facing lifecycle board, not an attempt ledger.
- **Dials custom object** is one immutable record per completed dial attempt. It records the result and is associated to the Contact. Do not use Dials records themselves as the Manual Actions queue.

## Required CRM model

### Contact fields

Create these Contact fields because Contact data is available to the rep and to Manual Call workflows:

| Field | Type | Values / purpose |
|---|---|---|
| `CC Disposition` | Single-select | `New Dial`, `No Answer`, `Call Back`, `Re-Schedule`, `Not Interested`, `Scheduled`, `DNQ`, `DNC` |
| `CC Next Call At` | Date/time | Required for Call Back and Re-Schedule |
| `Dialer Status` | Existing text field | HAWK writes eligibility and exclusion reason |

The rep must set `CC Disposition` before completing or deleting the Manual Call task. HighLevel does not advance past Manual Call merely because a phone call was placed.

### Dials custom-object fields

Treat each Dials record as one completed attempt:

| Field | Type | Values / purpose |
|---|---|---|
| `Contact Name` | Existing single-line | Primary display value; do not make unique when records represent attempts |
| `Service Pool` | Change/recreate as single-select | `Roofing`, `Solar`, `Kitchen`, `Bathroom`, `Remodeling`, `Mold / Water Damage`, `Other` |
| `Call Result` | Existing single-select | Add missing `No Answer`; retain `New Dial`, `Call Back`, `Re-Schedule`, `Not Interested`, `Scheduled`, `DNQ`, `DNC` |
| `Dialed At` | Date/time | Workflow execution time after Manual Call completion |
| `Next Call At` | Date/time | Copied from Contact for callbacks |
| `Attempt Number` | Number | Optional reporting counter |
| `Contact ID` | Single-line | Stable external reference; do not mark unique when one record equals one attempt |

Add a **Contact ↔ Call Center** association named `Dialed Contact`. Keep the existing Opportunity association for later reporting, but use the Contact association for tomorrow's workflow because HighLevel can create and associate the record natively from a Contact workflow.

### Dial Pipeline

Use one opportunity per Contact/service call cycle. Recommended stages:

1. `Not Called`
2. `Manual Action Queued`
3. `Call Back`
4. `No Answer / Cooling Off`
5. `Scheduled`
6. `Closed - Not Interested`
7. `Closed - DNQ`
8. `Closed - DNC`
9. `Closed Won`

Do not create a new opportunity for each attempt. The Dials records hold attempt history.

## Tags

| Purpose | Tag |
|---|---|
| Persistent membership | `Call Center` |
| Request initial/repeat eligibility | `cc-recheck` |
| Current approval | `cc-eligible` |
| Temporary retry | `cc-deferred` |
| Existing appointment | `cc-scheduled` |
| Hard/configuration block | `cc-blocked` |
| Service queues | `cc-queue-roofing`, `cc-queue-solar`, `cc-queue-kitchen`, `cc-queue-bathroom`, `cc-queue-remodeling`, `cc-queue-mold-water`, `cc-queue-other` |
| Sale archive | `cc-closed-sale` |

Queue tags are event tokens, not permanent classification. A pool workflow removes its queue tag before requesting another `cc-recheck`.

## Native HighLevel workflows

### 1. CC Intake Bridge

Trigger: Contact tag added = `Call Center`.

Actions:

1. Remove `cc-recheck`.
2. Add `cc-recheck`.

This makes the persistent Call Center tag start the HAWK-controlled cycle.

### 2. One Manual Call workflow per service pool

Create the Roofing workflow first, test it, then clone it for the remaining queue tags.

Trigger: Contact tag added = the pool's `cc-queue-*` tag. Enable workflow re-entry.

Actions:

1. If/Else safety gate: require `Call Center` and `cc-eligible`; reject `cc-blocked` and `cc-scheduled`.
2. Create or update the contact's Dial Pipeline opportunity in `Not Called`. Configure the workflow's opportunity duplicate rule so one open opportunity is reused.
3. Move the opportunity to `Manual Action Queued`.
4. Add **Manual Call**, assigned to the Contact owner unless a dedicated pool owner is required.
5. After the rep sets `CC Disposition` and completes/deletes the Manual Call task, create a **Dials associated record for Contact** using the pool, disposition, current time, next-call time, and Contact ID.
6. Route by `CC Disposition`:
   - `Call Back` / `Re-Schedule`: move opportunity, remove queue tag, wait until `CC Next Call At`, then remove and add `cc-recheck`.
   - `No Answer`: move to cooling-off, remove queue tag, wait the approved interval, then remove and add `cc-recheck`.
   - `Scheduled`: move to Scheduled, remove queue tag and `cc-eligible`; do not requeue. OWL calendar reconciliation is the safety authority.
   - `Not Interested`, `DNQ`, `DNC`: move to the matching terminal stage, remove queue and eligibility tags, remove the contact from every Call Center pool workflow, and remove `Call Center` when the lifecycle is terminal.
7. Clear `CC Disposition` and `CC Next Call At` only after their values have been copied into Dials.

The Manual Actions page can be filtered by workflow source and assignee. Separate pool workflows therefore create native, shareable service-pool queues without trying to expose custom-object fields inside Conversations.

### 3. CC Deferred Recheck

Trigger: `cc-deferred` added.

Use an If/Else on `Dialer Status`:

- Outside marketing hours: wait until the next approved opening, then request `cc-recheck`.
- Florida attempt limit: wait 24 hours, then request `cc-recheck`.
- Calendar verification unavailable: wait 15 minutes, then request `cc-recheck`.

Remove `cc-deferred` before adding `cc-recheck`.

### 4. CC Suppression / sale exit

Trigger on DNC/DND evidence, Scheduled appointment, Closed Won, and terminal outcomes. Remove the contact from all pool workflows before clearing queue tags. The HAWK package also contains a Closed Won cleanup flow as a second control.

## Build order for tomorrow readiness

1. Add the Contact fields and Dials fields above.
2. Add the Contact ↔ Call Center association.
3. Refresh CRM fields in HAWK and download a new Live CRM Schema; the current downloaded schema predates `Service Pool` and `Call Result`.
4. Import `hawk-call-center-power-dial-router.json` as drafts with the Private Integration selected.
5. Enable the signed `contact.tag_added` and `opportunity.status_changed` adapters.
6. Build CC Intake Bridge and one Roofing Manual Call workflow.
7. Test with an internal Contact that has a clean OWL DNC result, an assigned owner, a configured Roofing calendar, and the `Call Center` tag.
8. Confirm: `cc-recheck` is consumed, exactly one queue tag appears, one Manual Action is created, the rep records a disposition, one associated Dials record is created, and the opportunity moves once.
9. Clone the verified pool workflow for the remaining service tags.
10. Publish suppression and sale-exit workflows before importing production contacts.

## Non-negotiable safety rules

- Never create Manual Call tasks directly from Dials records; HighLevel's native queue is workflow-driven.
- Never requeue by adding `cc-queue-*` directly. Request `cc-recheck` so OWL verifies DNC and calendars again.
- Never treat a clean DNC result as consent.
- Never let a missing calendar configuration pass as eligible.
- Never create one opportunity per dial attempt.
