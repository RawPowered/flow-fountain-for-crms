# EAGLE Executive Dashboard: Metric and UIX Refinement Plan

## Implementation status

Phases 1 through 10 were implemented across July 12–13, 2026. EAGLE now uses snapshot-anchored reporting windows,
equal-length prior-period lead comparison, explicit current-state numerators and denominators,
actionable-unassigned and attribution-health KPIs, a non-smoothed intake chart, compact Top Markets,
and dedicated Market Detail and Lead Detail views. The server now owns versioned semantic metric
objects, governed attribution aliases, sample confidence, and complete Top-N reconciliation metadata.
The historical funnel now uses authoritative local appointment events and a configurable cohort-maturity
window. Win metrics activate only after a complete opportunity extract with dated terminal evidence is
imported; until then they render as unavailable rather than inferred from CRM tags.

## Outcome

EAGLE should let the CEO answer five questions in less than one minute:

1. Are lead volume and outcomes on pace for the selected period?
2. Where is the largest operational leakage?
3. Which sources, campaigns, services, and markets are producing outcomes rather than volume alone?
4. What materially changed from the comparable prior period?
5. Can the displayed numbers be trusted, and what data is incomplete?

The CRM contact total remains the reconciliation anchor. The refinement is primarily a semantic-layer
and information-hierarchy change: preserve the correct base population, make every denominator and
time basis explicit, and stop presenting current-state classifications as historical funnel events.

## Current-state findings

### P0: metric meaning is not sufficiently explicit

- `appointmentRate` is current `Scheduled` contacts divided by all filtered contacts.
- `winRate` is current `Closed Won` contacts divided by all filtered contacts.
- Both are labeled only as `conversion`, even though they answer different questions and neither
  exposes its denominator.
- The normalized disposition is mutually exclusive. Because `Closed Won` has precedence over
  `Scheduled`, a won contact is not included in the appointment count. This is valid for a current
  pipeline-state distribution, but it is not a stage-to-stage funnel.
- `Assigned` combines either a CRM owner or a dialer owner and does not show the actionable inverse:
  unassigned eligible leads.
- The selected period and `fresh this week` use the database's current date. Reopening an immutable
  snapshot on a later day can therefore change the displayed population without changing the snapshot.

### P0: the trend does not describe outcomes

The service groups records by CRM contact creation date. The client then draws only total leads,
despite receiving scheduled and won fields. The smoothed line implies a continuous measure and can
overshoot sparse daily observations. This should be a lead-intake column chart until authoritative
appointment and win event dates exist.

### P1: geography is visually dominant but strategically ambiguous

- `Market presence` is represented states divided by 50. One contact is sufficient to mark an entire
  state present.
- `State population footprint` counts the full population of every represented state, also after one
  contact. It is useful context, not business penetration or serviceable-market coverage.
- `Place population footprint` and `lead density` depend only on exact Census-place matches. The
  validity of that denominator changes with address-match coverage.
- A national map consumes the largest area even when all leads are in one state. A compact ranked
  market view would provide more decision value on the executive page; the map should be a drill-down.

### P1: attribution quality is mixed with performance

`Unattributed` is rendered as if it were a campaign, and raw identifiers can appear as source labels.
In the supplied view, all 66 leads are unattributed at campaign level. Outcome ranking is not reliable
until attribution coverage is visible and raw CRM values are mapped into governed source/campaign
dimensions.

### P1: the overview has low decision density

The page requires a long scroll through a map, charts, two tables, and contact-level records before a
CEO can compare pace, conversion, and risks. Lead detail is an analyst drill-down and should not be a
dominant section of the executive overview.

## Governed metric contract

Every displayed metric should have a stable ID, business label, grain, numerator, denominator,
inclusion/exclusion rules, time basis, freshness timestamp, and accountable owner. The UI should expose
the short definition in a tooltip and the full definition in a metric glossary.

