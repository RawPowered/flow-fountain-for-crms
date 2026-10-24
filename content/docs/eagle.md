# EAGLE Executive Lead Intelligence

EAGLE is the read-only CEO dashboard for lead geography, CRM disposition, marketing attribution,
service demand, and dialer execution. It is intentionally separate from OWL: EAGLE explains the
business; OWL changes operations.

Admin UI:

```text
{ADMIN_BASE_PATH}/eagle
```

## Source hierarchy

Each EAGLE refresh creates an immutable snapshot with this precedence:

1. After a successful OWL full sync, EAGLE reads the reconciled current contact set locally. If no
   complete local set exists, it fetches CRM contacts with the same exhaustive compound-cursor walker.
2. CRM contact fields and tags determine identity, geography, attribution, campaign, contact
   owner, freshness, and executive disposition.
3. Matching `lead_source_links` add the current dialer lead ID, service, status, owner, and DNC
   state as operational overlays.
4. Neither CRM contacts nor operational `leads` rows are updated by EAGLE.

Before every EAGLE snapshot, including snapshots built from a completed local full sync, EAGLE
refreshes CRM custom-field definitions for all supported models.
Returned contact custom-field IDs are resolved to names automatically, and demographic values
such as date of birth, age, gender, household income, ownership, property type, language, and time
zone are projected into the snapshot when corresponding fields exist. The full raw contact payload
remains available in the CRM ingestion store; EAGLE does not require a manually maintained field list.
When EAGLE uses a completed local full-sync set, it also reuses its field catalog and does not issue
another historical CRM download.

For HighLevel Private Integration Tokens, definition discovery requires the
`locations/customFields.readonly` scope. EAGLE sends the required `Version: v3` header and
`model=all`, then resolves contact payload field IDs against the returned `id`, `fieldKey`, and
`name`. The Demographics endpoint also reapplies the current catalog while reading older snapshots,
so catalog repairs can restore labels without rewriting immutable snapshot facts.

The selected API key must have `allow_read` on the integration. Credentials remain encrypted and
are never returned to the browser.

## Dashboard views

| View | Decision supported |
|------|--------------------|
| Executive KPIs | Period lead volume, current scheduled/won states, actionable unassigned leads, attribution coverage, and DNC exposure |
| Call Center | Governed live pool supply, current-week staffing evidence, verified work, CRM-confirmed calls, and appointment production |
| Performance pulse | Snapshot-anchored lead intake compared with the immediately preceding equal-length period |
| Current disposition | Mutually exclusive CRM state composition; explicitly not a historical conversion funnel |
| Performance drivers | Source, campaign, service, or market volume and current outcomes with sample-size context |
| Top markets | Compact city ranking on the overview, with the full Census/map analysis in Market Detail |
| U.S. lead map | State concentration and Census context in the dedicated Market Detail view |
| State/city ranking | Exact market volume comparison |
| Lead flow | CRM disposition mix and acquisition pace |
| Marketing performance | Source and campaign volume, appointments, wins, and appointment rate |
| Lead detail | Dedicated filterable CRM-first spreadsheet with dialer overlays; search does not alter executive KPIs |
| Demographics | Profile, household, financial, interests, property, opportunity, and dynamic custom-field analysis |
| Campaign Monitor | Form/widget submissions, landing pages, referrers, UTM/Facebook attribution, and CRM outcomes |
| CSV export | Up to 10,000 filtered rows including expanded demographic projections |

Call Center Phase 1 is a read-only server contract; its visual view and reassignment controls are
introduced in later phases. See [EAGLE Call Center](eagle-call-center.md) for definitions, evidence
limitations, and the governance gate that prevents premature personnel scoring.

Map clicks and ranking selections apply the same state/city filters used by the KPI, marketing,
trend, and spreadsheet views. This keeps every number on screen reconcilable.

Period filters are anchored to the selected snapshot's completion timestamp rather than the current
database date. The dashboard returns the report `asOf`, current window, and equal-length prior window,
so reopening an immutable snapshot produces the same scoped result. Current-state rates expose their
numerator and denominator. A missing denominator is displayed as unavailable, not as `0%`.

## Governed metric contract

The dashboard API returns `contractVersion: 2.0` and a `metrics` object keyed by stable metric ID.
Each metric contains its definition version, label, description, unit, numerator and denominator labels,
time basis, business owner, availability status, value, numerator, denominator, previous-period value,
comparison kind/value, `asOf`, and period boundaries. The browser formats these objects but does not
calculate business rates or comparisons.

Breakdowns are returned under `breakdowns` with server-calculated share, current scheduled rate,
current won rate, and sample-confidence classification. Each dimension includes reconciliation metadata:
filtered total, source total, returned total, difference, unknown total, `Other` total, truncation state,
and a reconciled flag. Unknown attribution remains explicit. Top-N results aggregate omitted known rows
into `Other (remaining)` instead of silently dropping volume.

