# Preservation Control Plane — Phase 1

Phase 1 implements the management and evidence layer defined by the
[Phase 0 charter](preservation-sync-phase-0). It does not yet extract records or
render CSV, XML, XLSX, or SQL artifacts; those workers and adapters belong to
Phase 2.

## Delivered capabilities

- Write-only encrypted credential vault with rotation versions, retirement
  controls, non-secret hints, and consumer references.
- Registered logical data sources and existing CRM/SQL connection references.
- Registered S3-compatible, SFTP, HTTPS, and local-staging destinations.
- Declarative export definitions for CSV, XML, XLSX, and SQL.
- Editable draft versions and immutable published/superseded versions.
- Durable export jobs with idempotency and validated state transitions.
- Artifact, SHA-256 verification, manifest, delivery-attempt, and protection
  evidence models.
- Dedicated append-only preservation audit events in addition to Sentinel
  request auditing.
- Admin management interface under the installation-defined hidden admin path.

## Access

The management page is:

```text
{installation admin path}/preservation
```

Access is evaluated through separate preservation capabilities: `view`,
`manage_secrets`, `manage_integrations`, `design_exports`, `run_exports`,
`download_artifacts`, `restore_configuration`, and `view_audit`. Root receives
all capabilities. Platform administrators receive view, integration management,
definition design, and export-run capabilities. Credential management,
artifact download, configuration restore, and preservation-audit access remain
root-only. Tenant and viewer principals receive no preservation capabilities.
Decrypted credential values are not exposed by any admin endpoint.

All paths shown below are relative to the installation-defined admin path. They
do not change the independently installation-defined public API prefix.

## Admin API

### Bootstrap and catalogs

| Method | Relative path | Purpose |
|---|---|---|
| GET | `/api/preservation/bootstrap` | Access, catalogs, references, registries, definitions, and recent jobs |

### Credential vault

| Method | Relative path | Purpose |
|---|---|---|
| GET | `/api/preservation/secrets` | List non-secret metadata and credential references |
| POST | `/api/preservation/secrets` | Store an encrypted credential; root only |
| POST | `/api/preservation/secrets/:id/rotate` | Replace encrypted material and increment its version; root only |
| POST | `/api/preservation/secrets/:id/retire` | Retire an unused credential; root only |

Secret input may be a string or structured JSON. Public responses include only
the credential ID, kind, status, version, timestamps, and non-secret hint.
Active consumers must be disabled or reassigned before retirement.

Supported kinds are `api_key`, `bearer_token`, `basic_auth`, `oauth_client`,
`aws_credentials`, `ssh_key`, and `connection_json`.

### Source registry

| Method | Relative path | Purpose |
|---|---|---|
| GET | `/api/preservation/integrations` | List registered logical sources |
| POST | `/api/preservation/integrations` | Register a source |
| PUT | `/api/preservation/integrations/:id` | Update or disable a source |
| POST | `/api/preservation/integrations/:id/validate` | Validate configuration and credential references |

Source adapters are `workbench`, `crm`, `mysql`, and `http_api`. Existing
`crm_integrations` and `sql_connections` are referenced rather than copied.
Generic HTTP sources require a public HTTPS URL. Loopback, private, link-local,
metadata, and credential-bearing URLs are rejected.

### Destination registry

| Method | Relative path | Purpose |
|---|---|---|
| GET | `/api/preservation/destinations` | List registered destinations |
| POST | `/api/preservation/destinations` | Register a destination |
| PUT | `/api/preservation/destinations/:id` | Update or disable a destination |
| POST | `/api/preservation/destinations/:id/validate` | Validate configuration and credential references |

Remote destinations require credential references. `local_staging` is always
marked as not being a protection target. A Phase 1 validation proves structural
configuration and credential-reference integrity; it deliberately does not
claim a successful live connection.

### Export definitions and versions

| Method | Relative path | Purpose |
|---|---|---|
| GET | `/api/preservation/definitions` | List definitions |
| GET | `/api/preservation/definitions/:id` | Read a definition and version history |
| POST | `/api/preservation/definitions` | Create a definition with draft version 1 |
| PUT | `/api/preservation/definitions/:id` | Update definition metadata |
| POST | `/api/preservation/definitions/:id/versions` | Clone a new draft from the current version |
| PUT | `/api/preservation/versions/:id` | Update an editable draft |
| POST | `/api/preservation/definitions/:id/versions/:versionId/validate` | Validate mappings, filters, format, source, and destination |
| POST | `/api/preservation/definitions/:id/versions/:versionId/publish` | Publish and make the version immutable |
| POST | `/api/preservation/definitions/:id/archive` | Archive a definition after active jobs finish |

Mappings have a source path, output target, value type, optional formatting, and
one of the bounded transforms `none`, `trim`, `lowercase`, or `uppercase`.
Filters use an allowlisted operator set. Source configuration rejects fields
that introduce arbitrary SQL, code, scripts, shell commands, or execution.

SQL output targets must be safe identifiers. XML targets must be safe element
names. XLSX sheet names, CSV delimiters, SQL dialects, and SQL batch sizes are
bounded and validated.

Publishing records a canonical schema SHA-256. Published and superseded version
content cannot be edited.

### Jobs

| Method | Relative path | Purpose |
|---|---|---|
| GET | `/api/preservation/jobs` | List recent jobs |
| GET | `/api/preservation/jobs/:id` | Read job, artifacts, manifest metadata, and delivery attempts |
| POST | `/api/preservation/jobs` | Queue a published definition |
| POST | `/api/preservation/jobs/:id/cancel` | Cancel a queued job |

The Phase 1 state machine is:

```text
queued → extracting → rendering → delivering → completed
   └──────────────→ cancelled
extracting/rendering/delivering → failed
```

Only the application worker calls service-level execution transitions. Browser
routes can queue work and cancel work that has not started.

Job completion requires:

1. At least one artifact.
2. Every artifact in `verified` state with a SHA-256 checksum.
3. A successful delivery for every artifact.
4. A `verified_off_instance` protection state only when a successful delivery
   used a destination marked as an off-instance protection target.

## Declarative definition example

```json
{
  "slug": "daily-lead-preservation",
  "name": "Daily lead preservation",
  "locationId": "location-123",
  "sourceType": "catalog",
  "sourceKey": "leads_contacts",
  "destinationId": "destination-uuid",
  "format": "csv",
  "retentionDays": 30,
  "scheduleCron": "0 2 * * *",
  "sourceConfig": {
    "includeCurrentCustomFields": true
  },
  "mappings": [
    {
      "source": "contact.id",
      "target": "contact_id",
      "type": "string",
      "required": true
    },
    {
      "source": "contact.email",
      "target": "email",
      "type": "string",
      "transform": "lowercase"
    }
  ],
  "filters": [
    {
      "field": "contact.locationId",
      "operator": "eq",
      "value": "location-123"
    }
  ],
  "formatConfig": {
    "delimiter": ",",
    "includeHeader": true,
    "newline": "lf"
  }
}
```

## Phase 2 entry criteria

Phase 2 can begin when:

- Schema revision 48 has been applied.
- At least one off-instance destination is registered.
- A representative definition for each desired format validates and publishes.
- The worker uses service-level state transitions instead of directly mutating
  job status.
- Artifact files are written only beneath a configured staging root.
- Encryption occurs before remote delivery.
- Renderer and delivery adapters never receive browser-supplied raw queries,
  code, credentials, or absolute filesystem paths.
- End-to-end tests prove manifest checksums and protection-state calculation.