| Metric | Recommended definition | Required label |
|---|---|---|
| Lead cohort | Distinct CRM contacts with `crm_date_added` inside the selected period | New leads |
| Current portfolio | Distinct contacts present in the selected snapshot, independent of cohort date | CRM contacts |
| Assignment coverage | Leads with a CRM or dialer owner / leads in scope | Assigned rate |
| Actionable unassigned | Leads with no owner and not DNC/terminal / actionable leads | Unassigned leads |
| DNC exposure | DNC-blocked leads / leads in scope | DNC rate |
| Current scheduled state | Contacts whose current normalized disposition is `Scheduled` / leads in scope | Currently scheduled |
| Current won state | Contacts whose current normalized disposition is `Closed Won` / leads in scope | Currently won |
| Appointment conversion | Cohort contacts that ever booked an appointment / eligible cohort leads | Lead-to-appointment rate |
| Lead-to-win conversion | Cohort contacts that ever became won / eligible cohort leads | Lead-to-win rate |
| Appointment close rate | Won contacts / contacts that ever booked an appointment | Appointment-to-win rate |
| Attribution coverage | Leads with a governed, non-unknown source / leads in scope | Source coverage |
| Campaign coverage | Leads with a governed, non-unknown campaign / leads in scope | Campaign coverage |
| Top-market concentration | Leads in the largest matched market / geocoded leads | Top market share |

The three `ever` metrics require appointment/opportunity history. Until that source exists, keep the
current-state counts but do not call them funnel conversion. Never silently substitute current
disposition for a historical milestone.

### Rate presentation rule

Each rate must render as `numerator / denominator = rate`, at least in its expanded state or tooltip.
Example: `12 / 53 eligible leads = 22.6%`. Zero is a valid value; unavailable or invalid denominators
must render as `—`, not `0%`.

### Time rule

All time filters must be anchored to an explicit report `asOf` value. For a snapshot view, use the
snapshot completion timestamp. For live mode, use the displayed refresh timestamp. The API should
return `periodStart`, `periodEnd`, `asOf`, and `timezone` with every aggregate response.

### Reconciliation rules

- Mutually exclusive current dispositions must sum to the filtered contact population.
- Unknown source/campaign/location must remain explicit buckets; they must not disappear from totals.
- A filtered breakdown must reconcile to the filtered KPI total before `Top N`; if rows are truncated,
  return an `Other` row and metadata describing the limit.
- Geography metrics must return matched-lead count and matched population next to every density rate.
- Period-over-period deltas must compare equal-length, non-overlapping windows with the same filters.

## Recommended executive information architecture

### 1. Persistent report scope

Show one compact line above the content:

`Last 30 days · Jul 12, 2026 as of 5:30 PM CT · Florida · All services · 66 leads`

Keep portfolio, CRM location, period, and Compare controls visible. Move detailed segmentation into a
filter drawer and show active filters as removable chips. The page title should never be separated from
the active report scope.

### 2. Executive scorecard

Use five primary cards, in this order:

1. New leads — count, prior-period delta, target pace.
2. Lead-to-appointment — numerator/denominator, prior-period delta.
3. Lead-to-win — numerator/denominator, prior-period delta.
4. Unassigned actionable — count, age of oldest, risk color.
5. Attribution coverage — source and campaign completeness.

Show DNC exposure and location completeness as data/operational health indicators below the primary
scorecard. Population footprint should not be a top-level success KPI.

### 3. Performance story

Use a compact two-panel row:

- **Lead intake vs prior period:** daily or weekly columns, no smoothing, with a comparable prior-period
  series and target/average reference line.
- **Current pipeline composition:** a 100% stacked bar or ordered horizontal bars explicitly labeled
  `Current disposition`, with counts and percentage of current portfolio.

After event history is available, add a separate cumulative cohort funnel:

`Eligible leads -> Appointments booked -> Wins`

It must show stage conversion and leakage between adjacent stages. It must not be built from the
mutually exclusive disposition field.

### 4. Drivers and exceptions

Replace separate source/campaign volume tables with a ranked performance table:

| Driver | Leads | Share | Appt rate | Win rate | vs prior | Data confidence |
|---|---:|---:|---:|---:|---:|---|

Default to sources; allow campaign, service, and market as the dimension selector. Put `Unattributed`
in a visually separate data-quality row. Add a minimum-volume indicator so tiny samples are not ranked
as decisive winners.

Add an exception panel with only actionable conditions, such as:

- unassigned eligible leads older than the response SLA;
- campaign attribution below the agreed threshold;
- material lead-volume decline versus the prior period;
- DNC spike or a source with unusually high DNC exposure;
- Census-place match coverage too low to trust density rankings.

### 5. Market drill-down

The executive page should show a compact Top Markets table with lead count, share, change, appointment
rate, and win rate. Move the full U.S. map and Census population metrics into a Market detail view.
When only one state is in scope, default the visualization to cities in that state rather than a
national map.

### 6. Detail on demand

Move Lead Detail to its own tab or a drill-through reached by clicking a KPI/breakdown. Preserve the
shared filter state and clearly label whether the table shows the KPI numerator, denominator, or all
leads in scope.

