# Preservation Data Inventory

**Inventory source:** `sql/schema.sql`  
**Scope:** Workbench application-owned MySQL schema  
**Purpose:** Phase 0 classification for preservation, export, and recovery  
**Rule:** A table absent from this inventory is not exportable until it is
classified and approved.

## Classification legend

| Class | Meaning | Portable customer export |
|---|---|---|
| C1 Public/reference | Non-customer reference or published definition | Allowed when useful |
| C2 Internal configuration | Application configuration without live secrets | Configuration backup; customer export only when explicitly owned |
| C3 Customer operational | Customer/location records and derived operational data | Allowed with explicit scope |
| C4 Restricted PII/payload | Contact data, free-form payloads, or detailed activity | Allowed only with explicit field grants and artifact encryption |
| C5 Secret/authentication | Credentials, hashes, MFA, session, or signing material | Prohibited |
| C6 Security/forensic | Security telemetry, investigations, and forensic evidence | Operations-only unless separately approved |

“DR only” means the table belongs in an encrypted native disaster-recovery
backup but not in a portable preservation export.

## Domain inventory

### Identity, access, and application configuration

| Tables | Class | System of record | Preservation treatment |
|---|---|---|---|
| `app_settings`, `wiki_pages` | C2 | Workbench | Configuration backup; export only explicitly selected non-secret settings |
| `admin_users`, `platform_administrators`, `tenant_administrators`, `admin_login_names` | C5 | Workbench | DR only; a restore must preserve authorization scope |
| `admin_mfa_identities`, `api_keys`, `api_operator_sessions` | C5 | Workbench | DR only; never emit in portable exports |

Secret-like columns in otherwise exportable tables are independently C5 and
must be excluded by the source catalog.

### Core customer and dialer operations

| Tables | Class | System of record | Preservation treatment |
|---|---|---|---|
| `location_data`, `leads`, `appointments`, `rewards`, `users` | C3/C4 | Workbench or synchronized CRM, per record origin | Primary customer preservation dataset; location scope required |
| `lead_call_attempts`, `lead_compliance_checks`, `lead_timezone_cache`, `lead_calendar_sync_state`, `lead_call_restriction_overrides` | C3/C4 | Workbench | Exportable operational history with field-level grants |
| `user_schedules`, `user_schedule_weeks`, `dialer_work_sessions`, `dialer_workspaces`, `dialer_activity_minutes` | C3/C4 | Workbench | Exportable by location and authorized user scope |
| `dnc_pulse_events` | C4 | Workbench | Restricted compliance export; audit every run |
| `system_errors`, `auth_logs` | C5/C6 | Workbench | Operations preservation and DR; no default customer export |

### CRM integration and preservation store

| Tables | Class | System of record | Preservation treatment |
|---|---|---|---|
| `crm_integrations` | C2/C5 | Workbench | Configuration backup; exclude encrypted credentials from portable package |
| `crm_integration_grants`, `crm_field_definitions`, `crm_field_mappings`, `crm_object_definitions`, `crm_object_field_definitions` | C2 | Workbench | Versioned configuration backup and optional mapping export |
| `crm_import_runs` | C3 | Workbench | Job/audit metadata; retain 1 year provisionally |
| `crm_import_staging` | C4 | Synchronized CRM copy | Not a primary customer export source; 30/90-day provisional retention |
| `lead_source_links`, `lead_import_values`, `crm_contact_records` | C3/C4 | CRM is upstream; Workbench is preserved copy | Exportable with customer/location and field grants |
| `lead_import_conflicts` | C4 | Workbench | Exportable for reconciliation; retain 90 days after resolution provisionally |

### OWL operations and routing

| Tables | Class | System of record | Preservation treatment |
|---|---|---|---|
| `owl_user_pool_permissions`, `owl_assignment_policies`, `owl_user_language_permissions`, `owl_lead_pool_rules`, `owl_service_pools` | C2/C3 | Workbench | Configuration backup; customer export when location-owned |
| `owl_audit_events` | C4/C6 | Workbench | Audit preservation; controlled customer export only |
| `owl_webhook_endpoints` | C2/C5 | Workbench | Configuration backup; exclude signing material/secrets |
| `owl_webhook_deliveries` | C3/C6 | Workbench | Delivery evidence; retain 90 days provisionally |

