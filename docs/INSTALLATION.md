# Installation and operations

[Return to Fountain](../README.md)

## Requirements

- Windows or Linux.
- A maintained Node.js 22 or 24 release; Node.js 24 LTS is the default choice.
- A running MySQL 8 database and your own database credentials.
- Python 3.12 or newer only for the optional Python bridge and Python tests.

Node release information: [official release schedule](https://github.com/nodejs/Release).

## Windows

Extract the source ZIP, open PowerShell in the extracted folder, then run:

```powershell
npm.cmd ci
Copy-Item .env.example .env
npm.cmd start
```

Alternatively run `./start.ps1`; it creates a local configuration and installs
dependencies on first use. If your PowerShell policy blocks script execution,
use the three commands above.

## Linux

Extract the same source ZIP, open a terminal in the extracted folder, then run:

```sh
npm ci
umask 077
cp .env.example .env
npm start
```

Alternatively run `sh start.sh`.

## First installation

1. Open `http://127.0.0.1:3000/install` on the same computer.
2. Enter credentials for a new, empty MySQL database. The installer can create
   the database if the supplied account has permission, or use an existing empty
   database. Never point a fresh installation at an unrelated database.
3. Create your own administrator account. Passwords require at least 12 characters
   including uppercase, lowercase, and numeric characters.
4. Keep the generated administrator login address. API key creation is optional
   and unchecked by default. Installation generates fresh keys and endpoint
   identifiers and writes them to the local `.env` file.
5. Restart the application after installation so readiness checks and background
   workers initialize against the new database.
6. Add only the integrations, service mappings, resources, and workflows you need.

The application binds to loopback by default. Local HTTP installations use local
development mode so administrator sessions work without a TLS proxy. Keep `.env`
and runtime data private. Linux file permissions are set restrictively where
supported; use Windows account permissions to protect the application directory.

## Server deployments

For an installation served beyond your computer, set `LOCAL_DEVELOPMENT=false`,
`NODE_ENV=production`, and `COOKIE_SECURE=true` before installing. Keep loopback
binding behind a local HTTPS reverse proxy, or set `HOST` explicitly for your
deployment. Set `TRUST_PROXY` to match your actual proxy configuration and set
explicit `CORS_ORIGINS` only if browser clients need cross-origin access.
Restart after configuration changes. Production sessions require HTTPS.

External adapter URLs and credentials are blank. `CRM_ALLOWED_ORIGINS` accepts
exact HTTPS origins for compatible custom CRM adapters; it does not trust every
subdomain. `CRM_APP_ORIGIN` controls optional contact links. Custom CRM field
mappings are supplied through the blank `CRM_*_FIELD_ID` settings.

Public provider endpoints remain in adapter code where required for its protocol
or security allowlist: Google authentication, LeadConnector, DNCScrub, Census,
RDAP, and coordinate timezone resolution. These are provider addresses, not an
installation domain or a preconfigured search. The integration and feature
documentation is in [`content/docs/`](../content/docs/index.md); reserved example addresses are placeholders.

## Optional Python bridge

See the [Python bridge guide](../parrot/README.md). The main application works without the bridge. The bridge
has no dependency on a particular hosting provider or operating system.

## Checks and release package

```sh
npm test
npm run test:python
npm run release:check
npm run release:pack
```

The release command creates a Windows/Linux source ZIP and SHA-256 checksum in
`dist/`. It includes only files explicitly listed in `release-manifest.json` and
runs the release privacy check first. It excludes dependencies, runtime settings,
data, logs, archives, private assets, editor state, and previous Git history.
Review any new manifest entries before accepting them. The scanner is a release
guard, not a guarantee that arbitrary future changes are free of private data.

GitHub Actions runs the checks on Windows and Linux with Node.js 22 and 24 and
Python 3.12. See [GitHub's matrix documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).

## Publication

Publish this clean source directory as a new repository. Do not upload a working
installation or import its Git history. Run the release check after staging files
and before pushing. Optional integrations require each user's own configuration.

Licensed under the GNU General Public License, version 3 only (`GPL-3.0-only`).
See [LICENSE](../LICENSE) for the complete terms. Dependency licenses remain applicable; see
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Use this research project with data and systems you are
authorized to access.