## Data architecture changes

### Semantic API response

Return display-ready metric objects rather than unlabeled scalar fields:

```json
{
  "metricId": "lead_to_appointment_rate",
  "label": "Lead-to-appointment",
  "value": 22.6,
  "numerator": 12,
  "denominator": 53,
  "unit": "percent",
  "status": "available",
  "asOf": "2026-07-12T22:30:00Z",
  "definitionVersion": "1.0"
}
```

This prevents the browser from inventing business definitions, as it currently does for marketing
appointment rate.

### Fact model

Retain `eagle_lead_facts` as the snapshot contact fact, but add event-grain sources before presenting a
true funnel:

- `fact_lead_event`: lead created, assigned, DNC blocked/cleared, appointment booked/completed/canceled,
  opportunity opened, won, and lost; one row per event with source timestamp and ingestion timestamp.
- `fact_opportunity_snapshot`: opportunity and pipeline-stage state at each EAGLE snapshot.
- `dim_marketing_source` and `dim_campaign`: canonical label, raw aliases, channel, status, and unknown
  reason.
- `dim_metric_definition`: versioned metric metadata and business owner.

Preserve CRM timestamps separately from EAGLE ingestion timestamps. If the upstream source cannot
provide authoritative appointment/win dates, mark event-time metrics unavailable rather than inferring
them from the contact creation date.

### Cohort maturity

Conversion comparisons should use a declared maturity window, for example leads created at least 14
days before `asOf`, or show an `immature cohort` warning. Otherwise the latest period will appear to
underperform simply because its leads have had less time to convert.

## Delivery sequence

### Phase 0 — metric lock (1–2 working sessions)

- Agree on CEO questions, operational SLA, targets, eligibility rules, attribution ownership, and
  conversion maturity window.
- Approve the metric contract and plain-language labels.
- Identify the authoritative appointment and opportunity history endpoints/tables.

Exit criterion: every primary metric has an approved numerator, denominator, time basis, and owner.

### Phase 1 — clarity release, no new event source

- Rename current metrics to `Currently scheduled`, `Currently won`, and `Current disposition`.
- Show counts and explicit percentages; change unavailable denominators from `0%` to `—`.
- Anchor period filters to snapshot completion time.
- Replace the smoothed trend with lead-intake columns and a prior-period comparison.
- Add source/campaign coverage and separate `Unattributed` from performance rankings.
- Reduce the map to a compact Top Markets module; move contact rows into a drill-down tab.
- Add visible `as of`, filter scope, and metric-definition help.

Exit criterion: no visible label implies a historical funnel or an unstated denominator.

### Phase 2 — governed aggregate layer

- Implement metric objects and definition versions in the dashboard API.
- Add canonical source/campaign mappings and unknown-reason codes.
- Return complete reconciliation metadata, prior-period values, and confidence/sample-size flags.
- Add API contract and SQL fixture tests for every filter combination.

Exit criterion: UI math is formatting only; the server owns metric definitions and comparisons.

### Phase 3 — outcome event model

- Ingest appointment and opportunity stage history.
- Build lead-to-appointment, lead-to-win, and appointment-to-win metrics with cohort maturity.
- Add stage leakage and event-time trends.

Exit criterion: the true funnel reconciles from event facts and links to the supporting lead cohort.

### Phase 4 — executive validation and rollout

- Run a two-week parallel comparison against CRM reports using frozen daily extracts.
- Require finance/revenue-operations sign-off on definitions and five sampled reconciliations per KPI.
- Observe task completion: time to identify the biggest issue, filter errors, glossary opens, and
  drill-through usage.
- Release behind a feature flag with the old view retained for a short validation window.

Exit criterion: agreed tolerance is met, discrepancies are documented, and the CEO can answer the five
target questions without analyst assistance.

### Phase 5 — executive attention and trust operations

- Generate a deterministic CEO attention brief from governed server metric objects.
- Keep factual exceptions, period momentum, and data-trust status visually separate.
- Show snapshot freshness, validation recency, and rollout readiness without changing frozen KPI values.
- Expose the audited rollout history alongside validation evidence.

Exit criterion: the CEO can identify the highest-volume operational queue and determine whether the
supporting snapshot and validation evidence are current without performing arithmetic in the browser.

### Phase 6 — governed business targets and variance

