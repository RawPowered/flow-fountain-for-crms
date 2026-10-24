# Flow Fountain for CRMs — 0.1.1

- Renamed the project and repository to Flow Fountain for CRMs.
- Clarified that it was originally built for GoHighLevel / LeadConnector and can be adapted to other API-enabled CRMs through integration work.
- Updated the README, project artwork, package metadata, links, and source archive names.
- Retained blank installation settings, existing functionality, and GPL v3 licensing.

This is a project rename and positioning update. The preview limitations below still apply.

## Initial 0.1.0 preview

Initial GPL v3 research preview for Windows and Linux.

- Generic source distribution with a blank first-install configuration.
- Research workflows, investigation cases, audit records, and evidence preservation.
- Optional SQL, HTTP, CRM, and Python integrations configured by the operator.
- No installation domains, credentials, customer identifiers, branded image assets,
  saved research targets, or deployment workflow packs.
- Windows PowerShell and Linux shell launchers, plus installation documentation.
- Explicit release file manifest, privacy checks, and SHA-256 package checksum.

The same source ZIP runs on Windows and Linux. Install Node.js 22 or 24 and MySQL 8
separately; Python 3.12+ is optional. This release does not include a standalone
executable, database server, API subscriptions, or third-party service credentials.

Validation completed locally on Windows with Node.js 22 and on Linux with Node.js
24, including automated application checks, blank startup and private-route checks,
and Python tests on both systems. Release packaging checks verify the exact file
allowlist and ZIP integrity. GitHub Actions provides a Windows/Linux matrix with
Node.js 22/24 and Python 3.12.

A complete installation against a live MySQL server has not yet been verified in
this release preparation. Optional external integrations also require their own
credentials and end-to-end validation. Treat this initial version as a research
preview. Existing private deployments are separate from this clean distribution.
