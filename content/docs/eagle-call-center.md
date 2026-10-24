# EAGLE Call Center

The Call Center module is EAGLE's governed executive contract for lead supply, assignment load,
staffing evidence, verified work, CRM-confirmed calls, and appointment production. It is separate
from OWL: OWL performs operational administration, while EAGLE explains the business state and
provides reconciled drill-through evidence.

## Phase 1 status

Phase 1 establishes definitions and a read-only server contract. It does not add the visual tab or
activate lead reassignment. It also does not rank users or label anyone as burning leads.

Endpoint:

```http
GET {ADMIN_BASE_PATH}/api/eagle/call-center
  ?apiKeyId={apiKeyId}
  &integrationId={integrationId}
  &period=current_week|1d|7d|30d
```

The CRM integration grant establishes the authorized API key and operational `locationId`. The
endpoint reads the core Dialer evidence tables and never accepts a location supplied by the browser.

## Contract boundaries

The response keeps three time bases separate:

| Evidence | Time basis |
|----------|------------|
| Lead pools and ownership | Live operational state as of the response |
| Schedule submission and attendance | Current Monday-Sunday schedule week, America/New_York |
| Activity, calls, and appointments | Selected performance period ending at response `asOf` |

Every metric includes its version, definition, unit, numerator, denominator, availability status,
status reason, period start, period end, and business owner. The browser must display these values;
it must not recalculate performance rates.

## Phase 1 metric definitions

| Metric ID | Definition |
|-----------|------------|
| `call_center_roster_users` | Dialer users configured for the selected location |
| `call_center_working_now` | Users with verified activity in the last three minutes |
| `call_center_schedule_submission_rate` | Submitted current-week schedules / roster users |
| `call_center_submitted_hours` | Hours in submitted schedules; drafts and missing schedules excluded |
| `call_center_verified_hours` | Distinct activity minutes / 60 |
| `call_center_attendance_rate` | Current-week verified minutes for submitted users / elapsed scheduled minutes; not capped at 100% |
| `call_center_engagement_rate` | Activity minutes associated with a CRM contact / verified activity minutes |
| `call_center_confirmed_calls` | Outbound CRM call events; Dialer authorization intents excluded |
| `call_center_call_attribution_rate` | CRM-confirmed calls with a configured user / all CRM-confirmed calls |
| `call_center_calls_per_verified_hour` | CRM-confirmed calls / verified activity hours |
| `call_center_eligible_leads_worked` | Distinct attributed CRM-confirmed called leads passing current-state eligibility |
| `call_center_appointments_booked` | Local appointment records created during the selected period |
| `call_center_appointment_yield` | Eligible worked leads with at least one same-user appointment / eligible leads worked |
| `call_center_available_leads` | DNC-clean, unowned leads in an enabled assignable lifecycle pool |
| `call_center_active_assignment_load` | Owned leads in enabled non-terminal lifecycle pools |

Metric definition version: `1.0`. Contract version: `1.0`.

## Eligible worked lead

A Phase 1 worked lead requires a CRM-confirmed outbound call attributed to a configured Dialer user
during the selected performance period. Authorization intents are evidence that a call was permitted,
not evidence that a call occurred, and never count as calls or worked leads.

The lead must currently be DNC clean and must not currently be in DNC Screening, DNC, or Invalid.
A worked lead contributes once to the yield numerator when at least one appointment is attributed to
the same user and lead during the same period. Multiple appointment records for one lead do not
inflate the yield numerator.

This is a current-state approximation. The system does not yet retain the lead's eligibility state at
the instant of every call. For that reason:

- `call_center_eligible_leads_worked` is `partial` when available.
- `call_center_appointment_yield` is `partial` when it has a denominator.
- Partial metrics may be shown directionally but cannot drive a target badge or personnel judgment.

## Schedule and activity evidence

- A schedule is `submitted`, `draft`, or `missing`.
- Only submitted schedules contribute submitted hours or the attendance denominator.
- Attendance uses the portion of scheduled shifts elapsed at response time, including proportional
  break time, and is not capped at 100 percent.
- Verified hours come from one metadata-only activity row per user and minute.
- Engaged minutes are verified minutes associated with a CRM contact.
- Working now means the last verified heartbeat is no more than 180 seconds old.

## Lead stewardship governance

Phase 1 returns:

```json
{
  "stewardship": {
    "status": "not_assessed"
  }
}
```

No user-level stewardship risk may be generated until all of the following are approved:

1. Minimum sample of at least 20 eligible worked leads and 300 verified minutes.
2. Governed appointment-yield and call-efficiency targets.
3. Service and source comparison cohorts.
4. Event-time eligibility evidence or an explicitly approved approximation.
5. A documented business owner and review process.

## Evidence limitations

- Local appointments are authoritative for appointment actions executed through Workbench. CRM-only
  appointments created outside that path may not be represented.
- Raw CRM call status values are not yet normalized into connect, no-answer, voicemail, or talk-time
  measures. Phase 1 therefore reports confirmed calls, not connects or talk time.
- Win and revenue performance by user remain unavailable until complete opportunity evidence and
  user attribution are present.
- Missing optional evidence tables produce unavailable metrics instead of zero values.
- Pool totals reconcile to live leads. Unmapped statuses remain visible in the `Unmapped` lifecycle
  row and in reconciliation metadata.

## Phase 1 acceptance criteria

1. The endpoint derives location only from the authorized CRM integration.
2. Authorization intents never contribute to confirmed calls.
3. Pool lifecycle and service totals reconcile to the live lead total.
4. DNC-pending, DNC-blocked, and Invalid leads never contribute to available clean leads.
5. Draft and missing schedules never contribute to submitted hours.
6. Every rate exposes its numerator and denominator.
7. Missing evidence returns `unavailable`, not a misleading zero.
8. Appointment yield remains `partial` until event-time eligibility is available.
9. Personnel stewardship remains `not_assessed` until its governance gate is satisfied.
10. Metric definitions are persisted through the existing EAGLE definition migration.

## Next phase

Phase 2 adds the read-only Call Center navigation and CEO Command view using this contract. It should
include the executive attention brief, KPI strip, pool flow, staffing-versus-demand view, performance
quadrant, and people table. Reassignment remains out of scope until the read-only math is reconciled.