- Store approved KPI targets per CRM integration with direction, warning margin, and business owner.
- Calculate on-target, near-target, off-target, and unavailable states on the server.
- Separate target variance from prior-period momentum and factual operational queues.
- Audit every creation, revision, activation, and deactivation with an administrator reason.

Exit criterion: every performance judgment shown to the CEO traces to an active approved target and
the browser performs no target or variance arithmetic.

### Phase 7 — target-scope integrity

- Bind each target to an approved 7-, 30-, 90-, 365-day, or all-time reporting period.
- Apply targets only to integration-wide views with no state, city, service, disposition, source, or
  campaign filter.
- Return `not_applicable` and the mismatch reason instead of calculating variance on an incompatible scope.
- Keep the target visible in governance views while suppressing off-target executive escalation.

Exit criterion: no target badge or executive performance judgment can compare a scoped slice with an
integration-wide target or compare reporting periods of different lengths.

### Phase 8 — visual audience intelligence

- Separate generic profile completeness from decision-useful household, financial, property, and
  audience insight coverage.
- Generate a privacy-safe executive audience headline and sample-confidence label on the server.
- Lead with spotlight characteristics, composition charts, and domain-readiness gaps.
- Move exhaustive field coverage and exploration into a progressive analyst workbench.

Exit criterion: the CEO can describe the dominant audience characteristics and identify the largest
data-confidence gaps in under 30 seconds without reading a field inventory.

### Phase 9 — executive command center

- Lead the Overview with one factual business posture instead of requiring executives to assemble a conclusion from cards.
- Pair four governed decision metrics with a single highest-priority action and its destination workflow.
- Separate decisions, momentum, and evidence confidence while keeping supporting pipeline, cohort, driver, and market evidence below.
- Resolve structured CRM attribution values before storage so source labels cannot render as `[object Object]`.
- Preserve governed metric and reconciliation contracts; this phase changes narrative hierarchy, not KPI definitions.

Exit criterion: the CEO can state the business posture, identify the next action, and understand evidence confidence in under 15 seconds.

### Phase 10 — concept-led application shell

- Replace the utility top bar with persistent EAGLE view navigation on executive desktop layouts.
- Recompose the Overview into modular insight, pipeline, disposition, market, audience, and outcome-evidence cards.
- Preserve only live governed KPIs; concept-only spend, revenue, or conversion values are not introduced.
- Keep full driver tables and governance workflows available as supporting analysis rather than opening-page clutter.
- Collapse the shell responsively into a top navigation pattern and horizontally scrollable KPI cards on small screens.

Exit criterion: the concept's navigation and visual rhythm are recognizable while every displayed value remains backed by the live EAGLE contracts.

### Phase 11 — executive interaction and drill-through polish

- Normalize the Overview's icon, KPI, section-heading, and supporting-text scale for rapid executive scanning.
- Give every interactive summary a consistent hover and keyboard-focus signal instead of relying on passive browser tooltips.
- Route governed KPI cards, disposition bars, driver rows, and market rows into detail views with the corresponding supported filter applied.
- Expose exact current/prior lead and authoritative outcome-event values on chart-mark hover and keyboard focus.
- Connect audience spotlight cards to the matching privacy-safe demographic field distribution and outcome evidence to validation.
- Keep actionable-unassigned drill-through explicitly unfiltered because ownership is not yet a supported EAGLE lead-filter contract.

Exit criterion: an executive can discover a card's purpose on hover, open its supporting analysis in one action, and verify exact chart values without performing visual estimation.

## Acceptance tests

1. The sum of current dispositions equals the scoped CRM contact count.
2. Every rate exposes numerator and denominator and is within 0–100% when available.
3. Zero numerators render `0`; zero/unknown denominators render `—` with a reason.
4. Reopening a snapshot with the same filters produces the same values regardless of the current date.
5. All breakdowns, drill-through rows, CSV exports, and KPI totals use the same scope and `asOf`.
6. Top-N tables reconcile through an explicit `Other` row.
7. Unknown attribution and unmatched geography remain visible and quantified.
8. A won lead can contribute to both historical appointment and win milestones, but exactly one current
   disposition.
9. Prior-period comparisons use equal windows and identical non-time filters.
10. Keyboard navigation, focus states, contrast, tooltips, and chart text alternatives meet WCAG 2.2 AA.

## Recommended first release

The safest high-value first release is Phase 1. It does not dispute the CRM base totals or pretend that
missing event history exists. It makes the current math legible, eliminates misleading funnel language,
surfaces attribution quality, and moves the CEO's decisions above the fold while the event model is
built correctly.