### Governed attribution

`eagle_attribution_mappings` maps raw CRM source and campaign values to integration-scoped canonical
labels and optional channels. Active mappings merge aliases into one executive row. Ignored mappings,
empty values, placeholder values, and identifier-only labels remain visible with an unknown-reason code.
Unmapped readable values continue as `raw_unmapped` until Revenue Operations approves a mapping.

Canonical source and campaign filters include every active raw alias mapped to that label.

Each Lead Detail row includes an **Open contact** link. EAGLE constructs the allowlisted Custom CRM
CRM route from the snapshot's authorized location ID and external contact ID, and opens it in a new
browser tab without exposing the upstream API credential.

## Geographic coverage and population reference

EAGLE separates address quality from market penetration. A contact having a state value does not
mean the business covers the United States, and a reported CRM city is not automatically an official
Census place.

| Metric | Definition |
|--------|------------|
| Location completeness | Contacts with a valid state divided by filtered contacts |
| State presence | Distinct represented states divided by the 50 states; DC is shown but is not a state in this denominator |
| State population footprint | Population of represented states divided by the U.S. population |
| Census-place presence | Distinct CRM city/state pairs matched to official Census places |
| Place population footprint | Population of matched represented places divided by the U.S. population |
| Place match rate | Contacts whose city/state matched an official Census place divided by filtered contacts |
| Lead density | Matched contacts per 100,000 residents across matched represented places |

Population values come from `B01003_001E` in the configured U.S. Census Bureau ACS 5-year dataset.
ACS values are estimates, not counts of EAGLE leads. Exact city matching is intentionally visible:
postal city names, unincorporated areas, spelling differences, and missing city values can remain
unmatched instead of being reported as false geographic penetration.

Configure a free Census Data API key and dataset year:

```env
CENSUS_API_KEY=your-census-key
CENSUS_DATA_YEAR=2024
```

After migration, use **Refresh Census data** in EAGLE. The refresh stages nation, state, and place
records in memory and replaces only that dataset year in one transaction, so a failed upstream
request does not erase the last good reference. EAGLE then reads only place rows for states present
in the filtered lead set.

Equivalent official API checks are:

```bash
curl "https://api.census.gov/data/2024/acs/acs5?get=NAME%2CB01003_001E&for=us%3A%2A&key=$CENSUS_API_KEY"
curl "https://api.census.gov/data/2024/acs/acs5?get=NAME%2CB01003_001E&for=state%3A%2A&key=$CENSUS_API_KEY"
curl "https://api.census.gov/data/2024/acs/acs5?get=NAME%2CB01003_001E&for=place%3A%2A&in=state%3A12&key=$CENSUS_API_KEY"
```

The **Demographics** tab uses the same period and portfolio filters. Its `executive` contract separates
generic profile completeness from decision-useful household, financial, property, and audience
signals. The server returns a factual audience headline, insight-ready profile coverage, sample
confidence, spotlight characteristics, composition distributions, domain readiness, and coverage gaps.

The executive view leads with those signals visually. The exhaustive category inventory and field
explorer remain available in the collapsed Analyst Workbench, where categorical values are ranked and
numeric fields expose median, average, minimum, and maximum. Names, email addresses, phone numbers,
street addresses, websites, and exact birth dates may contribute to completeness but are excluded from
the executive story and their individual values remain suppressed from all distributions.

Run **Refresh from CRM** after deploying this revision. Existing snapshots retain their original
demographic projection; a new snapshot resolves the expanded field catalog and stores the new
household, financial, interest, profile, property, opportunity, and custom-field values.

## Campaign Monitor

Campaign Monitor reads the official HighLevel `GET /forms/submissions` resource with `Version: v3`.
The Private Integration Token must include `forms.readonly`. Synchronization follows `meta.nextPage`
sequentially at 100 events per page and persists stable submission IDs, allowing repeated full-range
syncs to update rather than duplicate events.

The projection retains attribution metadata only: contact ID, form identity, event time, page
URL/title, referrer, source/medium, UTM campaign/content, and Facebook/Google click identifiers.
Submitted answers, phone/name fields, consent text, chat messages, fingerprints, and session IDs are
not copied into Campaign Monitor. Stored page/referrer URLs remove credentials, fragments, and
non-attribution query parameters before persistence.

The default historical range begins at `2020-01-01` and can be changed server-side:

```env
EAGLE_CAMPAIGN_START_DATE=2020-01-01
```

