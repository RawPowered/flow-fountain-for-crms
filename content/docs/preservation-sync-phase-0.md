# Preservation, Exports, and Platform Sync — Phase 0 Charter

**Status:** Accepted as the provisional engineering baseline  
**Owner:** Workbench platform operations  
**Applies to:** New, individually deployed Workbench instances  
**Review point:** Before Phase 1 schema and interface implementation

This charter defines what Workbench means by backup, preservation export, and
platform sync. The policies below are intentionally explicit so that the
interface cannot accidentally turn an integration feature into an unrestricted
data-exfiltration or database-administration surface.

Values marked **provisional** are safe implementation defaults. An authorized
platform owner may replace them before production rollout without changing the
architectural boundary.

## 1. Three distinct capabilities

| Capability | Purpose | Typical content | Restore or consume path |
|---|---|---|---|
| **Portable preservation export** | Give an authorized customer a usable copy of selected customer data | Scoped records in CSV, XML, XLSX, or SQL data format; schema and manifest | Download, external archive, analytics system, or controlled re-import |
| **Application configuration backup** | Reconstruct Workbench configuration on a replacement instance | Settings, mappings, grants, automation definitions, and optionally separately wrapped secrets | Workbench configuration restore workflow |
| **Disaster-recovery backup** | Recover the complete server-side data store after infrastructure loss | Native encrypted MySQL full backup plus point-in-time recovery material | Operations-only native database restore |

An export is not a database backup. A SQL-formatted export is a portable data
artifact, not a substitute for a native MySQL backup with a tested restore
procedure.

## 2. Architectural decisions

| ID | Decision |
|---|---|
| PS-0001 | The three capabilities above have separate job types, permissions, retention rules, and restore paths. |
| PS-0002 | Every export is produced from a canonical streamed record model. CSV, XML, XLSX, and SQL are renderers over that model, not independent query implementations. |
| PS-0003 | Local disk is a staging destination only. An instance is not reported as **protected** until a verified artifact exists in at least one off-instance destination. |
| PS-0004 | Initial platform sync is one-way outbound. Bidirectional sync, destination-to-source writes, and automatic destination deletions are outside the initial release. |
| PS-0005 | All sources, fields, locations, operations, and destinations are default-deny and explicitly granted. |
| PS-0006 | Custom formats use declarative field selection, aliases, ordering, filters, and type formatting. Arbitrary code, shell commands, and user-supplied raw SQL are prohibited. |
| PS-0007 | Every artifact has an immutable manifest, record counts, byte count, schema version, SHA-256 checksum, source watermarks, and audit correlation ID. |
| PS-0008 | Individual server deployment does not remove internal scope. Customer/location scope remains mandatory to prevent accidental cross-location exports. |
| PS-0009 | API and callback paths use the installation-defined routing configuration. The preservation layer must not introduce a fixed `/api` or product-specific URL fingerprint. |
| PS-0010 | A successful job means the artifact was written, verified, and—when configured—confirmed at its off-instance destination. Generation alone is not success. |

## 3. Release-one scope

### Included sources

- Workbench customer and operational records, scoped by the authorized
  customer/location.
- Current CRM contact records and normalized custom-field values.
- External MySQL tables that already pass the SQL Connection Hub connection,
  table, operation, and column grants.
- EAGLE analytical facts and snapshots when explicitly selected.
- Non-secret Workbench configuration, mapping, grant, and automation
  definitions.

### Excluded from portable customer exports

- Encrypted integration passwords, CRM credentials, MFA secrets, session
  material, API-key hashes, password hashes, and token hashes.
- Sentinel forensic HTTP envelopes and forensic access records.
- Cross-location platform-administration data.
- Raw database pages, binary logs, and native disaster-recovery material.
- Arbitrary database queries or tables not registered in the source catalog.

Restricted security records may be included in an operations-only encrypted
disaster-recovery backup. If credential escrow is later approved, secrets must
be packaged separately with a distinct wrapping key and restore permission.

## 4. Security and control model

1. **Credential vault boundary.** Destination and source credentials are
   encrypted at rest through the dedicated secret-box facility. The data model
   stores a credential reference and metadata; it never returns decrypted
   credentials to the browser.
2. **Purpose-scoped access.** Permissions are separate for viewing
   integrations, testing connections, editing credentials, designing exports,
   running exports, downloading artifacts, restoring configuration, and
   viewing audit history.
3. **Step-up controls.** Secret changes, credential reveal/replacement,
   disaster-recovery restore, and destructive retention actions require
   platform-level authorization and a fresh authenticated session.
4. **Network controls.** Connection targets are normalized and validated.
   Production policy must block loopback, link-local, cloud metadata, and
   unapproved private destinations unless explicitly allowlisted for the
   installation.
5. **Artifact encryption.** Artifacts are encrypted before leaving the
   instance. Transport must use TLS or SSH. Encryption keys are not embedded in
   the artifact manifest.
6. **Auditability.** Secret reads, configuration changes, tests, runs,
   downloads, retries, cancellations, retention actions, and restores create
   append-only audit events.
7. **Log hygiene.** Logs may contain connection IDs, job IDs, counts, hashes,
   and sanitized errors; they must not contain credentials, complete customer
   records, or signed download URLs.

