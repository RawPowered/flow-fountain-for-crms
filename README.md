<p align="center">
  <img src="docs/assets/fountain-mark.svg" alt="Fountain" width="78">
</p>

<h1 align="center">Fountain</h1>

<p align="center"><strong>OSINT Research Studio 360</strong><br>
A self-hosted workspace for research workflows, investigation review, and evidence preservation.</p>

<p align="center">
  <a href="docs/INSTALLATION.md"><img src="docs/assets/platforms.svg" alt="Windows and Linux" height="28"></a>
  <a href="LICENSE"><img src="docs/assets/license.svg" alt="GPL v3 license" height="28"></a>
  <a href="RELEASE_NOTES.md"><img src="docs/assets/preview.svg" alt="Research preview" height="28"></a>
  <a href="https://github.com/RawPowered/osint-research-studio-360-fountain/actions/workflows/ci.yml"><img src="https://github.com/RawPowered/osint-research-studio-360-fountain/actions/workflows/ci.yml/badge.svg" alt="Windows and Linux checks" height="28"></a>
</p>

<p align="center">
  <a href="https://github.com/RawPowered/osint-research-studio-360-fountain/releases/tag/v0.1.0"><strong>Download</strong></a> ·
  <a href="#product-tour">Product tour</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/INSTALLATION.md">Installation guide</a> ·
  <a href="content/docs/index.md">Documentation</a>
</p>

<p align="center">
  <img src="docs/assets/fountain-hero.svg" alt="Fountain connects operator-configured sources, analyst review, and preservation. Project illustration." width="100%">
</p>

## Give your research a repeatable process

Fountain brings workflow authoring, investigation review, audit records, and export preparation into a configurable workspace. Connect approved data sources, arrange the steps your team needs, and keep the operational trail available for review.

The project combines research foundations with optional CRM and operational modules. Every installation begins with its own configuration: no deployment domains, credentials, saved targets, customer mappings, or research searches are bundled.

| Build a workflow | Review the context | Preserve the trail |
|:---|:---|:---|
| Arrange triggers, conditions, and actions in a visual editor. Add reviewed Python processing when needed. | Inspect security events, findings, case activity, and playbooks in a dedicated console. | Define scoped exports, version the mappings, and track preservation jobs and delivery evidence. |

> [!IMPORTANT]
> **Research preview.** Source releases are available for Windows and Linux under GPL v3. Automated checks run on both platforms with Node.js 22 and 24. A full installation against a live MySQL server and external integration acceptance checks remain unverified. Read the [release notes](RELEASE_NOTES.md) before deployment.

## Product tour

These are browser captures of Fountain's real interface. The workspace screens use an isolated preview with **fictional data and mocked API responses**; they illustrate the interface rather than completed live operations. The installer capture shows the blank setup screen. Preview records and illustration assets do not configure a fresh installation.

### Design the steps before you run them

HAWK provides a visual workspace for triggers, conditions, actions, and execution review. This fictional note-review draft uses manual input and local flow data; it has no search target or external connection.

<p align="center">
  <a href="docs/assets/screenshots/workflow-designer.png"><img src="docs/assets/screenshots/workflow-designer.png" alt="HAWK visual workflow designer with a fictional source-note review draft, condition branches, and an empty execution history" width="100%"></a>
</p>

### Focused workspaces for the rest of the process

<table>
  <tr>
    <td width="50%" valign="top"><strong>Review security and case context</strong><br><sub>SENTINEL brings event activity, response priorities, and control health into one view.</sub><br><br><a href="docs/assets/screenshots/sentinel-overview.png"><img src="docs/assets/screenshots/sentinel-overview.png" alt="SENTINEL overview populated with clearly fictional traffic and review statistics" width="100%"></a></td>
    <td width="50%" valign="top"><strong>Prepare a preservation definition</strong><br><sub>Register sources and destinations, define exports, and follow job evidence.</sub><br><br><a href="docs/assets/screenshots/evidence-preservation.png"><img src="docs/assets/screenshots/evidence-preservation.png" alt="Preservation workspace with a fictional draft CSV export and no completed or protected jobs" width="100%"></a></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><strong>Compose reviewed Python operations</strong><br><sub>PARROT exposes registered handlers, input contracts, dry-run controls, and run history.</sub><br><br><a href="docs/assets/screenshots/python-console.png"><img src="docs/assets/screenshots/python-console.png" alt="PARROT console with an offline text-normalization example and the bridge explicitly not configured" width="100%"></a></td>
    <td width="50%" valign="top"><strong>Start with your own configuration</strong><br><sub>The installer asks for your database and administrator account. Connection credentials begin empty.</sub><br><br><a href="docs/assets/screenshots/blank-installation.png"><img src="docs/assets/screenshots/blank-installation.png" alt="Blank Fountain installer with empty database user, password, and database name fields" width="100%"></a></td>
  </tr>
