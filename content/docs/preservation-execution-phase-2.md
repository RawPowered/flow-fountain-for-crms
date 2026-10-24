# Preservation Execution — Phase 2

Phase 2 activates the data plane behind the
[Phase 1 control plane](preservation-control-plane): scoped extraction,
streaming transformation, CSV/XML/XLSX/SQL rendering, encrypted staging,
delivery, verification, scheduling, and recovery.

## Execution flow

```text
published definition
  → claim leased job
  → capture stable source watermark
  → extract scoped records in keyset pages
  → apply allowlisted filters and field mappings
  → stream renderer output
  → encrypt artifact with a unique data key
  → store and verify ciphertext SHA-256
  → create and verify manifest
  → deliver encrypted artifact
  → record remote evidence
  → complete with local_only or verified_off_instance
```

The worker starts automatically on installed and configured instances when
`PRESERVATION_WORKER_ENABLED` is not `false`.

## Sources

### Workbench source catalog

The initial catalog provides:

- `customer_directory`
- `leads_contacts`
- `appointments_outcomes`
- `dialer_operations`
- `schedules_routing`
- `automation_definitions`
- `automation_activity`
- `eagle_analytics`
- `configuration_package`

Customer datasets require `locationId`. Each dataset uses a fixed server-side
table and column allowlist. Password hashes, session material, credentials, and
secret-like application settings are not selected.

Extraction uses keyset pagination with a maximum primary-key watermark captured
before the first page. Records added after the watermark belong to the next
run.

### CRM preservation store

`crm_integration` sources read current `crm_contact_records` for the selected
integration and location. Payloads are emitted together with preservation
metadata and bounded by an `external_record_id` watermark.

### External SQL

`sql_connection` sources require:

```json
{
  "apiKeyId": "granted-api-key-id",
  "table": "approved_table",
  "locationColumn": "location_id",
  "columns": ["id", "location_id", "email"]
}
```

The worker re-evaluates the existing SQL Connection Hub grant before every run.
The table must allow select, requested columns must be allowlisted, and the
grant-defined primary key drives pagination. Raw SQL is never accepted.

### Registered HTTPS APIs

Generic HTTPS sources use the registered origin and a relative path. Redirects
and origin changes are rejected. Supported credentials are bearer token, API
key, and basic authentication references. Pagination is configured with public
field names such as `recordsPath`, `nextCursorPath`, and `cursorParam`; secret
headers cannot be placed in public configuration.

## Renderers

All formats consume the same mapped async record stream:

| Format | Behavior |
|---|---|
| CSV | UTF-8, configurable bounded delimiter/newline, RFC-style quoting |
| XML | UTF-8 declaration, validated root/row/field element names, escaped values |
| XLSX | Native OpenXML workbook with inline strings; no spreadsheet dependency or macro support |
| SQL | Data-only transaction with optional table DDL, safe identifiers, escaped literals, bounded insert batches |

The worker does not execute SQL exports. SQL is rendered as portable data text.

XLSX is produced as a streaming, store-mode ZIP/OpenXML package. Its worksheet
limit is 1,048,576 rows including the header.

## Encryption

Plain renderer output exists only inside the job’s dedicated staging directory
and is removed immediately after encryption.

Each artifact receives:

- A random 256-bit data key.
- AES-256-GCM streaming encryption.
- A random data IV.
- A data authentication tag.
- A data key wrapped with an instance key derived from `SECRET_BOX_KEY`.
- A SHA-256 checksum over the complete encrypted envelope.

The wrapped data key and non-secret encryption metadata are stored with the
artifact. The instance master key is never stored in the database or manifest.

Remote adapters receive only the encrypted `.fse` envelope. Root-authorized
downloads are decrypted as a stream and use `Cache-Control: no-store`.

## Destinations

- **Local staging:** copies the encrypted envelope beneath the configured
  preservation root and can never produce `verified_off_instance`.
- **HTTPS:** PUT by default or configured POST, strict TLS, no redirect,
  content checksum headers, and registered credential injection.
- **S3-compatible:** native AWS Signature Version 4 PUT, encrypted content
  checksum metadata, configurable region/prefix/HTTPS endpoint.
- **SFTP:** strict registered host and credential reference, recursive remote
  directory creation, encrypted upload.

Successful delivery records the remote reference, ciphertext byte count, and
SHA-256 checksum. All active artifacts must have successful delivery evidence
before a job can complete.

## Scheduling and recovery

Published five-field schedules are evaluated in UTC. A minute-specific
idempotency key prevents duplicate scheduled jobs.

Workers claim jobs with a renewable lease. If a process disappears:

- Expired leases below the attempt limit are requeued.
- Partial artifacts are marked abandoned.
- Incomplete deliveries are failed.
- The fixed source watermark is retained.
- Rendering restarts safely from the beginning.
- Jobs exceeding the attempt limit fail with
  `WORKER_LEASE_EXHAUSTED`.

## Configuration

| Environment variable | Default |
|---|---:|
| `PRESERVATION_WORKER_ENABLED` | `true` |
| `PRESERVATION_STAGING_ROOT` | `./var/preservation` |
| `PRESERVATION_WORKER_POLL_MS` | `15000` |
| `PRESERVATION_CHUNK_SIZE` | `500` |
| `PRESERVATION_MAX_RECORDS` | `1000000` |
| `PRESERVATION_MAX_ARTIFACT_BYTES` | `1073741824` |
| `PRESERVATION_MAX_ATTEMPTS` | `3` |

The staging root must be a dedicated directory and cannot be a filesystem or
workspace root.

## Operational use

1. Apply schema revision 49.
2. Register and validate a remote destination.
3. Create, validate, and publish an export definition.
4. Queue a job or attach a UTC schedule.
5. Watch the job progress through extraction, rendering, and delivery.
6. Confirm `verified_off_instance`.
7. Periodically retrieve an artifact and validate the restored content.