EAGLE joins submission contacts to the selected immutable snapshot to report scheduled and closed-won
contacts. Landing-page, form, and Facebook rankings therefore measure generated lead submissions and
downstream CRM outcomes. They do not represent impressions, click-through rate, spend, or return on
ad spend; those require Social Planner/Ads reporting datasets in a separate future source.

## Normalized disposition

EAGLE classifies CRM status fields and tags into executive groups with a fixed precedence:

`Closed Won`, `Scheduled`, `DNC`, `Not Interested`, `Closed DNQ`, `Closed Lost`, `Working`,
`Assigned`, and `New / Unworked`.

These groups are mutually exclusive current states. `Currently scheduled / leads in scope` and
`Currently won / leads in scope` are state-composition rates, not historical lead-to-appointment or
lead-to-win conversion. A contact classified as `Closed Won` is not also counted as `Scheduled`.
Historical funnel metrics require authoritative appointment and opportunity event history.

## Historical cohort funnel

Schema 29 adds an event-grain outcome model. Every completed EAGLE refresh idempotently records:

- `lead_created` from the CRM contact's authoritative `crm_date_added` timestamp;
- `appointment_booked` from local `appointments.createdAt`, linked through the dialer lead to the CRM contact.

Appointment conversion therefore means mature cohort contacts with at least one recorded appointment
booking divided by mature cohort leads. It is not inferred from tags or the current `Scheduled` state.

The cohort maturity window defaults to 14 days and can be configured server-side:

```env
EAGLE_COHORT_MATURITY_DAYS=14
```

Recent and undated contacts are excluded from the historical conversion denominator and remain visible
as excluded cohort volume. The API also returns appointment and win counts grouped by their event date.

## Executive validation and rollout

Schema 30 adds an integration-scoped release gate. The **Validation** view compares metrics from a
frozen EAGLE snapshot with independently produced control totals and stores the evidence reference,
tolerance, difference, and outcome for every check. Percentage metrics default to an absolute
0.5-percentage-point tolerance; count metrics default to a 1% difference tolerance.

Rollout modes are `legacy`, `parallel`, and `governed`. Promotion to governed mode requires the
configured number of consecutive passed runs on distinct snapshots. Repeating the same snapshot does
not advance readiness, and a failed or incomplete latest run breaks the passing sequence. Every mode
change requires an audit reason. Set `EAGLE_VALIDATION_REQUIRED_RUNS` to configure the gate (default `2`).

Validation uses `GET/POST /api/eagle/validation-runs` and `GET /api/eagle/validation-runs/:id`.
Rollout state uses `GET/PUT /api/eagle/rollout`.

## CEO attention brief and trust status

Phase 5 adds `executiveBrief` to the dashboard response. It is deterministic and generated from the
same governed metric objects as the scorecard. The browser performs no prioritization math. The brief
keeps three concepts separate:

- **Needs attention:** factual queues such as actionable unassigned leads, attribution gaps, DNC
  exclusions, and missing opportunity evidence;
- **Period momentum:** direction and magnitude of server-calculated prior-period comparisons;
- **Data trust:** snapshot freshness, validation recency, and integration rollout mode.

Movement is not labeled good or bad without an approved target. Snapshot freshness defaults to 26
hours and validation evidence to 72 hours. Configure these display trust limits with
`EAGLE_FRESHNESS_SLA_HOURS` and `EAGLE_VALIDATION_MAX_AGE_HOURS`. Trust status does not mutate or
recalculate the frozen snapshot metrics.

## Governed business targets

Schema 31 adds integration-scoped KPI targets. Each target declares a metric, `at_least` or `at_most`
direction, target value, warning margin, business owner, and active state. EAGLE evaluates the current
governed metric on the server and returns `on_target`, `near_target`, `off_target`, or `unavailable`.
Percentage variance is expressed in percentage points; count variance remains a count.

The **Targets** view is the governance surface. Every save requires a reason and writes the prior and
new definition to `eagle_metric_target_audit`. Inactive targets remain visible for governance but do
not affect KPI badges or the CEO attention brief. Prior-period movement remains separate from target
status so “up” is never assumed to mean “good.”

### Target applicability

Schema 32 binds every target to an approved reporting period: 7, 30, 90, or 365 days, or all time.
Targets are integration-wide and apply only when all dimensional filters are clear. A period mismatch
or any state, city, service, disposition, source, or campaign filter returns `not_applicable` with a
plain-language reason. EAGLE does not calculate variance or escalate the target into the CEO attention
queue for that incompatible scope.

Targets created before schema 32 receive an all-time period. They remain visible but do not apply to a
bounded period until an administrator revises and re-approves them.

### Opportunity evidence

Lead-to-win and appointment-to-win remain unavailable until EAGLE receives a complete opportunity
extract for the selected snapshot through `POST /api/eagle/opportunities/import`. A complete import must
provide `opportunityId`, `contactId`, `status`, and authoritative `wonAt`/`lostAt` timestamps for terminal
records. Partial imports may be stored for validation but do not activate executive win metrics.

