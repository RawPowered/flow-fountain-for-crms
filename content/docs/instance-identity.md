# Installation-defined instance identity

Each production installation receives an independent external identity. The installer generates it by default, or an operator can provide store-specific values on the installation form.

## External surface

| Setting | Purpose | Default at installation |
| --- | --- | --- |
| `PUBLIC_API_BASE_PATH` | Mount point for the machine API and help/OpenAPI catalog | Random URL-safe path |
| `WEBHOOK_BASE_PATH` | Mount point for HAWK and OWL inbound webhooks | Independent random path |
| `HEALTH_PATH` | Public health-check endpoint | Independent random path |
| `API_KEY_PREFIX` | Prefix on newly issued API keys | Random prefix |
| `AUTOMATION_NAMESPACE` | Namespace for instance-owned HAWK actions | Random namespace |
| `SESSION_COOKIE_NAME` | Admin session cookie name | Random name |
| `OPERATOR_COOKIE_NAME` | Dialer operator cookie name | Independent random name |
| `API_METADATA_HEADER_PREFIX` | Optional API metadata header prefix | Random prefix; headers disabled |

`INSTANCE_ID` is a generated UUID used to create instance-scoped schema URNs. `API_DISPLAY_NAME` is descriptive and may be set to the store-facing suite name.

The installer writes the complete identity to `.env` and returns a one-time connection summary containing the effective API, webhook, and health paths. Those values should be stored with the deployment record and supplied to the reverse proxy, monitors, and client configuration.

## Validation rules

- API, webhook, and health paths must be different.
- Paths contain one to three URL-safe segments and cannot begin with a predictable reserved segment such as `api`, `hooks`, `health`, `admin`, or `install`.
- Admin and operator cookie names must be different.
- Production startup fails closed when an installed instance has a missing or partial identity.
- Optional vendor/version metadata headers remain disabled unless explicitly enabled.

## Operational notes

Do not rewrite an instance path to a common public prefix at the reverse proxy. Forward the generated path unchanged, and configure health monitoring with the generated health path. Public paths are defense in depth only: API keys, operator sessions, webhook secrets, grants, rate limits, and IP controls remain the authorization boundary.

Development without identity variables retains predictable local-only defaults so existing test harnesses can mount the application. These defaults are rejected for an installed production runtime.