### SONG scripts

| Tables | Class | System of record | Preservation treatment |
|---|---|---|---|
| `song_scripts`, `song_script_versions`, `song_service_assignments`, `song_service_language_assignments` | C2/C3 | Workbench | Versioned configuration/customer-content backup |
| `song_runtime_events` | C4 | Workbench | Customer operational export with field grants; 90-day payload retention provisionally |

### HAWK automation and PARROT execution

| Tables | Class | System of record | Preservation treatment |
|---|---|---|---|
| `hawk_flow_folders`, `hawk_flows`, `hawk_flow_versions` | C2/C3 | Workbench | Versioned configuration backup |
| `hawk_executions`, `hawk_execution_steps`, `hawk_dialer_assignment_events` | C3/C4 | Workbench | Operational export; payload bodies 90 days and metadata 1 year provisionally |
| `hawk_webhook_endpoints` | C2/C5 | Workbench | Configuration backup; exclude signing material/secrets |
| `hawk_webhook_deliveries` | C3/C6 | Workbench | Delivery evidence; retain 90 days provisionally |
| `parrot_scripts`, `parrot_script_versions` | C2/C3 | Workbench | Versioned configuration backup; review embedded values for secrets |
| `parrot_runs` | C3/C4 | Workbench | Operational export; payload bodies 90 days and metadata 1 year provisionally |

### EAGLE analytics and reference data

| Tables | Class | System of record | Preservation treatment |
|---|---|---|---|
| `eagle_snapshots`, `eagle_lead_facts`, `eagle_lead_events`, `eagle_opportunity_snapshots`, `eagle_campaign_events` | C3/C4 | Workbench derived store | Explicit customer export; preserve latest 12 snapshots initially |
| `eagle_metric_definitions`, `eagle_attribution_mappings`, `eagle_metric_targets` | C2/C3 | Workbench | Configuration backup and optional customer export |
| `eagle_outcome_imports`, `eagle_campaign_sync_runs` | C3/C4 | Workbench | Import/sync evidence; retain metadata 1 year provisionally |
| `eagle_validation_runs`, `eagle_validation_checks`, `eagle_rollout_states`, `eagle_rollout_audit`, `eagle_debug_actions`, `eagle_metric_target_audit` | C2/C3/C6 | Workbench | Operations/configuration preservation; controlled export |
| `census_geography_reference` | C1 | External public reference copied by Workbench | Rebuildable; include schema/version in DR, not required in customer export |

### External SQL Connection Hub

| Tables | Class | System of record | Preservation treatment |
|---|---|---|---|
| `sql_connections` | C2/C5 | Workbench | Configuration backup; encrypted passwords are DR-only or separately wrapped |
| `sql_connection_grants`, `sql_table_grants` | C2 | Workbench | Configuration backup and authorization evidence |

External tables are not part of the Workbench schema inventory. They become
eligible sources only through an active connection plus explicit table,
operation, and column grants. The external database remains authoritative.

### Preservation and application-integration control plane

| Tables | Class | System of record | Preservation treatment |
|---|---|---|---|
| `integration_secrets` | C5 | Workbench | DR only; encrypted values are never included in portable exports |
| `integration_registry`, `preservation_destinations` | C2/C5 | Workbench | Configuration backup; credential references may be retained but encrypted values remain separate |
| `preservation_export_definitions`, `preservation_export_versions` | C2/C3 | Workbench | Versioned configuration backup and customer-owned definition export |
| `preservation_jobs`, `preservation_artifacts`, `preservation_job_manifests`, `preservation_delivery_attempts` | C3/C4 | Workbench | Preservation evidence under artifact and job retention policy; storage URIs require controlled access |
| `preservation_audit_events` | C6 | Workbench | Append-only operations evidence; retain 1 year provisionally |