Example:

```json
{
  "apiKeyId": "KEY_ID",
  "snapshotId": "SNAPSHOT_ID",
  "sourceSystem": "crm-opportunities",
  "isComplete": true,
  "records": [
    {
      "opportunityId": "OPPORTUNITY_ID",
      "contactId": "CRM_CONTACT_ID",
      "status": "won",
      "stageName": "Closed Won",
      "openedAt": "2026-07-01T14:00:00Z",
      "wonAt": "2026-07-10T18:00:00Z",
      "monetaryValue": 12500
    }
  ]
}
```

Complete imports replace the selected snapshot's opportunity projection transactionally. Dated open,
won, and lost events are deduplicated by integration, source opportunity ID, and event type.

Both the current-state classification and imported opportunity projection are reporting-only. They do
not alter CRM tags, opportunities, pipeline stages, or dialer pool status.

## Snapshot tables

| Table | Purpose |
|-------|---------|
| `eagle_snapshots` | Refresh status, source context, freshness, and record/page counts |
| `eagle_lead_facts` | Indexed CRM facts plus dialer overlays for one immutable snapshot |
| `eagle_metric_definitions` | Versioned business labels, formulas, time basis, and ownership metadata |
| `eagle_attribution_mappings` | Integration-scoped raw-to-canonical source and campaign aliases |
| `eagle_lead_events` | Deduplicated authoritative lead, appointment, and opportunity lifecycle events |
| `eagle_outcome_imports` | Opportunity import completeness and source manifests |
| `eagle_opportunity_snapshots` | Opportunity state and authoritative terminal timestamps at a snapshot |
| `eagle_metric_targets` | Active and inactive approved KPI thresholds by CRM integration |
| `eagle_metric_target_audit` | Immutable target changes with actor and governance reason |

Snapshots use the shared exhaustive CRM walker and finish only at a valid upstream terminal
condition. A repeated cursor or the emergency 100,000-page ceiling fails the snapshot instead of
silently presenting incomplete data as complete.
The newest 12 finished snapshots per integration are retained; older snapshot facts are removed
after a successful refresh.

## Admin routes

All paths are relative to `{ADMIN_BASE_PATH}` and require an admin session.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/eagle` | Executive dashboard |
| GET | `/api/eagle/contexts` | Readable API key and CRM integration contexts |
| POST | `/api/eagle/snapshots` | Queue a complete CRM-first snapshot |
| GET | `/api/eagle/snapshots/latest` | Latest completed snapshot for a context |
| GET | `/api/eagle/snapshots/{id}` | Refresh progress and counts |
| GET | `/api/eagle/dashboard` | KPI and aggregate datasets under shared filters |
| GET | `/api/eagle/validation-runs` | Validation history for an authorized integration |
| POST | `/api/eagle/validation-runs` | Record a frozen-snapshot control-total comparison |
| GET | `/api/eagle/validation-runs/{id}` | Validation checks and evidence for one run |
| GET | `/api/eagle/rollout` | Current rollout gate and readiness |
| PUT | `/api/eagle/rollout` | Audited rollout mode change |
| GET | `/api/eagle/rollout-audit` | Rollout transition evidence and reasons |
| GET | `/api/eagle/targets` | Governed target definitions for an authorized integration |
| PUT | `/api/eagle/targets` | Create, revise, activate, or deactivate an audited target |
| GET | `/api/eagle/attribution-mappings` | List governed source and campaign aliases for an authorized integration |
| PUT | `/api/eagle/attribution-mappings` | Create or update an integration-scoped attribution mapping |
| POST | `/api/eagle/opportunities/import` | Import a partial or complete authoritative opportunity extract |
| GET | `/api/eagle/geography-reference` | Current Census reference status and dataset year |
| POST | `/api/eagle/geography-reference/refresh` | Refresh official nation, state, and place population references |
| GET | `/api/eagle/demographics` | Filtered demographic coverage, field catalog, and distributions |
| POST | `/api/eagle/campaigns/sync` | Queue an exhaustive HighLevel form-submission synchronization |
| GET | `/api/eagle/campaigns/sync/{id}` | Campaign synchronization progress and errors |
| GET | `/api/eagle/campaigns` | Campaign KPIs, rankings, trend, and recent attribution events |
| GET | `/api/eagle/leads` | Paginated spreadsheet facts |
| GET | `/api/eagle/export.csv` | Filtered CSV export |

## Deployment

Apply schema version 32:

```bash
npm run migrate
```

Schema 32 adds explicit target-period applicability and safe migration for existing target rows. It
retains target-change evidence from schema 31 and does not replace operational leads.