## 5. Provisional service objectives

These are engineering defaults pending contractual and operating-cost
approval.

| Service tier | RPO | RTO | Minimum mechanism |
|---|---:|---:|---|
| Tier 1: primary Workbench database | 24 hours baseline; 1 hour target | 8 hours baseline; 4 hours target | Daily native encrypted backup off-instance; binary-log/PITR support for target |
| Tier 2: configuration state | 1 hour or on material change | 4 hours | On-change snapshot plus nightly off-instance package |
| Tier 3: scheduled customer preservation export | 24 hours | 24 hours to regenerate or retrieve | Daily schedule, verified manifest, off-instance copy |
| Tier 4: security audit evidence | 24 hours | 8 hours | Daily encrypted off-instance backup under Sentinel policy |

Backups are restored into an isolated environment at least quarterly. A restore
drill is successful only after integrity checks and representative application
queries pass. Artifact renderers also receive quarterly round-trip tests using
non-production fixtures.

## 6. Provisional retention policy

| Data or artifact class | Default |
|---|---|
| Generated export artifacts | 30 days hot storage; up to 90 days off-instance |
| Export manifests, checksums, and job audit metadata | 1 year |
| Completed CRM staging payloads | 30 days after completion |
| Failed or conflict-bearing CRM staging payloads | 90 days |
| CRM current records after integration disconnect | 90 days |
| Automation execution payloads | 90 days; execution metadata 1 year |
| Webhook delivery evidence | 90 days; do not add full payload retention by default |
| Application configuration snapshots | 90 days and latest 12 successful versions, whichever preserves more |
| Native daily DR backups | 35 days; retain 12 monthly recovery points |
| Customer data after service termination | 90-day export window, then purge |
| Legal or contractual hold | Suspends applicable deletion until explicitly released |

Existing Sentinel retention policies remain authoritative for Sentinel data.
Existing EAGLE snapshot pruning remains at the latest 12 snapshots until a
specific analytics-retention decision replaces it.

Every retention deletion must be scoped, auditable, previewable, and
idempotent. A customer-visible job must show the calculated expiration time
before execution.

## 7. Sync semantics

The first implementation supports:

- Full exports and incremental exports using a stable primary key plus
  high-water mark.
- One-way delivery to a registered destination.
- Retry with bounded exponential backoff and an idempotency key.
- Resumption from a committed checkpoint without duplicating committed
  records.
- Source-schema drift detection before render or delivery.
- Explicit manual promotion of a new mapping version.

The first implementation does not support:

- Bidirectional reconciliation.
- Automatic propagation of source deletions or destination tombstones.
- Silent mapping changes when a source adds, removes, or changes a field.
- Exactly-once claims across third-party systems. Workbench provides
  at-least-once delivery with idempotent artifacts and delivery records.

## 8. Restore and verification contract

Every job creates a manifest containing:

- Instance ID and installation-defined route identity, without credentials.
- Export definition and mapping versions.
- Source IDs, scopes, filters, watermarks, and extraction timestamps.
- Per-object schema, record count, rejected count, and warning count.
- Artifact filenames, media types, byte counts, encryption metadata, and
  SHA-256 checksums.
- Destination delivery attempts and verified final state.
- Application build and schema migration versions.

Restore or import is a separate, explicitly authorized job. It validates the
manifest, checksum, encryption envelope, schema compatibility, scope, and dry
run before changing application data.

## 9. Existing foundations to retain

Phase 1 should compose the existing controls rather than creating parallel
credential or grant systems:

- CRM credential encryption, provider validation, grants, import cursors,
  staging hashes, and conflict records.
- SQL Connection Hub encrypted credentials, connection tests, metadata
  discovery, and per-key table/operation/column grants.
- Sentinel append-only audit and preview-first retention practices.
- OWL and HAWK webhook delivery ledgers and retry evidence.
- Installation-defined instance identity and API route prefixes.

## 10. Decisions requiring owner approval

The following do not block Phase 1 schema work because the provisional defaults
above are explicit, but they must be approved before production use:

1. Contractual post-termination and customer-data retention periods.
2. Whether encrypted credential escrow is offered at all.
3. Required off-instance destination type and whether object-lock capability is
   mandatory.
4. Paid infrastructure needed to meet the 1-hour RPO and 4-hour RTO targets.
5. Which customer roles may design, run, and download exports.
6. Release-one source catalog and whether EAGLE exports are customer-visible.
7. Legal-hold authority and release procedure.
8. Maximum artifact size, run duration, concurrency, and customer quotas.

## 11. Phase 1 entry criteria

Phase 1 may begin when:

- This charter and the [data inventory](preservation-data-inventory) are
  accepted as the working baseline.
- Each schema table is assigned to a data domain and preservation class.
- Backup, export, and disaster-recovery job types remain separate in the
  proposed schema and API.
- The source catalog and permission model are default-deny.
- Destination secrets use the existing secret-box boundary.
- Job manifests, checksums, audit events, retention timestamps, and restore
  verification are mandatory—not optional UI features.
- New routes consume the installation-defined route prefix.

Phase 1 will produce the integration registry, destination registry, export
definition and mapping versions, job state machine, artifact manifest, delivery
ledger, and their permission/audit model.