</table>

<p align="center"><sub>Click any image to inspect it at full size. Workspace captures contain fictional demonstration data. <a href="docs/SCREENSHOTS.md">Screenshot provenance and privacy review</a>.</sub></p>

## The workspace at a glance

| Workspace | Purpose |
|:---|:---|
| **SENTINEL** | Security event review, findings, investigation cases, playbooks, and audit context. |
| **Preservation** | Source and destination registries, versioned export definitions, encrypted staging, and job records. |
| **HAWK** | Visual automation authoring with conditions, actions, dry runs, and execution history. |
| **PARROT** | Optional Python bridge for registered handlers and reviewed, versioned processing scripts. |
| **EAGLE** | CRM and operational analytics, geographic views, and reporting. |
| **OWL** | Scoped operational records, queues, users, assignments, and scheduling. |
| **SONG** | Conditional script authoring, publishing, version selection, and runtime events. |
| **Integration controls** | Operator-configured SQL, HTTP, and CRM connections with scoped grants and credential references. |

The modules are available as building blocks. Enable and configure the parts that fit your own research and operational process.

## How it fits together

```mermaid
flowchart LR
    USER[Researcher or analyst] --> APP[Fountain control plane]
    APP --> REVIEW[Investigation and event review]
    APP --> FLOW[Workflow authoring]
    APP --> EXPORT[Preservation definitions]
    APP <--> DB[(Your MySQL database)]
    FLOW -. Optional .-> PY[Registered Python bridge]
    APP -. Configured adapters .-> SOURCES[Your SQL, HTTP, or CRM sources]
    EXPORT --> STAGE[Encrypted local staging]
    STAGE -. Configured delivery .-> DEST[Your preservation destination]
    classDef core fill:#eef5ff,stroke:#4385ff,color:#10223f
    classDef module fill:#e8f8f5,stroke:#1ca99b,color:#0c514b
    classDef optional fill:#f4f0fc,stroke:#8c71c8,color:#4d386f
    class USER,APP,DB core
    class REVIEW,FLOW,EXPORT,STAGE module
    class PY,SOURCES,DEST optional
```

Public provider addresses remain in adapters where their protocols or allowlists require them. Each user supplies their own integration configuration and credentials. See the [architecture notes](content/docs/architecture.md) and [installation guide](docs/INSTALLATION.md).

## Quick start

**You will need:** Windows or Linux, Node.js 22 or 24, and a running MySQL 8 database. Python 3.12+ is optional for the Python bridge. Download the source ZIP from the [releases page](https://github.com/RawPowered/osint-research-studio-360-fountain/releases) and extract it first.

### Windows · PowerShell

```powershell
npm.cmd ci
Copy-Item .env.example .env
npm.cmd start
```

Or run `./start.ps1` from the extracted directory.

### Linux · Terminal

```sh
npm ci
umask 077
cp .env.example .env
npm start
```

Or run `sh start.sh` from the extracted directory.

Open **http://127.0.0.1:3000/install**, enter your database settings, and create your administrator account. Save the generated login address and restart after installation. The application binds to your computer's loopback interface by default.

[Read the complete setup and server deployment guide →](docs/INSTALLATION.md)

## Start blank. Configure deliberately.

- Installation identity, administrator access, and encryption keys are generated locally.
- External connections, custom field mappings, research targets, and allowed network hosts start unconfigured.
- Documentation artwork and screenshot fixtures are separate from application settings.
- Runtime configuration, dependencies, logs, and local evidence are excluded from the release file list.
- Release checks scan approved source files; documentation PNGs must match explicitly reviewed file hashes.

For an HTTPS server deployment, configure production mode, secure cookies, the proxy boundary, and browser origins for your own environment. Keep `.env` and runtime evidence private. The [installation guide](docs/INSTALLATION.md) covers these settings.

## Documentation and project status

| Start here | Explore further |
|:---|:---|
| [Installation and operations](docs/INSTALLATION.md) | [Module and API documentation](content/docs/index.md) |
| [Release notes and current limitations](RELEASE_NOTES.md) | [Optional Python bridge](parrot/README.md) |
| [Screenshot provenance](docs/SCREENSHOTS.md) | [Third-party notices](THIRD_PARTY_NOTICES.md) |
| [GPL v3 license](LICENSE) | [Windows and Linux checks](https://github.com/RawPowered/osint-research-studio-360-fountain/actions) |

To validate a checkout:

```sh
npm test
npm run test:python
npm run release:check
npm run release:pack
```

Use Fountain with data and systems you are authorized to access. Public issues should describe reproducible behavior without including credentials, personal records, or private evidence.

---

<p align="center"><img src="docs/assets/fountain-mark.svg" alt="" width="36"><br><strong>Fountain</strong><br><sub>Your sources. Your configuration. Your research process.</sub></p>