### Sentinel security and forensics

| Tables | Class | System of record | Preservation treatment |
|---|---|---|---|
| `api_sentinel_events`, `api_login_events`, `sentinel_ip_blocks`, `sentinel_ip_sightings`, `sentinel_ip_intel_cache` | C6 | Workbench | Sentinel retention and operations backup; no default customer export |
| `sentinel_http_envelopes`, `sentinel_forensic_access` | C6 | Workbench | Restricted forensic store; operations-only encrypted backup |
| `sentinel_threat_cases`, `sentinel_case_actions`, `sentinel_case_notes`, `sentinel_case_status_history` | C6 | Workbench | Preserve under case/hold policy; never purge merely because source events expire |
| `sentinel_validation_runs`, `sentinel_validation_observations`, `sentinel_rule_techniques`, `sentinel_routine_runs` | C6 | Workbench | Sentinel policy; operations reporting only |
| `sentinel_retention_policies`, `sentinel_retention_runs`, `sentinel_finding_dispositions` | C2/C6 | Workbench | Preserve policy and audit history; DR plus controlled operations export |
| `sentinel_playbooks`, `sentinel_playbook_versions`, `sentinel_playbook_steps` | C2/C6 | Workbench | Versioned security configuration backup |
| `sentinel_playbook_runs`, `sentinel_playbook_step_runs`, `sentinel_playbook_reviews`, `sentinel_playbook_simulations`, `sentinel_playbook_validation_results` | C6 | Workbench | Security operations evidence under Sentinel policy |
| `sentinel_resource_items`, `sentinel_resource_reviews`, `sentinel_custom_rules` | C2/C6 | Workbench | Security configuration and review preservation |

## Column-level restrictions

The source catalog must inspect columns in addition to the table classification.
At minimum, columns matching these purposes are always restricted:

- Passwords, password hashes, API-key hashes, session IDs, MFA material, signing
  secrets, OAuth/client secrets, encrypted credential blobs, and encryption
  keys: **C5, never portable**.
- Email, phone, postal address, IP address, contact JSON, CRM payload JSON,
  script inputs/outputs, request/response bodies, and free-form notes:
  **C4, explicit grant and encrypted artifact required**.
- Internal route prefixes and instance identity may appear in a manifest only
  when required for restoration; public artifacts should use neutral logical
  identifiers.

## Authority and consistency rules

1. The export manifest identifies whether Workbench or an external system is
   authoritative for every object.
2. A preservation export captures a consistent watermark. Related tables use
   the same logical cutoff even when extraction is chunked.
3. Derived tables are labeled as derived and include the source watermark or
   snapshot ID.
4. A partial extraction cannot be marked successful. It is failed or completed
   with explicit rejects and warnings recorded in the manifest.
5. Schema drift pauses the affected definition until an authorized mapping
   version is promoted.

## Phase 1 source catalog

The first source catalog should register domain-level sources rather than
expose raw table selection:

| Logical source | Backing data | Initial modes |
|---|---|---|
| Customer directory | Locations and users | Full, incremental |
| Leads and contact preservation | Leads, CRM current records, normalized custom fields, source links | Full, incremental |
| Appointments and outcomes | Appointments, rewards, outcome/import facts | Full, incremental |
| Dialer operations | Workspaces, sessions, activity, call/compliance facts | Full, incremental |
| Schedules and routing | Schedules, pools, permissions, policies | Full |
| Automation definitions | SONG, HAWK, and PARROT definitions and versions | Full, version-selected |
| Automation activity | Runtime events, executions, steps, and runs | Full, incremental |
| EAGLE analytics | Approved snapshots, facts, events, and definitions | Full, snapshot-selected |
| External SQL dataset | Explicitly granted external tables and columns | Full, incremental when stable watermark exists |
| Configuration package | Non-secret application and integration configuration | Full |

Sentinel and native disaster-recovery backups remain operations-only sources
and are not registered as customer export datasets by default.
