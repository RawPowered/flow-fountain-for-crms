# PARROT Python bridge

PARROT is the governed Python execution bridge for HAWK, EAGLE, and OWL. The
Workbench Node application remains the control plane and the only caller. PARROT
is a stateless WSGI service that authenticates Node, resolves a built-in handler
or validates an immutable managed-source package, applies bounded runtime and
payload policies, and returns a sanitized result.

## Boundaries

- No browser calls PARROT directly.
- Browsers cannot send source directly to the Python service. Admin and HAWK source travels through Node over the authenticated service channel.
- Managed source cannot import modules, access files or environment variables, start processes, or use unrestricted network APIs.
- PARROT receives no CRM token, database password, Workbench machine secret, or SQL authority.
- Python results are proposals or calculations. OWL and HAWK reapply their normal policy before mutation.
- Durable run metadata lives in `parrot_runs`; security lifecycle events live in Sentinel.
- Studio source is intended for trusted administrators. The restricted runtime is a governance boundary, not a hardened multi-tenant sandbox.

## Python service contract

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | None | Minimal Passenger readiness |
| GET | `/v1/catalog` | PARROT service Bearer token | Registered script manifests |
| POST | `/v1/source/validate` | PARROT service Bearer token | Validate managed source and return its immutable hash |
| POST | `/v1/runs` | PARROT service Bearer token | Execute one registered handler |

The run envelope uses `contractVersion: "parrot.v1"` and includes `runId`,
`requestId`, `source`, `mode`, `scriptId`, optional `scriptVersion`, scoped
context, sanitized inputs, and hard limits. The response returns the resolved
script version, sanitized output, duration, output size, and stable error code.

## Administrative control plane

The PARROT console is available at:

```text
{ADMIN_BASE_PATH}/parrot
```

Session-protected APIs:

| Method | Path | Purpose |
|---|---|---|
| GET | `{base}/api/parrot/bootstrap` | Scope, health, catalog, and recent runs |
| GET | `{base}/api/parrot/health` | Refresh bridge health |
| GET | `{base}/api/parrot/catalog` | Refresh registered scripts |
| GET | `{base}/api/parrot/runs` | Scoped run ledger |
| GET | `{base}/api/parrot/runs/{id}` | One scoped run |
| POST | `{base}/api/parrot/runs` | Governed manual dry/live run |
| POST | `{base}/api/parrot/scripts/validate` | Validate a Studio draft |
| GET/POST | `{base}/api/parrot/scripts` | List or create governed scripts |
| GET/PUT | `{base}/api/parrot/scripts/{id}` | Read a script or save a new immutable version |
| POST | `{base}/api/parrot/scripts/{id}/dry-run` | Execute a draft without deployment |
| POST | `{base}/api/parrot/scripts/{id}/deploy` | Approve and deploy the latest version |
| POST | `{base}/api/parrot/scripts/{id}/retire` | Remove a command from the live catalog |
| GET | `{base}/api/parrot/scripts/{id}/export` | Export the latest draft as `parrot-script-1` JSON |
| GET | `{base}/api/parrot/imports/schema` | Export the live PARROT package schema and scoped CRM fields |
| POST | `{base}/api/parrot/imports/preview` | Validate a portable package through live PARROT |
| POST | `{base}/api/parrot/imports/apply` | Import, clone, or re-import validated scripts as drafts |

Every scope is anchored to API key, database source, and location. Versions pin
the source hash, declared capabilities, and input contract. Live manual runs and
deployments require explicit confirmation.

## Script Studio and restricted helpers

Open **Script Studio** inside PARROT to author, validate, version, dry-run,
deploy, and retire scripts. A script exposes exactly
`run(inputs, context)` and must return JSON-safe data. Imports and direct system
access are rejected. Opt-in helpers include `dns_lookup()` for `network.dns`
and `http_get()` for `network.http`; both are limited to the configured host
allowlist and public addresses. Utility helpers include `sha256()`,
`json_encode()`, `json_decode()`, and `url_parse()`.

Set `PARROT_RECON_ALLOWED_HOSTS` in the Python environment to a comma-separated
list of approved exact hosts or wildcard suffixes such as `*.example.com`.
Network access remains denied when the list is empty. HTTP is HTTPS-only unless
`PARROT_RECON_ALLOW_HTTP=true` is intentionally configured.

## AI authoring and portable JSON

The Script Studio toolbar provides **AI Rules**, **Export CRM Fields**,
**Sample Python Script**, **Import / Re-import**, and **Export JSON**. Give an AI
the rules file, the live CRM schema, and the sample package. The generated root
must use `format: "parrot-script-1"`.

The live schema includes current scoped CRM field IDs, HAWK runtime templates,
data types, writable flags, and picklist values. This metadata is for mapping
HAWK values into the script input contract; PARROT never receives CRM
credentials. Exported packages contain source and contracts, but no deployment
approval. Imports support `skip`, `clone`, and `replace_draft` conflict policies.
Every imported version is revalidated by the live Python service and remains a
draft until separately dry-run and deployed.

## HAWK integration

`parrot.run` selects a deployed Studio or built-in command and sends rendered
`inputs`. **Bundle Python with HAWK** (`parrot.inline`) stores source in the HAWK
flow, validates it during publish, and pins its hash in the published graph.
HAWK tests execute PARROT actions in `dry_run` mode so output can feed later
test steps. Live executions use the HAWK execution and node IDs to create a
stable idempotency key. A managed command cannot run live unless its Studio
version is deployed; bundled source cannot run live unless its published hash
still matches.

## Deployment

See the project README and `parrot/README.md` for Windows and Linux startup.
