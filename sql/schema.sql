-- Workbench Custom API — MySQL schema (platform + operational)

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key   VARCHAR(64)  NOT NULL PRIMARY KEY,
  setting_value TEXT         NOT NULL,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_users (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  username      VARCHAR(64)  NOT NULL,
  email         VARCHAR(255) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('admin','viewer') NOT NULL DEFAULT 'admin',
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_admin_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Delegated platform administrators. Root identities remain exclusively in admin_users.
CREATE TABLE IF NOT EXISTS platform_administrators (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  username       VARCHAR(100) NOT NULL UNIQUE,
  email          VARCHAR(255) NULL,
  password_hash  VARCHAR(255) NOT NULL,
  is_enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  created_by     CHAR(36)     NOT NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_platform_admin_enabled (is_enabled, username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tenant administrators are fail-closed to one API-key portfolio.
CREATE TABLE IF NOT EXISTS tenant_administrators (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  api_key_id     CHAR(36)     NOT NULL,
  username       VARCHAR(100) NOT NULL UNIQUE,
  email          VARCHAR(255) NULL,
  password_hash  VARCHAR(255) NOT NULL,
  is_enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  created_by     CHAR(36)     NOT NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_tenant_admin_scope (api_key_id, is_enabled, username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cross-table uniqueness guard for delegated login names.
CREATE TABLE IF NOT EXISTS admin_login_names (
  username        VARCHAR(100) NOT NULL PRIMARY KEY,
  principal_type  ENUM('platform','tenant') NOT NULL,
  principal_id    CHAR(36)     NOT NULL UNIQUE,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-principal Google step-up binding. A Google subject may protect only one administrator.
CREATE TABLE IF NOT EXISTS admin_mfa_identities (
  principal_type   ENUM('root','platform','tenant') NOT NULL,
  principal_id     CHAR(36)     NOT NULL,
  provider         ENUM('google') NOT NULL DEFAULT 'google',
  provider_subject VARCHAR(191) NOT NULL,
  email            VARCHAR(255) NOT NULL,
  enrolled_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_verified_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (principal_type, principal_id),
  UNIQUE KEY uq_admin_mfa_provider_subject (provider, provider_subject),
  KEY idx_admin_mfa_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_keys (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  name          VARCHAR(128) NOT NULL,
  key_prefix    VARCHAR(16)  NOT NULL,
  key_hash      CHAR(64)     NOT NULL,
  created_by    CHAR(36)     NULL,
  last_used_at  TIMESTAMP    NULL DEFAULT NULL,
  revoked_at    TIMESTAMP    NULL DEFAULT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_api_keys_prefix (key_prefix),
  KEY idx_api_keys_active (revoked_at),
  KEY idx_api_keys_hash (key_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wiki_pages (
  slug          VARCHAR(128) NOT NULL PRIMARY KEY,
  title         VARCHAR(255) NOT NULL,
  body_md       MEDIUMTEXT   NOT NULL,
  is_published  TINYINT(1)   NOT NULL DEFAULT 1,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_sentinel_events (
  id            BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  api_key_id    CHAR(36)     NULL,
  key_prefix    VARCHAR(16)  NULL,
  method        VARCHAR(10)  NOT NULL,
  path          VARCHAR(255) NOT NULL,
  status_code   SMALLINT     NOT NULL,
  duration_ms   INT          NULL,
  ip            VARCHAR(45)  NULL,
  user_agent    VARCHAR(512) NULL,
  location_id   VARCHAR(128) NULL,
  error_class   VARCHAR(64)  NULL,
  request_id    CHAR(36)     NOT NULL,
  surface       VARCHAR(32)  NOT NULL DEFAULT 'api',
  actor_type    VARCHAR(32)  NULL,
  actor_id      VARCHAR(128) NULL,
  actor_username VARCHAR(128) NULL,
  action        VARCHAR(128) NULL,
  entity_type   VARCHAR(64)  NULL,
  entity_id     VARCHAR(191) NULL,
  outcome       VARCHAR(16)  NULL,
  KEY idx_sentinel_created (created_at),
  KEY idx_sentinel_key (api_key_id, created_at),
  KEY idx_sentinel_status (status_code, created_at),
  KEY idx_sentinel_path (path, created_at),
  KEY idx_sentinel_ip (ip, created_at),
  KEY idx_sentinel_surface (surface, created_at),
  KEY idx_sentinel_action (action, created_at),
  KEY idx_sentinel_actor (actor_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Short-lived, encrypted and redacted HTTP evidence. Secrets are never stored in plaintext.
CREATE TABLE IF NOT EXISTS sentinel_http_envelopes (
  request_id       CHAR(36)      NOT NULL PRIMARY KEY,
  captured_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  envelope_enc     MEDIUMTEXT    NOT NULL,
  integrity_hmac   CHAR(64)      NOT NULL,
  capture_reason   VARCHAR(64)   NOT NULL DEFAULT 'standard',
  expires_at       TIMESTAMP(3)  NOT NULL,
  KEY idx_forensic_expiry (expires_at),
  KEY idx_forensic_captured (captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Immutable reveal ledger for need-to-know review of forensic HTTP evidence.
CREATE TABLE IF NOT EXISTS sentinel_forensic_access (
  id               CHAR(36)      NOT NULL PRIMARY KEY,
  accessed_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  request_id       CHAR(36)      NOT NULL,
  event_id         BIGINT        NULL,
  admin_id         VARCHAR(64)   NULL,
  admin_username   VARCHAR(128)  NULL,
  purpose          VARCHAR(512)  NOT NULL,
  ip               VARCHAR(45)   NULL,
  user_agent       VARCHAR(512)  NULL,
  fields_viewed    VARCHAR(255)  NOT NULL,
  integrity_ok     TINYINT(1)    NOT NULL DEFAULT 0,
  outcome          VARCHAR(32)   NOT NULL,
  KEY idx_forensic_access_request (request_id, accessed_at),
  KEY idx_forensic_access_admin (admin_id, accessed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Dialer / operator login security events (never store passwords)
CREATE TABLE IF NOT EXISTS api_login_events (
  id            BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  event_type    VARCHAR(32)  NOT NULL DEFAULT 'login',
  outcome       VARCHAR(32)  NOT NULL,
  username      VARCHAR(128) NULL,
  email         VARCHAR(255) NULL,
  user_id       VARCHAR(128) NULL,
  location_id   VARCHAR(128) NULL,
  ip            VARCHAR(45)  NULL,
  user_agent    VARCHAR(512) NULL,
  api_key_id    CHAR(36)     NULL,
  key_prefix    VARCHAR(16)  NULL,
  detail        VARCHAR(255) NULL,
  request_id    CHAR(36)     NULL,
  KEY idx_login_created (created_at),
  KEY idx_login_outcome (outcome, created_at),
  KEY idx_login_user (username, created_at),
  KEY idx_login_email (email, created_at),
  KEY idx_login_ip (ip, created_at),
  KEY idx_login_location (location_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Operational tables (ported from SQLite)

CREATE TABLE IF NOT EXISTS location_data (
  locationId    VARCHAR(128) NOT NULL PRIMARY KEY,
  payload       LONGTEXT     NULL,
  updatedAt     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS leads (
  id            VARCHAR(128) NOT NULL PRIMARY KEY,
  locationId    VARCHAR(128) NULL,
  serviceType   VARCHAR(128) NULL,
  status        VARCHAR(64)  NOT NULL DEFAULT 'uncontacted',
  contactData   LONGTEXT     NULL,
  assignedTo    VARCHAR(128) NULL,
  lastContacted DATETIME     NULL,
  dncStatus     VARCHAR(16)  NOT NULL DEFAULT 'pending',
  dncCheckedAt  DATETIME     NULL,
  dncSource     VARCHAR(32)  NULL,
  dncResultCode VARCHAR(8)   NULL,
  dncReason     VARCHAR(255) NULL,
  dncDecisionCategory VARCHAR(48) NULL,
  dncReviewRequired TINYINT(1) NOT NULL DEFAULT 0,
  dncLastRescrubAt DATETIME NULL,
  phoneMarketingStatus VARCHAR(16) NOT NULL DEFAULT 'pending',
  emailMarketingStatus VARCHAR(16) NOT NULL DEFAULT 'unavailable',
  smsMarketingStatus VARCHAR(16) NOT NULL DEFAULT 'unavailable',
  marketingChannelSource VARCHAR(32) NULL,
  marketingChannelTags VARCHAR(255) NULL,
  marketingChannelsCheckedAt DATETIME NULL,
  dateAdded     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_leads_pull (locationId, serviceType, status, assignedTo),
  KEY idx_leads_dnc_pull (locationId, serviceType, status, dncStatus, assignedTo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Minimal outbound-call ledger used for rolling jurisdictional attempt limits.
CREATE TABLE IF NOT EXISTS lead_call_attempts (
  id                CHAR(36)      NOT NULL PRIMARY KEY,
  location_id       VARCHAR(128)  NOT NULL,
  lead_id           VARCHAR(128)  NOT NULL,
  user_id           VARCHAR(128)  NULL,
  external_user_id  VARCHAR(128)  NULL,
  integration_id    CHAR(36)      NULL,
  external_event_id VARCHAR(191)  NOT NULL,
  subject_key       VARCHAR(128)  NOT NULL DEFAULT 'general',
  occurred_at       DATETIME(3)   NOT NULL,
  direction         VARCHAR(16)   NOT NULL DEFAULT 'outbound',
  call_status       VARCHAR(32)   NULL,
  source            VARCHAR(16)   NOT NULL,
  synced_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_call_attempt_source (source, integration_id, external_event_id),
  KEY idx_call_attempt_limit (lead_id, direction, occurred_at),
  KEY idx_call_attempt_location (location_id, occurred_at),
  KEY idx_call_attempt_user (location_id, user_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Decision ledger contains compliance metadata only; CRM message bodies are never retained.
CREATE TABLE IF NOT EXISTS lead_compliance_checks (
  id               CHAR(36)      NOT NULL PRIMARY KEY,
  location_id      VARCHAR(128)  NOT NULL,
  lead_id          VARCHAR(128)  NOT NULL,
  user_id          VARCHAR(128)  NULL,
  state_code       CHAR(2)       NULL,
  time_zone        VARCHAR(64)   NULL,
  local_time       DATETIME      NULL,
  attempts_24h     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  decision         VARCHAR(16)   NOT NULL,
  reason           VARCHAR(64)   NOT NULL,
  next_eligible_at DATETIME(3)   NULL,
  checked_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_compliance_location (location_id, checked_at),
  KEY idx_compliance_lead (lead_id, checked_at),
  KEY idx_compliance_decision (location_id, decision, reason, checked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Server-resolved timezone cache. Only coordinates and the validated IANA zone are retained.
CREATE TABLE IF NOT EXISTS lead_timezone_cache (
  location_id VARCHAR(128) NOT NULL,
  lead_id      VARCHAR(128) NOT NULL,
  latitude     DECIMAL(9,6) NOT NULL,
  longitude    DECIMAL(10,6) NOT NULL,
  time_zone    VARCHAR(64)  NOT NULL,
  resolver     VARCHAR(32)  NOT NULL,
  resolved_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at   DATETIME(3)  NOT NULL,
  PRIMARY KEY (location_id,lead_id),
  KEY idx_lead_timezone_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- CRM ingestion control plane. Existing lead rows remain the dialer's operational queue.
CREATE TABLE IF NOT EXISTS crm_integrations (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  name                VARCHAR(128)  NOT NULL,
  provider            VARCHAR(64)   NOT NULL DEFAULT 'generic',
  location_id         VARCHAR(128)  NOT NULL,
  base_url            VARCHAR(512)  NOT NULL,
  credential_enc      TEXT          NULL,
  credential_updated_at TIMESTAMP   NULL,
  auth_scheme         VARCHAR(32)   NOT NULL DEFAULT 'Bearer',
  config_json         MEDIUMTEXT    NULL,
  is_enabled          TINYINT(1)    NOT NULL DEFAULT 1,
  last_cursor         VARCHAR(512)  NULL,
  last_sync_at        TIMESTAMP     NULL DEFAULT NULL,
  created_by          CHAR(36)      NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_crm_provider_location (provider, location_id),
  KEY idx_crm_integrations_enabled (is_enabled, location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- API keys must be explicitly granted access to a CRM integration.
CREATE TABLE IF NOT EXISTS crm_integration_grants (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  allow_read          TINYINT(1)    NOT NULL DEFAULT 1,
  allow_import        TINYINT(1)    NOT NULL DEFAULT 0,
  allow_manage_leads  TINYINT(1)    NOT NULL DEFAULT 0,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_crm_grant (integration_id, api_key_id),
  KEY idx_crm_grant_key (api_key_id),
  KEY idx_crm_grant_integration (integration_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crm_field_definitions (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  field_key           VARCHAR(191)  NOT NULL,
  field_label         VARCHAR(255)  NULL,
  data_type           VARCHAR(32)   NOT NULL DEFAULT 'string',
  first_seen_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_crm_field (integration_id, field_key),
  KEY idx_crm_field_integration (integration_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crm_field_mappings (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  field_key           VARCHAR(191)  NOT NULL,
  target_field        VARCHAR(64)   NOT NULL,
  is_enabled          TINYINT(1)    NOT NULL DEFAULT 1,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_crm_mapping (integration_id, field_key, target_field),
  KEY idx_crm_mapping_integration (integration_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crm_import_runs (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  requested_by_key_id CHAR(36)      NULL,
  status              VARCHAR(32)   NOT NULL DEFAULT 'queued',
  dry_run             TINYINT(1)    NOT NULL DEFAULT 0,
  start_cursor        VARCHAR(512)  NULL,
  current_cursor      VARCHAR(512)  NULL,
  records_fetched     INT UNSIGNED  NOT NULL DEFAULT 0,
  records_inserted    INT UNSIGNED  NOT NULL DEFAULT 0,
  records_linked      INT UNSIGNED  NOT NULL DEFAULT 0,
  records_skipped     INT UNSIGNED  NOT NULL DEFAULT 0,
  records_conflicted  INT UNSIGNED  NOT NULL DEFAULT 0,
  records_failed      INT UNSIGNED  NOT NULL DEFAULT 0,
  pages_processed     INT UNSIGNED  NOT NULL DEFAULT 0,
  expected_records    INT UNSIGNED  NULL,
  completion_reason   VARCHAR(64)   NULL,
  is_full_sync        TINYINT(1)    NOT NULL DEFAULT 0,
  error_summary       VARCHAR(1000) NULL,
  options_json        TEXT          NULL,
  started_at          TIMESTAMP     NULL DEFAULT NULL,
  completed_at        TIMESTAMP     NULL DEFAULT NULL,
  events_synced_at    TIMESTAMP     NULL DEFAULT NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_crm_runs_integration (integration_id, created_at),
  KEY idx_crm_runs_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crm_import_staging (
  id                  BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id              CHAR(36)      NOT NULL,
  integration_id      CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  external_record_id  VARCHAR(191)  NOT NULL,
  payload_hash        CHAR(64)      NOT NULL,
  payload_json        LONGTEXT      NOT NULL,
  processing_status   VARCHAR(32)   NOT NULL DEFAULT 'pending',
  lead_id             VARCHAR(128)  NULL,
  error_message       VARCHAR(1000) NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at        TIMESTAMP     NULL DEFAULT NULL,
  UNIQUE KEY uq_crm_stage_run_record (run_id, external_record_id),
  KEY idx_crm_stage_status (run_id, processing_status),
  KEY idx_crm_stage_external (integration_id, external_record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_source_links (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  lead_id             VARCHAR(128)  NOT NULL,
  integration_id      CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  external_record_id  VARCHAR(191)  NOT NULL,
  external_updated_at DATETIME      NULL,
  first_seen_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lead_source_record (integration_id, external_record_id),
  KEY idx_lead_source_lead (lead_id),
  KEY idx_lead_source_location (location_id, external_record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_import_values (
  id                  BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lead_id             VARCHAR(128)  NOT NULL,
  integration_id      CHAR(36)      NOT NULL,
  field_key           VARCHAR(191)  NOT NULL,
  data_type           VARCHAR(32)   NOT NULL DEFAULT 'string',
  value_text          TEXT          NULL,
  value_number        DECIMAL(30,8) NULL,
  value_datetime      DATETIME      NULL,
  value_boolean       TINYINT(1)    NULL,
  value_json          LONGTEXT      NULL,
  value_hash          CHAR(64)      NOT NULL,
  first_seen_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_run_id    CHAR(36)      NULL,
  is_current          TINYINT(1)    NOT NULL DEFAULT 1,
  UNIQUE KEY uq_lead_import_value (lead_id, integration_id, field_key),
  KEY idx_lead_value_field (integration_id, field_key),
  KEY idx_lead_value_hash (integration_id, field_key, value_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Complete current CRM contact payloads. Operational leads remain separate and are never replaced.
CREATE TABLE IF NOT EXISTS crm_contact_records (
  integration_id      CHAR(36)      NOT NULL,
  external_record_id  VARCHAR(191)  NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  lead_id             VARCHAR(128)  NULL,
  payload_hash        CHAR(64)      NOT NULL,
  payload_json        LONGTEXT      NOT NULL,
  external_updated_at DATETIME      NULL,
  first_seen_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_run_id    CHAR(36)      NULL,
  is_current          TINYINT(1)    NOT NULL DEFAULT 1,
  PRIMARY KEY (integration_id, external_record_id),
  KEY idx_crm_contact_location (location_id, is_current, last_seen_at),
  KEY idx_crm_contact_lead (lead_id),
  KEY idx_crm_contact_run (last_seen_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Provider-defined custom field catalog for contact, opportunity, and custom object models.
CREATE TABLE IF NOT EXISTS crm_object_definitions (
  integration_id          CHAR(36)      NOT NULL,
  object_id               VARCHAR(191)  NOT NULL,
  location_id             VARCHAR(128)  NOT NULL,
  object_key              VARCHAR(191)  NOT NULL,
  singular_label          VARCHAR(255)  NULL,
  plural_label            VARCHAR(255)  NULL,
  is_standard             TINYINT(1)    NOT NULL DEFAULT 0,
  primary_display_property VARCHAR(191) NULL,
  metadata_json           LONGTEXT      NOT NULL,
  first_seen_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_current              TINYINT(1)    NOT NULL DEFAULT 1,
  PRIMARY KEY (integration_id, object_id),
  KEY idx_crm_objects_location (integration_id, location_id, is_current),
  KEY idx_crm_object_key (integration_id, object_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crm_object_field_definitions (
  integration_id      CHAR(36)      NOT NULL,
  field_id            VARCHAR(191)  NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  object_model        VARCHAR(64)   NOT NULL DEFAULT 'contact',
  field_key           VARCHAR(191)  NULL,
  field_name          VARCHAR(255)  NULL,
  data_type           VARCHAR(64)   NULL,
  metadata_json       LONGTEXT      NOT NULL,
  first_seen_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_current          TINYINT(1)    NOT NULL DEFAULT 1,
  PRIMARY KEY (integration_id, field_id),
  KEY idx_crm_object_fields (integration_id, object_model, is_current),
  KEY idx_crm_field_key (integration_id, field_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_import_conflicts (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  run_id              CHAR(36)      NULL,
  integration_id      CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  external_record_id  VARCHAR(191)  NOT NULL,
  candidate_lead_id   VARCHAR(128)  NULL,
  conflict_type       VARCHAR(64)   NOT NULL,
  detail_json         TEXT          NULL,
  status              VARCHAR(32)   NOT NULL DEFAULT 'open',
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at         TIMESTAMP     NULL DEFAULT NULL,
  KEY idx_lead_conflicts_status (integration_id, status, created_at),
  KEY idx_lead_conflicts_external (integration_id, external_record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS appointments (
  id              INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  locationId      VARCHAR(128) NULL,
  leadId          VARCHAR(128) NULL,
  userId          VARCHAR(128) NULL,
  calendarId      VARCHAR(191) NULL,
  externalEventId VARCHAR(191) NULL,
  externalContactId VARCHAR(191) NULL,
  source          VARCHAR(32)  NOT NULL DEFAULT 'workbench',
  appointmentDate DATETIME     NULL,
  status          VARCHAR(64)  NOT NULL DEFAULT 'scheduled',
  syncedAt        DATETIME     NULL,
  createdAt       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_appointments_user (locationId, userId),
  KEY idx_appointments_lead_status (locationId, leadId, status, appointmentDate),
  UNIQUE KEY uq_appointments_external_event (locationId, externalEventId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_calendar_sync_state (
  location_id       VARCHAR(128) NOT NULL,
  lead_id           VARCHAR(128) NOT NULL,
  integration_id    CHAR(36)     NULL,
  result             VARCHAR(24)  NOT NULL DEFAULT 'unknown',
  external_event_id VARCHAR(191) NULL,
  last_checked_at   TIMESTAMP(3) NULL DEFAULT NULL,
  retry_after_at    TIMESTAMP(3) NULL DEFAULT NULL,
  last_error_code   VARCHAR(64)  NULL,
  updated_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (location_id, lead_id),
  KEY idx_calendar_sync_retry (retry_after_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_call_restriction_overrides (
  id                 CHAR(36)      NOT NULL PRIMARY KEY,
  location_id        VARCHAR(128)  NOT NULL,
  lead_id            VARCHAR(128)  NOT NULL,
  restriction_code   VARCHAR(64)   NOT NULL,
  reason             VARCHAR(255)  NOT NULL,
  remaining_uses     SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  expires_at         TIMESTAMP(3)  NOT NULL,
  created_by_admin_id VARCHAR(64)  NULL,
  created_by_username VARCHAR(128) NULL,
  consumed_at        TIMESTAMP(3)  NULL DEFAULT NULL,
  revoked_at         TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at         TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_call_override_active (location_id, lead_id, restriction_code, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rewards (
  id            INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  locationId    VARCHAR(128) NULL,
  userId        VARCHAR(128) NULL,
  leadId        VARCHAR(128) NULL,
  amount        DOUBLE       NULL,
  type          VARCHAR(64)  NULL,
  createdAt     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rewards_user (locationId, userId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(128) NOT NULL PRIMARY KEY,
  locationId    VARCHAR(128) NULL,
  username      VARCHAR(128) NULL,
  passwordHash  VARCHAR(255) NULL,
  role          VARCHAR(64)  NULL,
  crmUserId     VARCHAR(128) NULL,
  crmUserName   VARCHAR(255) NULL,
  email         VARCHAR(255) NULL,
  phone         VARCHAR(64)  NULL,
  createdAt     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_users_location (locationId),
  KEY idx_users_location_username (locationId, username),
  KEY idx_users_location_email (locationId, email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OWL authority for which CRM users may receive each HAWK service-pool assignment.
CREATE TABLE IF NOT EXISTS owl_user_pool_permissions (
  location_id       VARCHAR(128) NOT NULL,
  user_id           VARCHAR(128) NOT NULL,
  service_pool      VARCHAR(64)  NOT NULL,
  is_enabled        TINYINT(1)   NOT NULL DEFAULT 1,
  assignment_count  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_assigned_at  DATETIME(3)  NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (location_id,user_id,service_pool),
  KEY idx_owl_pool_round_robin (location_id,service_pool,is_enabled,last_assigned_at,assignment_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Location-scoped assignment policy. Schedule enforcement is deliberately opt-in.
CREATE TABLE IF NOT EXISTS owl_assignment_policies (
  location_id                VARCHAR(128) NOT NULL PRIMARY KEY,
  require_submitted_schedule TINYINT(1)   NOT NULL DEFAULT 0,
  language_field_id          VARCHAR(191) NULL,
  language_field_key         VARCHAR(191) NULL,
  default_language_code      VARCHAR(35)  NOT NULL DEFAULT 'en',
  language_rules_json        TEXT         NOT NULL,
  created_at                 DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                 DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS owl_user_language_permissions (
  location_id   VARCHAR(128) NOT NULL,
  user_id       VARCHAR(128) NOT NULL,
  language_code VARCHAR(35)  NOT NULL,
  is_enabled    TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (location_id,user_id,language_code),
  KEY idx_owl_language_assignment (location_id,language_code,is_enabled,user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Immutable assignment evidence for HAWK execution history and Sentinel review.
CREATE TABLE IF NOT EXISTS hawk_dialer_assignment_events (
  id                 CHAR(36)     NOT NULL PRIMARY KEY,
  api_key_id         CHAR(36)     NULL,
  location_id        VARCHAR(128) NOT NULL,
  contact_id         VARCHAR(191) NOT NULL,
  service_pool       VARCHAR(64)  NOT NULL,
  user_id            VARCHAR(128) NULL,
  crm_user_id        VARCHAR(128) NOT NULL,
  assignment_source  VARCHAR(32)  NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_hawk_assignment_contact (location_id,contact_id,created_at),
  KEY idx_hawk_assignment_user (location_id,crm_user_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_schedules (
  userId        VARCHAR(128) NOT NULL PRIMARY KEY,
  locationId    VARCHAR(128) NULL,
  scheduleData  LONGTEXT     NULL,
  updatedAt     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_schedules_location (locationId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Short-lived Dialer operator sessions. Raw tokens are returned once and never stored.
CREATE TABLE IF NOT EXISTS api_operator_sessions (
  token_hash   CHAR(64)      NOT NULL PRIMARY KEY,
  api_key_id   CHAR(36)      NULL,
  user_id      VARCHAR(128)  NOT NULL,
  location_id  VARCHAR(128)  NOT NULL,
  is_admin     TINYINT(1)    NOT NULL DEFAULT 0,
  expires_at   DATETIME(3)   NOT NULL,
  created_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at   DATETIME(3)   NULL,
  KEY idx_operator_session_user (location_id,user_id,expires_at),
  KEY idx_operator_session_expiry (expires_at,revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Weekly dialer schedule ledger. A saved draft is intentionally distinct from submission.
CREATE TABLE IF NOT EXISTS user_schedule_weeks (
  locationId       VARCHAR(128) NOT NULL,
  userId           VARCHAR(128) NOT NULL,
  weekStart        DATE         NOT NULL,
  weekEnd          DATE         NOT NULL,
  scheduleData     LONGTEXT     NULL,
  scheduledMinutes INT UNSIGNED NOT NULL DEFAULT 0,
  submittedAt      DATETIME(3)  NULL,
  createdAt        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (locationId, userId, weekStart),
  KEY idx_schedule_weeks_status (locationId, weekStart, submittedAt),
  KEY idx_schedule_weeks_user (userId, weekStart)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only work sessions provide actual time for OWL schedule reporting.
CREATE TABLE IF NOT EXISTS dialer_work_sessions (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  locationId      VARCHAR(128) NOT NULL,
  userId          VARCHAR(128) NOT NULL,
  weekStart       DATE         NOT NULL,
  startedAt       DATETIME(3)  NOT NULL,
  endedAt         DATETIME(3)  NULL,
  durationSeconds INT UNSIGNED NULL,
  status          VARCHAR(16)  NOT NULL DEFAULT 'active',
  source          VARCHAR(32)  NOT NULL DEFAULT 'dialer',
  createdAt       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_work_sessions_report (locationId, weekStart, userId),
  KEY idx_work_sessions_active (locationId, userId, endedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_errors (
  id            VARCHAR(128) NOT NULL PRIMARY KEY,
  locationId    VARCHAR(128) NULL,
  userId        VARCHAR(128) NULL,
  username      VARCHAR(128) NULL,
  type          VARCHAR(128) NULL,
  message       TEXT         NULL,
  details       LONGTEXT     NULL,
  url           TEXT         NULL,
  timestamp     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_errors_location (locationId, timestamp),
  KEY idx_errors_user (locationId, userId, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_logs (
  id            VARCHAR(128) NOT NULL PRIMARY KEY,
  locationId    VARCHAR(128) NULL,
  userId        VARCHAR(128) NULL,
  username      VARCHAR(128) NULL,
  email         VARCHAR(255) NULL,
  status        VARCHAR(64)  NULL,
  userAgent     TEXT         NULL,
  timestamp     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_auth_logs_location (locationId, timestamp),
  KEY idx_auth_logs_user (locationId, userId, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OWL super-admin domain operations audit (no raw SQL or secrets)
CREATE TABLE IF NOT EXISTS owl_audit_events (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  admin_id        CHAR(36)      NULL,
  admin_username  VARCHAR(128)  NULL,
  api_key_id      CHAR(36)      NOT NULL,
  source_slug     VARCHAR(64)   NOT NULL DEFAULT 'core',
  location_id     VARCHAR(128)  NULL,
  action          VARCHAR(64)   NOT NULL,
  entity_type     VARCHAR(64)   NOT NULL,
  entity_id       VARCHAR(128)  NULL,
  before_json     MEDIUMTEXT    NULL,
  after_json      MEDIUMTEXT    NULL,
  detail          VARCHAR(512)  NULL,
  created_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_owl_audit_created (created_at),
  KEY idx_owl_audit_key (api_key_id, created_at),
  KEY idx_owl_audit_source (source_slug, location_id, created_at),
  KEY idx_owl_audit_entity (entity_type, entity_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OWL lead routing definitions. Rules are scoped to a database source and location.
CREATE TABLE IF NOT EXISTS owl_lead_pool_rules (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  source_slug           VARCHAR(64)   NOT NULL DEFAULT 'core',
  location_id           VARCHAR(128)  NOT NULL,
  pool_key              VARCHAR(64)   NOT NULL,
  label                 VARCHAR(128)  NOT NULL,
  status_values_json    TEXT          NOT NULL,
  destination_status    VARCHAR(64)   NOT NULL,
  assignment_policy     VARCHAR(32)   NOT NULL DEFAULT 'clear',
  is_assignable         TINYINT(1)    NOT NULL DEFAULT 0,
  is_terminal           TINYINT(1)    NOT NULL DEFAULT 0,
  color                 CHAR(7)       NOT NULL DEFAULT '#64748b',
  sort_order            INT           NOT NULL DEFAULT 100,
  is_enabled            TINYINT(1)    NOT NULL DEFAULT 1,
  created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_owl_pool_context (source_slug, location_id, pool_key),
  KEY idx_owl_pool_location (source_slug, location_id, is_enabled, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Dialer service pools: maps CRM tag keywords to the leads.serviceType contract.
CREATE TABLE IF NOT EXISTS owl_service_pools (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  source_slug         VARCHAR(64)   NOT NULL DEFAULT 'core',
  location_id         VARCHAR(128)  NOT NULL,
  service_type        VARCHAR(128)  NOT NULL,
  tag_keywords_json   TEXT          NOT NULL,
  calendar_ids_json   TEXT          NOT NULL,
  default_calendar_id VARCHAR(191)  NULL,
  fallback_user_id    VARCHAR(128)  NULL,
  is_fallback         TINYINT(1)    NOT NULL DEFAULT 0,
  color               CHAR(7)       NOT NULL DEFAULT '#64748b',
  sort_order          INT           NOT NULL DEFAULT 100,
  is_enabled          TINYINT(1)    NOT NULL DEFAULT 1,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_owl_service_context (source_slug, location_id, service_type),
  KEY idx_owl_service_location (source_slug, location_id, is_enabled, sort_order),
  KEY idx_owl_service_fallback_user (location_id, fallback_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- SONG script definitions. Drafts are mutable with optimistic revision control.
CREATE TABLE IF NOT EXISTS song_scripts (
  id                   CHAR(36)      NOT NULL PRIMARY KEY,
  api_key_id           CHAR(36)      NOT NULL,
  location_id          VARCHAR(128)  NOT NULL,
  service_type         VARCHAR(128)  NOT NULL,
  language_code        VARCHAR(35)   NOT NULL DEFAULT 'en-US',
  name                 VARCHAR(191)  NOT NULL,
  description          VARCHAR(1000) NULL,
  status               ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  draft_revision       INT UNSIGNED  NOT NULL DEFAULT 1,
  draft_graph_json     MEDIUMTEXT    NOT NULL,
  published_version_id CHAR(36)      NULL,
  created_by           CHAR(36)      NULL,
  updated_by           CHAR(36)      NULL,
  created_at           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_song_script_scope (api_key_id,location_id,status,updated_at),
  KEY idx_song_script_service (api_key_id,location_id,service_type,status),
  KEY idx_song_script_language (api_key_id,location_id,service_type,language_code,status),
  KEY idx_song_script_published (published_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Published SONG versions are immutable snapshots consumed by Dialer runtime.
CREATE TABLE IF NOT EXISTS song_script_versions (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  script_id       CHAR(36)      NOT NULL,
  version_number  INT UNSIGNED  NOT NULL,
  graph_json      MEDIUMTEXT    NOT NULL,
  compiled_json   MEDIUMTEXT    NOT NULL,
  checksum        CHAR(64)      NOT NULL,
  validation_json TEXT          NOT NULL,
  published_by    CHAR(36)      NULL,
  published_at    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_song_script_version (script_id,version_number),
  KEY idx_song_version_checksum (checksum)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One active published script version per tenant/location/service pool.
CREATE TABLE IF NOT EXISTS song_service_assignments (
  api_key_id  CHAR(36)      NOT NULL,
  location_id VARCHAR(128)  NOT NULL,
  service_type VARCHAR(128) NOT NULL,
  script_id   CHAR(36)      NOT NULL,
  version_id  CHAR(36)      NOT NULL,
  updated_by  CHAR(36)      NULL,
  updated_at  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (api_key_id,location_id,service_type),
  KEY idx_song_assignment_script (script_id,version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One active published script version per tenant/location/service/language.
CREATE TABLE IF NOT EXISTS song_service_language_assignments (
  api_key_id   CHAR(36)      NOT NULL,
  location_id  VARCHAR(128)  NOT NULL,
  service_type VARCHAR(128)  NOT NULL,
  language_code VARCHAR(35)  NOT NULL,
  script_id    CHAR(36)      NOT NULL,
  version_id   CHAR(36)      NOT NULL,
  updated_by   CHAR(36)      NULL,
  updated_at   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (api_key_id,location_id,service_type,language_code),
  KEY idx_song_language_assignment_script (script_id,version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only runtime analytics. Metadata is size-limited and secret-filtered by the API.
CREATE TABLE IF NOT EXISTS song_runtime_events (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  api_key_id       CHAR(36)      NOT NULL,
  location_id      VARCHAR(128)  NOT NULL,
  script_id        CHAR(36)      NOT NULL,
  version_id       CHAR(36)      NOT NULL,
  operator_user_id VARCHAR(128)  NOT NULL,
  lead_id          VARCHAR(128)  NULL,
  node_id          VARCHAR(64)   NULL,
  branch_id        VARCHAR(64)   NULL,
  event_type       VARCHAR(32)   NOT NULL,
  outcome          VARCHAR(64)   NULL,
  metadata_json    TEXT          NULL,
  occurred_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_song_event_scope (api_key_id,location_id,occurred_at),
  KEY idx_song_event_script (script_id,version_id,occurred_at),
  KEY idx_song_event_node (script_id,node_id,event_type,occurred_at),
  KEY idx_song_event_operator (operator_user_id,occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- HAWK: independently versioned automations and append-only execution evidence.
CREATE TABLE IF NOT EXISTS hawk_flow_folders (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  api_key_id            CHAR(36)      NOT NULL,
  location_id           VARCHAR(128)  NOT NULL,
  data_source_slug      VARCHAR(63)   NOT NULL DEFAULT 'core',
  name                  VARCHAR(191)  NOT NULL,
  description           VARCHAR(500)  NULL,
  color                 CHAR(7)       NOT NULL DEFAULT '#2f85de',
  sort_order            INT UNSIGNED  NOT NULL DEFAULT 0,
  created_by            CHAR(36)      NULL,
  updated_by            CHAR(36)      NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_hawk_folder_source_name (api_key_id,location_id,data_source_slug,name),
  KEY idx_hawk_folder_scope (api_key_id,location_id,data_source_slug,sort_order,name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hawk_flows (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  api_key_id            CHAR(36)      NOT NULL,
  location_id           VARCHAR(128)  NOT NULL,
  data_source_slug      VARCHAR(63)   NOT NULL DEFAULT 'core',
  integration_id        CHAR(36)      NULL,
  name                  VARCHAR(191)  NOT NULL,
  description           VARCHAR(1000) NULL,
  folder_id             CHAR(36)      NULL,
  color                 CHAR(7)       NULL,
  sort_order            INT UNSIGNED  NOT NULL DEFAULT 0,
  status                VARCHAR(16)   NOT NULL DEFAULT 'draft',
  draft_revision        INT UNSIGNED  NOT NULL DEFAULT 1,
  draft_graph_json      MEDIUMTEXT    NOT NULL,
  published_version_id  CHAR(36)      NULL,
  created_by            CHAR(36)      NULL,
  updated_by            CHAR(36)      NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_hawk_flow_scope (api_key_id,location_id,status,updated_at),
  KEY idx_hawk_flow_data_source (api_key_id,location_id,data_source_slug,status,updated_at),
  KEY idx_hawk_flow_folder (api_key_id,location_id,folder_id,sort_order),
  KEY idx_hawk_flow_integration (integration_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hawk_flow_versions (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  flow_id               CHAR(36)      NOT NULL,
  version_number        INT UNSIGNED  NOT NULL,
  graph_json            MEDIUMTEXT    NOT NULL,
  checksum              CHAR(64)      NOT NULL,
  published_by          CHAR(36)      NULL,
  published_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_hawk_flow_version (flow_id,version_number),
  KEY idx_hawk_version_checksum (checksum)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hawk_executions (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  flow_id               CHAR(36)      NOT NULL,
  version_id            CHAR(36)      NULL,
  api_key_id            CHAR(36)      NOT NULL,
  location_id           VARCHAR(128)  NOT NULL,
  data_source_slug      VARCHAR(63)   NOT NULL DEFAULT 'core',
  trigger_type          VARCHAR(64)   NOT NULL,
  status                VARCHAR(24)   NOT NULL DEFAULT 'queued',
  mode                  VARCHAR(16)   NOT NULL DEFAULT 'dry_run',
  idempotency_key       VARCHAR(191)  NULL,
  replay_of_execution_id CHAR(36)     NULL,
  request_id            VARCHAR(64)   NULL,
  input_json            MEDIUMTEXT    NULL,
  output_json           MEDIUMTEXT    NULL,
  error_code            VARCHAR(64)   NULL,
  error_message         VARCHAR(1000) NULL,
  steps_total           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  steps_completed       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  initiated_by_type     VARCHAR(32)   NOT NULL DEFAULT 'admin',
  initiated_by_id       VARCHAR(128)  NULL,
  started_at            TIMESTAMP(3)  NULL,
  completed_at          TIMESTAMP(3)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_hawk_idempotency (flow_id,idempotency_key),
  KEY idx_hawk_execution_scope (api_key_id,location_id,created_at),
  KEY idx_hawk_execution_data_source (api_key_id,location_id,data_source_slug,created_at),
  KEY idx_hawk_execution_flow (flow_id,status,created_at),
  KEY idx_hawk_execution_replay (replay_of_execution_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hawk_execution_steps (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  execution_id          CHAR(36)      NOT NULL,
  node_id               VARCHAR(64)   NOT NULL,
  node_type             VARCHAR(24)   NOT NULL,
  action_type           VARCHAR(64)   NULL,
  attempt_number        SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  status                VARCHAR(24)   NOT NULL DEFAULT 'running',
  input_json            MEDIUMTEXT    NULL,
  output_json           MEDIUMTEXT    NULL,
  error_code            VARCHAR(64)   NULL,
  error_message         VARCHAR(1000) NULL,
  duration_ms           INT UNSIGNED  NULL,
  started_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at          TIMESTAMP(3)  NULL,
  UNIQUE KEY uq_hawk_execution_node_attempt (execution_id,node_id,attempt_number),
  KEY idx_hawk_step_execution (execution_id,started_at),
  KEY idx_hawk_step_status (status,started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Public, flow-scoped webhook adapters. Secrets are encrypted at rest and are
-- returned only when an endpoint is first provisioned or rotated.
CREATE TABLE IF NOT EXISTS hawk_webhook_endpoints (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  flow_id               CHAR(36)      NOT NULL,
  public_id             VARCHAR(64)   NOT NULL,
  secret_enc            TEXT          NOT NULL,
  secret_hint           VARCHAR(12)   NOT NULL,
  is_enabled            TINYINT(1)    NOT NULL DEFAULT 1,
  created_by            CHAR(36)      NULL,
  rotated_by            CHAR(36)      NULL,
  last_received_at      TIMESTAMP(3)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_hawk_webhook_flow (flow_id),
  UNIQUE KEY uq_hawk_webhook_public (public_id),
  KEY idx_hawk_webhook_enabled (is_enabled,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Payload bodies are not duplicated here. Redacted trigger data and full step
-- evidence remain in hawk_executions; this table tracks delivery/auth status.
CREATE TABLE IF NOT EXISTS hawk_webhook_deliveries (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  endpoint_id           CHAR(36)      NOT NULL,
  flow_id               CHAR(36)      NOT NULL,
  request_id            VARCHAR(64)   NULL,
  event_key             VARCHAR(191)  NOT NULL,
  payload_sha256        CHAR(64)      NOT NULL,
  auth_mode             VARCHAR(16)   NOT NULL,
  status                VARCHAR(24)   NOT NULL DEFAULT 'accepted',
  execution_id          CHAR(36)      NULL,
  error_code            VARCHAR(64)   NULL,
  received_at           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at          TIMESTAMP(3)  NULL,
  UNIQUE KEY uq_hawk_webhook_event (endpoint_id,event_key),
  KEY idx_hawk_webhook_delivery_flow (flow_id,received_at),
  KEY idx_hawk_webhook_delivery_status (status,received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- PARROT registered Python bridge runs. Business payloads are redacted and
-- bounded before storage; Sentinel separately records the security lifecycle.
CREATE TABLE IF NOT EXISTS parrot_scripts (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  api_key_id            CHAR(36)      NOT NULL,
  data_source_slug      VARCHAR(63)   NOT NULL DEFAULT 'core',
  slug                  VARCHAR(96)   NOT NULL,
  name                  VARCHAR(191)  NOT NULL,
  description           VARCHAR(1000) NULL,
  status                VARCHAR(24)   NOT NULL DEFAULT 'draft',
  latest_version_id     CHAR(36)      NULL,
  deployed_version_id   CHAR(36)      NULL,
  created_by            VARCHAR(64)   NULL,
  updated_by            VARCHAR(64)   NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_parrot_script_slug (api_key_id,data_source_slug,slug),
  KEY idx_parrot_script_scope (api_key_id,data_source_slug,status,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parrot_script_versions (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  script_id             CHAR(36)      NOT NULL,
  version_number        INT UNSIGNED  NOT NULL,
  status                VARCHAR(24)   NOT NULL DEFAULT 'draft',
  source_code           MEDIUMTEXT    NOT NULL,
  source_sha256         CHAR(64)      NOT NULL,
  manifest_sha256       CHAR(64)      NOT NULL,
  capabilities_json     TEXT          NULL,
  input_schema_json     TEXT          NULL,
  validation_json       MEDIUMTEXT    NULL,
  change_note           VARCHAR(1000) NULL,
  created_by            VARCHAR(64)   NULL,
  approved_by           VARCHAR(64)   NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  approved_at           TIMESTAMP(3)  NULL,
  last_dry_run_at       TIMESTAMP(3)  NULL,
  UNIQUE KEY uq_parrot_script_version (script_id,version_number),
  UNIQUE KEY uq_parrot_script_manifest (script_id,manifest_sha256),
  KEY idx_parrot_script_source_hash (script_id,source_sha256),
  KEY idx_parrot_version_status (script_id,status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parrot_runs (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  request_id            VARCHAR(64)   NOT NULL,
  api_key_id             CHAR(36)      NOT NULL,
  location_id            VARCHAR(128)  NOT NULL,
  data_source_slug       VARCHAR(63)   NOT NULL DEFAULT 'core',
  source                 VARCHAR(16)   NOT NULL,
  script_id              VARCHAR(96)   NOT NULL,
  script_version         VARCHAR(32)   NULL,
  mode                   VARCHAR(16)   NOT NULL DEFAULT 'dry_run',
  status                 VARCHAR(24)   NOT NULL DEFAULT 'running',
  idempotency_key        VARCHAR(191)  NULL,
  input_json             MEDIUMTEXT    NULL,
  output_json            MEDIUMTEXT    NULL,
  error_code             VARCHAR(64)   NULL,
  error_message          VARCHAR(1000) NULL,
  duration_ms            INT UNSIGNED  NULL,
  initiated_by_type      VARCHAR(32)   NULL,
  initiated_by_id        VARCHAR(128)  NULL,
  started_at             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at           TIMESTAMP(3)  NULL,
  created_at             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_parrot_idempotency (api_key_id,location_id,source,script_id,idempotency_key),
  KEY idx_parrot_scope (api_key_id,location_id,created_at),
  KEY idx_parrot_script (script_id,status,created_at),
  KEY idx_parrot_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audits DNC screening activity. Vendor tokens and CRM credentials are never stored here.
CREATE TABLE IF NOT EXISTS dnc_pulse_events (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  api_key_id          CHAR(36)      NOT NULL,
  lead_id             VARCHAR(128)  NOT NULL,
  external_contact_id VARCHAR(191)  NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  action              VARCHAR(32)   NOT NULL DEFAULT 'url_issued',
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_dnc_pulse_location (location_id, created_at),
  KEY idx_dnc_pulse_lead (lead_id, created_at),
  KEY idx_dnc_pulse_key (api_key_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- EAGLE executive reporting snapshots. CRM facts are immutable per snapshot; dialer fields are overlays.
CREATE TABLE IF NOT EXISTS eagle_snapshots (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  status              VARCHAR(24)   NOT NULL DEFAULT 'queued',
  total_contacts      INT UNSIGNED  NOT NULL DEFAULT 0,
  pages_processed     INT UNSIGNED  NOT NULL DEFAULT 0,
  error_summary       VARCHAR(1000) NULL,
  requested_by        CHAR(36)      NULL,
  started_at          TIMESTAMP     NULL DEFAULT NULL,
  completed_at        TIMESTAMP     NULL DEFAULT NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_eagle_snapshot_context (integration_id, location_id, status, created_at),
  KEY idx_eagle_snapshot_key (api_key_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS eagle_lead_facts (
  id                  BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  snapshot_id         CHAR(36)      NOT NULL,
  integration_id      CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  external_contact_id VARCHAR(191)  NOT NULL,
  lead_id             VARCHAR(128)  NULL,
  full_name           VARCHAR(255)  NULL,
  email               VARCHAR(255)  NULL,
  phone               VARCHAR(64)   NULL,
  city                VARCHAR(128)  NULL,
  state_code          CHAR(2)       NULL,
  postal_code         VARCHAR(24)   NULL,
  country             VARCHAR(64)   NULL,
  marketing_source    VARCHAR(191)  NULL,
  campaign            VARCHAR(191)  NULL,
  medium              VARCHAR(128)  NULL,
  service_type        VARCHAR(128)  NULL,
  crm_disposition     VARCHAR(64)   NOT NULL DEFAULT 'New / Unworked',
  crm_assigned_to     VARCHAR(191)  NULL,
  dial_status         VARCHAR(64)   NULL,
  dial_assigned_to    VARCHAR(128)  NULL,
  dnc_status          VARCHAR(16)   NULL,
  tags_json           TEXT          NULL,
  crm_date_added      DATETIME      NULL,
  crm_updated_at      DATETIME      NULL,
  demographics_json   TEXT          NULL,
  captured_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_eagle_snapshot_contact (snapshot_id, external_contact_id),
  KEY idx_eagle_geo (snapshot_id, state_code, city),
  KEY idx_eagle_marketing (snapshot_id, marketing_source, campaign),
  KEY idx_eagle_funnel (snapshot_id, crm_disposition, service_type),
  KEY idx_eagle_date (snapshot_id, crm_date_added),
  KEY idx_eagle_lead (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Versioned business definitions used by EAGLE semantic metric responses.
CREATE TABLE IF NOT EXISTS eagle_metric_definitions (
  metric_id          VARCHAR(64)   NOT NULL PRIMARY KEY,
  definition_version VARCHAR(16)   NOT NULL,
  label              VARCHAR(128)  NOT NULL,
  description        VARCHAR(1000) NOT NULL,
  unit               VARCHAR(24)   NOT NULL,
  numerator_label    VARCHAR(255)  NULL,
  denominator_label  VARCHAR(255)  NULL,
  time_basis         VARCHAR(64)   NOT NULL,
  business_owner     VARCHAR(128)  NOT NULL DEFAULT 'Revenue Operations',
  is_active          TINYINT(1)    NOT NULL DEFAULT 1,
  updated_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Integration-scoped aliases for governed source and campaign dimensions.
CREATE TABLE IF NOT EXISTS eagle_attribution_mappings (
  id                 BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  integration_id     CHAR(36)      NOT NULL,
  dimension_type     VARCHAR(16)   NOT NULL,
  raw_value          VARCHAR(255)  NOT NULL,
  canonical_value    VARCHAR(255)  NULL,
  channel            VARCHAR(64)   NULL,
  mapping_status     VARCHAR(16)   NOT NULL DEFAULT 'active',
  unknown_reason     VARCHAR(32)   NULL,
  created_by         CHAR(36)      NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_eagle_attribution_mapping (integration_id, dimension_type, raw_value),
  KEY idx_eagle_attribution_canonical (integration_id, dimension_type, canonical_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Authoritative, deduplicated lifecycle events used by EAGLE historical cohorts.
CREATE TABLE IF NOT EXISTS eagle_lead_events (
  id                  BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  external_contact_id VARCHAR(191)  NOT NULL,
  lead_id             VARCHAR(128)  NULL,
  event_type          VARCHAR(40)   NOT NULL,
  event_at            DATETIME      NOT NULL,
  source_type         VARCHAR(32)   NOT NULL,
  source_event_id     VARCHAR(191)  NOT NULL,
  event_status        VARCHAR(32)   NULL,
  metadata_json       TEXT          NULL,
  first_seen_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_eagle_lead_event (integration_id, source_type, source_event_id, event_type),
  KEY idx_eagle_event_contact (integration_id, external_contact_id, event_type, event_at),
  KEY idx_eagle_event_time (integration_id, event_type, event_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Manifests make opportunity completeness explicit before win metrics become available.
CREATE TABLE IF NOT EXISTS eagle_outcome_imports (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  snapshot_id         CHAR(36)      NOT NULL,
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  source_system       VARCHAR(64)   NOT NULL,
  is_complete         TINYINT(1)    NOT NULL DEFAULT 0,
  records_received    INT UNSIGNED  NOT NULL DEFAULT 0,
  records_with_won_at INT UNSIGNED  NOT NULL DEFAULT 0,
  error_summary       VARCHAR(1000) NULL,
  imported_by         CHAR(36)      NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_eagle_outcome_import_snapshot (snapshot_id, is_complete, created_at),
  KEY idx_eagle_outcome_import_context (integration_id, api_key_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Opportunity state at an EAGLE snapshot. Won/lost dates must come from the upstream source.
CREATE TABLE IF NOT EXISTS eagle_opportunity_snapshots (
  snapshot_id         CHAR(36)      NOT NULL,
  import_id           CHAR(36)      NOT NULL,
  integration_id      CHAR(36)      NOT NULL,
  opportunity_id      VARCHAR(191)  NOT NULL,
  external_contact_id VARCHAR(191)  NOT NULL,
  pipeline_id         VARCHAR(191)  NULL,
  stage_id            VARCHAR(191)  NULL,
  stage_name          VARCHAR(255)  NULL,
  opportunity_status  VARCHAR(24)   NOT NULL,
  monetary_value      DECIMAL(18,2) NULL,
  opened_at           DATETIME      NULL,
  won_at              DATETIME      NULL,
  lost_at             DATETIME      NULL,
  upstream_updated_at DATETIME      NULL,
  metadata_json       TEXT          NULL,
  captured_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (snapshot_id, opportunity_id),
  KEY idx_eagle_opportunity_contact (snapshot_id, external_contact_id, opportunity_status),
  KEY idx_eagle_opportunity_won (integration_id, won_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Frozen executive KPI reconciliations against an independently supplied reference report.
CREATE TABLE IF NOT EXISTS eagle_validation_runs (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  snapshot_id         CHAR(36)      NOT NULL,
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  reference_system    VARCHAR(128)  NOT NULL,
  scope_json          TEXT          NOT NULL,
  status              VARCHAR(24)   NOT NULL,
  checks_total        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  checks_passed       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  checks_failed       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  checks_unavailable  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_by          CHAR(36)      NULL,
  completed_at        TIMESTAMP     NULL DEFAULT NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_eagle_validation_context (integration_id, status, created_at),
  KEY idx_eagle_validation_snapshot (snapshot_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS eagle_validation_checks (
  id                  BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id              CHAR(36)      NOT NULL,
  metric_id           VARCHAR(64)   NOT NULL,
  metric_label        VARCHAR(128)  NOT NULL,
  metric_unit         VARCHAR(24)   NOT NULL,
  eagle_value         DECIMAL(24,6) NULL,
  reference_value     DECIMAL(24,6) NOT NULL,
  absolute_difference DECIMAL(24,6) NULL,
  percent_difference  DECIMAL(18,6) NULL,
  tolerance_value     DECIMAL(18,6) NOT NULL,
  tolerance_type      VARCHAR(32)   NOT NULL,
  outcome             VARCHAR(24)   NOT NULL,
  evidence_reference  VARCHAR(512)  NOT NULL,
  note                VARCHAR(1000) NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_eagle_validation_metric (run_id, metric_id),
  KEY idx_eagle_validation_outcome (outcome, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-integration feature rollout plus an immutable mode-change audit trail.
CREATE TABLE IF NOT EXISTS eagle_rollout_states (
  integration_id      CHAR(36)      NOT NULL PRIMARY KEY,
  api_key_id          CHAR(36)      NOT NULL,
  rollout_mode        VARCHAR(16)   NOT NULL DEFAULT 'parallel',
  required_passes     TINYINT UNSIGNED NOT NULL DEFAULT 2,
  promoted_by         CHAR(36)      NULL,
  promoted_at         TIMESTAMP     NULL DEFAULT NULL,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_eagle_rollout_key (api_key_id, rollout_mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS eagle_rollout_audit (
  id                  BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  actor_admin_id      CHAR(36)      NULL,
  from_mode           VARCHAR(16)   NULL,
  to_mode             VARCHAR(16)   NOT NULL,
  reason              VARCHAR(1000) NOT NULL,
  validation_run_id   CHAR(36)      NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_eagle_rollout_audit_context (integration_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Restricted EAGLE debugging actions. Payloads retain state summaries, never schedule bodies.
CREATE TABLE IF NOT EXISTS eagle_debug_actions (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  location_id         VARCHAR(128)  NOT NULL,
  actor_admin_id      CHAR(36)      NULL,
  actor_username      VARCHAR(128)  NULL,
  action              VARCHAR(64)   NOT NULL,
  entity_type         VARCHAR(64)   NOT NULL,
  entity_id           VARCHAR(128)  NOT NULL,
  reason              VARCHAR(512)  NOT NULL,
  before_json         TEXT          NULL,
  after_json          TEXT          NULL,
  created_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_eagle_debug_context (integration_id, location_id, created_at),
  KEY idx_eagle_debug_entity (entity_type, entity_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Approved KPI targets are integration scoped; every change retains its governance reason.
CREATE TABLE IF NOT EXISTS eagle_metric_targets (
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  metric_id           VARCHAR(64)   NOT NULL,
  period_days         SMALLINT UNSIGNED NULL,
  target_value        DECIMAL(24,6) NOT NULL,
  target_direction    VARCHAR(16)   NOT NULL,
  warning_margin      DECIMAL(18,6) NOT NULL DEFAULT 0,
  business_owner      VARCHAR(128)  NOT NULL,
  is_active           TINYINT(1)    NOT NULL DEFAULT 1,
  updated_by          CHAR(36)      NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (integration_id, metric_id),
  KEY idx_eagle_target_key (api_key_id, is_active, metric_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS eagle_metric_target_audit (
  id                  BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  integration_id      CHAR(36)      NOT NULL,
  api_key_id          CHAR(36)      NOT NULL,
  metric_id           VARCHAR(64)   NOT NULL,
  actor_admin_id      CHAR(36)      NULL,
  reason              VARCHAR(1000) NOT NULL,
  before_json         TEXT          NULL,
  after_json          TEXT          NOT NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_eagle_target_audit (integration_id, metric_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS eagle_campaign_sync_runs (
  id               CHAR(36)      NOT NULL PRIMARY KEY,
  integration_id   CHAR(36)      NOT NULL,
  api_key_id       CHAR(36)      NOT NULL,
  location_id      VARCHAR(128)  NOT NULL,
  status           VARCHAR(24)   NOT NULL DEFAULT 'queued',
  pages_processed  INT UNSIGNED  NOT NULL DEFAULT 0,
  events_received  INT UNSIGNED  NOT NULL DEFAULT 0,
  expected_events  INT UNSIGNED  NULL,
  range_start      DATE          NOT NULL,
  range_end        DATE          NOT NULL,
  error_summary    VARCHAR(1000) NULL,
  requested_by     CHAR(36)      NULL,
  started_at       TIMESTAMP     NULL DEFAULT NULL,
  completed_at     TIMESTAMP     NULL DEFAULT NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_eagle_campaign_run_context (integration_id, status, created_at),
  KEY idx_eagle_campaign_run_key (api_key_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Attribution-only projection. Form answers and message content are intentionally excluded.
CREATE TABLE IF NOT EXISTS eagle_campaign_events (
  integration_id   CHAR(36)      NOT NULL,
  event_id          VARCHAR(191)  NOT NULL,
  location_id       VARCHAR(128)  NOT NULL,
  contact_id        VARCHAR(191)  NULL,
  form_id           VARCHAR(191)  NULL,
  form_name         VARCHAR(255)  NULL,
  event_type        VARCHAR(64)   NULL,
  event_at          DATETIME      NOT NULL,
  page_url          VARCHAR(1600) NULL,
  page_title        VARCHAR(500)  NULL,
  page_domain       VARCHAR(255)  NULL,
  page_path         VARCHAR(800)  NULL,
  referrer_url      VARCHAR(1600) NULL,
  referrer_host     VARCHAR(255)  NULL,
  source            VARCHAR(191)  NULL,
  medium            VARCHAR(128)  NULL,
  ad_source         VARCHAR(191)  NULL,
  utm_source        VARCHAR(191)  NULL,
  utm_medium        VARCHAR(191)  NULL,
  utm_campaign      VARCHAR(255)  NULL,
  utm_content       VARCHAR(255)  NULL,
  fbclid            VARCHAR(1024) NULL,
  fbc               VARCHAR(512)  NULL,
  fbp               VARCHAR(512)  NULL,
  fb_event_id       VARCHAR(512)  NULL,
  gclid             VARCHAR(1024) NULL,
  last_sync_run_id  CHAR(36)      NOT NULL,
  first_seen_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (integration_id, event_id),
  KEY idx_eagle_campaign_date (integration_id, location_id, event_at),
  KEY idx_eagle_campaign_contact (integration_id, contact_id),
  KEY idx_eagle_campaign_page (integration_id, page_domain, page_path(191)),
  KEY idx_eagle_campaign_form (integration_id, form_id, event_at),
  KEY idx_eagle_campaign_utm (integration_id, utm_source, utm_campaign)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Official U.S. Census ACS population reference used for EAGLE market-footprint metrics.
CREATE TABLE IF NOT EXISTS census_geography_reference (
  dataset_year       SMALLINT UNSIGNED NOT NULL,
  geography_type     VARCHAR(16)       NOT NULL,
  state_fips         CHAR(2)           NOT NULL DEFAULT '',
  place_fips         CHAR(5)           NOT NULL DEFAULT '',
  state_code         CHAR(2)           NULL,
  name               VARCHAR(255)      NOT NULL,
  normalized_name    VARCHAR(191)      NULL,
  population         BIGINT UNSIGNED   NOT NULL DEFAULT 0,
  source_url         VARCHAR(500)      NOT NULL,
  fetched_at         TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dataset_year, geography_type, state_fips, place_fips),
  KEY idx_census_place_match (dataset_year, geography_type, state_code, normalized_name),
  KEY idx_census_population (dataset_year, geography_type, population)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- SQL Connection Hub: secondary MySQL targets (passwords encrypted at rest)
CREATE TABLE IF NOT EXISTS sql_connections (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  slug            VARCHAR(64)  NOT NULL,
  name            VARCHAR(128) NOT NULL,
  host            VARCHAR(255) NOT NULL,
  port            INT          NOT NULL DEFAULT 3306,
  database_name   VARCHAR(128) NOT NULL,
  username        VARCHAR(128) NOT NULL,
  password_enc    TEXT         NOT NULL,
  ssl_enabled     TINYINT(1)   NOT NULL DEFAULT 0,
  is_enabled      TINYINT(1)   NOT NULL DEFAULT 1,
  max_rows        INT          NOT NULL DEFAULT 500,
  notes           VARCHAR(512) NULL,
  created_by      CHAR(36)     NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sql_conn_slug (slug),
  KEY idx_sql_conn_enabled (is_enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which API keys may use which SQL connection
CREATE TABLE IF NOT EXISTS sql_connection_grants (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  connection_id   CHAR(36)     NOT NULL,
  api_key_id      CHAR(36)     NOT NULL,
  can_introspect  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sql_grant_key_conn (connection_id, api_key_id),
  KEY idx_sql_grant_key (api_key_id),
  KEY idx_sql_grant_conn (connection_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-grant table + operation allowlist (default deny)
CREATE TABLE IF NOT EXISTS sql_table_grants (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  grant_id        CHAR(36)     NOT NULL,
  table_name      VARCHAR(128) NOT NULL,
  allow_select    TINYINT(1)   NOT NULL DEFAULT 1,
  allow_insert    TINYINT(1)   NOT NULL DEFAULT 0,
  allow_update    TINYINT(1)   NOT NULL DEFAULT 0,
  allow_delete    TINYINT(1)   NOT NULL DEFAULT 0,
  primary_key     VARCHAR(64)  NOT NULL DEFAULT 'id',
  allowed_columns TEXT         NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sql_table_grant (grant_id, table_name),
  KEY idx_sql_table_grant (grant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Dialer Session Harbor: per-operator workspace (CRM path + UI state; NOT CRM cookies)
CREATE TABLE IF NOT EXISTS dialer_workspaces (
  location_id     VARCHAR(128)  NOT NULL,
  user_id         VARCHAR(128)  NOT NULL,
  revision        INT UNSIGNED  NOT NULL DEFAULT 1,
  state_json      LONGTEXT      NOT NULL,
  crm_contact_id  VARCHAR(128)  NULL,
  crm_path        VARCHAR(512)  NULL,
  client_tab_id   VARCHAR(64)   NULL,
  lease_until     TIMESTAMP     NULL DEFAULT NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (location_id, user_id),
  KEY idx_workspace_updated (updated_at),
  KEY idx_workspace_contact (location_id, crm_contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per verified operator/activity minute. This is intentionally metadata-only:
-- no CRM payload, phone number, URL, cookie, token, or workspace state is retained.
CREATE TABLE IF NOT EXISTS dialer_activity_minutes (
  location_id    VARCHAR(128) NOT NULL,
  user_id        VARCHAR(128) NOT NULL,
  activity_minute DATETIME    NOT NULL,
  heartbeat_count SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  crm_contact_id VARCHAR(128) NULL,
  client_tab_id  VARCHAR(64)  NULL,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (location_id, user_id, activity_minute),
  KEY idx_activity_report (location_id, activity_minute, user_id),
  KEY idx_activity_contact (location_id, user_id, crm_contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sentinel OpSec Response: IP blocklist (enforced on /api/*)
CREATE TABLE IF NOT EXISTS sentinel_ip_blocks (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  ip             VARCHAR(45)   NOT NULL,
  cidr           VARCHAR(50)   NULL,
  reason         VARCHAR(512)  NOT NULL,
  source         VARCHAR(32)   NOT NULL DEFAULT 'manual',
  case_id        CHAR(36)      NULL,
  is_active      TINYINT(1)    NOT NULL DEFAULT 1,
  expires_at     TIMESTAMP(3)  NULL DEFAULT NULL,
  created_by     VARCHAR(64)   NULL,
  created_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  revoked_at     TIMESTAMP(3)  NULL DEFAULT NULL,
  revoked_by     VARCHAR(64)   NULL,
  revoke_reason  VARCHAR(512)  NULL,
  KEY idx_ip_blocks_ip (ip),
  KEY idx_ip_blocks_active (is_active, expires_at),
  KEY idx_ip_blocks_case (case_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Durable threat cases (review queue)
CREATE TABLE IF NOT EXISTS sentinel_threat_cases (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  fingerprint    VARCHAR(191)  NOT NULL,
  rule_id        VARCHAR(64)   NOT NULL,
  severity       VARCHAR(16)   NOT NULL,
  title          VARCHAR(255)  NOT NULL,
  summary        VARCHAR(512)  NOT NULL,
  entity_type    VARCHAR(32)   NOT NULL,
  entity         VARCHAR(255)  NOT NULL,
  status         VARCHAR(32)   NOT NULL DEFAULT 'open',
  owner_admin_id VARCHAR(64)   NULL,
  priority       VARCHAR(16)   NOT NULL DEFAULT 'normal',
  confidence     VARCHAR(16)   NULL,
  disposition    VARCHAR(32)   NULL,
  due_at         TIMESTAMP(3)  NULL DEFAULT NULL,
  evidence_json  MEDIUMTEXT    NULL,
  count          INT           NOT NULL DEFAULT 0,
  window_hours   INT           NULL,
  first_seen     TIMESTAMP(3)  NULL DEFAULT NULL,
  last_seen      TIMESTAMP(3)  NULL DEFAULT NULL,
  review_note    TEXT          NULL,
  resolution_summary TEXT      NULL,
  validation_summary TEXT      NULL,
  triaged_by     VARCHAR(64)   NULL,
  triaged_at     TIMESTAMP(3)  NULL DEFAULT NULL,
  contained_by  VARCHAR(64)   NULL,
  contained_at  TIMESTAMP(3)  NULL DEFAULT NULL,
  resolved_by    VARCHAR(64)   NULL,
  resolved_at    TIMESTAMP(3)  NULL DEFAULT NULL,
  validated_by  VARCHAR(64)   NULL,
  validated_at  TIMESTAMP(3)  NULL DEFAULT NULL,
  closed_by      VARCHAR(64)   NULL,
  closed_at      TIMESTAMP(3)  NULL DEFAULT NULL,
  reopen_count   INT UNSIGNED NOT NULL DEFAULT 0,
  created_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_case_fingerprint (fingerprint),
  KEY idx_cases_status (status, severity),
  KEY idx_cases_entity (entity_type, entity),
  KEY idx_cases_last_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Case action audit trail
CREATE TABLE IF NOT EXISTS sentinel_case_actions (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  case_id        CHAR(36)      NOT NULL,
  admin_id       VARCHAR(64)   NULL,
  action         VARCHAR(32)   NOT NULL,
  detail         VARCHAR(512)  NULL,
  created_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_case_actions_case (case_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_case_notes (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  case_id        CHAR(36)      NOT NULL,
  admin_id       VARCHAR(64)   NULL,
  note_type      VARCHAR(32)   NOT NULL DEFAULT 'analyst',
  note           TEXT          NOT NULL,
  created_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_case_notes_case (case_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_case_status_history (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  case_id        CHAR(36)      NOT NULL,
  admin_id       VARCHAR(64)   NULL,
  from_status    VARCHAR(32)   NULL,
  to_status      VARCHAR(32)   NOT NULL,
  reason         VARCHAR(512)  NULL,
  created_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_case_history_case (case_id, created_at),
  KEY idx_case_history_status (to_status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Purple Team control validation. Stores metadata and outcomes only, never attack payloads.
CREATE TABLE IF NOT EXISTS sentinel_validation_runs (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  name           VARCHAR(128)  NOT NULL,
  objective      VARCHAR(512)  NULL,
  detection_window_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 15,
  status         VARCHAR(24)   NOT NULL DEFAULT 'planned',
  created_by     VARCHAR(64)   NULL,
  started_at     TIMESTAMP(3)  NULL DEFAULT NULL,
  ended_at       TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_validation_runs_status (status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_validation_observations (
  id               CHAR(36)      NOT NULL PRIMARY KEY,
  run_id           CHAR(36)      NOT NULL,
  technique_id     VARCHAR(32)   NOT NULL,
  tactic           VARCHAR(64)   NULL,
  expected_rule_id VARCHAR(64)   NULL,
  triggered_case_id CHAR(36)     NULL,
  outcome          VARCHAR(24)   NOT NULL,
  simulated_at     TIMESTAMP(3)  NOT NULL,
  detected_at      TIMESTAMP(3)  NULL DEFAULT NULL,
  evaluated_at     TIMESTAMP(3)  NULL DEFAULT NULL,
  evaluation_source VARCHAR(24)  NULL,
  remediation_case_id CHAR(36)   NULL,
  note             VARCHAR(1000) NULL,
  recorded_by      VARCHAR(64)   NULL,
  created_at       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_validation_observation_run (run_id,created_at),
  KEY idx_validation_observation_technique (technique_id,outcome),
  KEY idx_validation_observation_case (triggered_case_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_rule_techniques (
  rule_id        VARCHAR(64)   NOT NULL,
  technique_id   VARCHAR(32)   NOT NULL,
  tactic         VARCHAR(64)   NULL,
  updated_by     VARCHAR(64)   NULL,
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (rule_id,technique_id),
  KEY idx_rule_technique (technique_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_routine_runs (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  routine_key    VARCHAR(64)   NOT NULL,
  routine_type   VARCHAR(32)   NOT NULL DEFAULT 'daily_protection',
  status         VARCHAR(24)   NOT NULL DEFAULT 'running',
  triggered_by   VARCHAR(64)   NULL,
  summary_json   MEDIUMTEXT    NULL,
  error_summary  VARCHAR(512)  NULL,
  started_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at   TIMESTAMP(3)  NULL DEFAULT NULL,
  UNIQUE KEY uq_sentinel_routine_key (routine_key),
  KEY idx_sentinel_routine_status (routine_type,status,started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_retention_policies (
  data_class     VARCHAR(64)   NOT NULL PRIMARY KEY,
  retention_days INT UNSIGNED NOT NULL,
  is_enabled     TINYINT(1)    NOT NULL DEFAULT 1,
  updated_by     VARCHAR(64)   NULL,
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_retention_runs (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  mode           VARCHAR(16)   NOT NULL,
  status         VARCHAR(24)   NOT NULL,
  executed_by    VARCHAR(64)   NULL,
  impact_json    MEDIUMTEXT    NULL,
  error_summary  VARCHAR(512)  NULL,
  started_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at   TIMESTAMP(3)  NULL DEFAULT NULL,
  KEY idx_retention_runs (status,started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_finding_dispositions (
  id                CHAR(36)      NOT NULL PRIMARY KEY,
  fingerprint       VARCHAR(191)  NOT NULL,
  rule_id           VARCHAR(64)   NOT NULL,
  entity_type       VARCHAR(32)   NOT NULL,
  entity            VARCHAR(255)  NOT NULL,
  disposition       VARCHAR(32)   NOT NULL,
  scope_json        TEXT          NULL,
  conditions_json   TEXT          NULL,
  reason            VARCHAR(1000) NOT NULL,
  baseline_count    INT           NULL,
  created_by        VARCHAR(64)   NULL,
  expires_at        TIMESTAMP(3)  NULL DEFAULT NULL,
  is_active         TINYINT(1)    NOT NULL DEFAULT 1,
  created_at        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  revoked_at        TIMESTAMP(3)  NULL DEFAULT NULL,
  revoked_by        VARCHAR(64)   NULL,
  revoke_reason     VARCHAR(512)  NULL,
  KEY idx_finding_disposition_fingerprint (fingerprint,is_active,expires_at),
  KEY idx_finding_disposition_rule (rule_id,is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Governed SOAR playbook library. Phase 1 supports analyst-controlled manual checklists only.
CREATE TABLE IF NOT EXISTS sentinel_playbooks (
  id CHAR(36) NOT NULL PRIMARY KEY,
  slug VARCHAR(96) NOT NULL,
  name VARCHAR(160) NOT NULL,
  purpose VARCHAR(512) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  owner_admin_id VARCHAR(64) NULL,
  current_version_id CHAR(36) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sentinel_playbook_slug (slug),
  KEY idx_sentinel_playbook_status (status,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_playbook_versions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  playbook_id CHAR(36) NOT NULL,
  version_number INT UNSIGNED NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  required_entities_json TEXT NULL,
  techniques_json TEXT NULL,
  preconditions_json TEXT NULL,
  rollback_plan TEXT NULL,
  created_by VARCHAR(64) NULL,
  approved_by VARCHAR(64) NULL,
  approved_at TIMESTAMP(3) NULL DEFAULT NULL,
  published_at TIMESTAMP(3) NULL DEFAULT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sentinel_playbook_version (playbook_id,version_number),
  KEY idx_sentinel_playbook_version_status (status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_playbook_steps (
  id CHAR(36) NOT NULL PRIMARY KEY,
  version_id CHAR(36) NOT NULL,
  step_order SMALLINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  step_type VARCHAR(32) NOT NULL DEFAULT 'manual',
  risk_class VARCHAR(24) NOT NULL DEFAULT 'observe',
  is_required TINYINT(1) NOT NULL DEFAULT 1,
  instructions TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sentinel_playbook_step_order (version_id,step_order),
  KEY idx_sentinel_playbook_step_version (version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_playbook_runs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  playbook_id CHAR(36) NOT NULL,
  version_id CHAR(36) NOT NULL,
  case_id CHAR(36) NULL,
  finding_id VARCHAR(255) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'running',
  mode VARCHAR(24) NOT NULL DEFAULT 'manual',
  started_by VARCHAR(64) NULL,
  completed_by VARCHAR(64) NULL,
  analyst_note TEXT NULL,
  started_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at TIMESTAMP(3) NULL DEFAULT NULL,
  KEY idx_sentinel_playbook_run_status (status,started_at),
  KEY idx_sentinel_playbook_run_case (case_id,started_at),
  KEY idx_sentinel_playbook_run_book (playbook_id,started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_playbook_step_runs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  run_id CHAR(36) NOT NULL,
  step_id CHAR(36) NOT NULL,
  step_order SMALLINT UNSIGNED NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  analyst_note VARCHAR(1000) NULL,
  evidence_reference VARCHAR(512) NULL,
  completed_by VARCHAR(64) NULL,
  completed_at TIMESTAMP(3) NULL DEFAULT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sentinel_playbook_step_run (run_id,step_id),
  KEY idx_sentinel_playbook_step_run_status (run_id,status,step_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_playbook_reviews (
  id CHAR(36) NOT NULL PRIMARY KEY,
  playbook_id CHAR(36) NOT NULL,
  version_id CHAR(36) NOT NULL,
  actor_admin_id VARCHAR(64) NULL,
  action VARCHAR(32) NOT NULL,
  from_status VARCHAR(24) NULL,
  to_status VARCHAR(24) NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_sentinel_playbook_review_book (playbook_id,created_at),
  KEY idx_sentinel_playbook_review_version (version_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_playbook_simulations (
  id CHAR(36) NOT NULL PRIMARY KEY,
  playbook_id CHAR(36) NOT NULL,
  version_id CHAR(36) NOT NULL,
  mode VARCHAR(24) NOT NULL,
  status VARCHAR(24) NOT NULL,
  context_hash CHAR(64) NOT NULL,
  context_summary_json TEXT NULL,
  action_plan_json MEDIUMTEXT NOT NULL,
  result_json MEDIUMTEXT NULL,
  executed_by VARCHAR(64) NULL,
  error_summary VARCHAR(512) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at TIMESTAMP(3) NULL DEFAULT NULL,
  KEY idx_sentinel_simulation_book (playbook_id,created_at),
  KEY idx_sentinel_simulation_mode (mode,status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_playbook_validation_results (
  id CHAR(36) NOT NULL PRIMARY KEY,
  playbook_id CHAR(36) NOT NULL,
  version_id CHAR(36) NOT NULL,
  gate_key VARCHAR(64) NOT NULL,
  outcome VARCHAR(24) NOT NULL,
  evidence_reference VARCHAR(512) NOT NULL,
  note VARCHAR(1000) NULL,
  tested_by VARCHAR(64) NULL,
  tested_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sentinel_playbook_validation_gate (version_id,gate_key),
  KEY idx_sentinel_playbook_validation_book (playbook_id,tested_at),
  KEY idx_sentinel_playbook_validation_outcome (outcome,tested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_resource_items (
  id CHAR(36) NOT NULL PRIMARY KEY,
  slug VARCHAR(128) NOT NULL,
  item_type VARCHAR(32) NOT NULL,
  category VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  summary VARCHAR(1000) NULL,
  publisher VARCHAR(128) NOT NULL,
  source_url VARCHAR(1000) NULL,
  source_domain VARCHAR(191) NULL,
  priority VARCHAR(16) NOT NULL DEFAULT 'normal',
  review_status VARCHAR(24) NOT NULL DEFAULT 'unreviewed',
  tags_json TEXT NULL,
  cves_json TEXT NULL,
  techniques_json TEXT NULL,
  assigned_to VARCHAR(64) NULL,
  linked_case_id CHAR(36) NULL,
  linked_playbook_id CHAR(36) NULL,
  analyst_note VARCHAR(1000) NULL,
  is_pinned TINYINT(1) NOT NULL DEFAULT 0,
  published_at TIMESTAMP(3) NULL DEFAULT NULL,
  reviewed_at TIMESTAMP(3) NULL DEFAULT NULL,
  reviewed_by VARCHAR(64) NULL,
  created_by VARCHAR(64) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sentinel_resource_slug (slug),
  KEY idx_sentinel_resource_review (review_status,priority,updated_at),
  KEY idx_sentinel_resource_type (item_type,category,is_pinned)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sentinel_resource_reviews (
  id CHAR(36) NOT NULL PRIMARY KEY,
  resource_id CHAR(36) NOT NULL,
  actor_admin_id VARCHAR(64) NULL,
  from_status VARCHAR(24) NULL,
  to_status VARCHAR(24) NOT NULL,
  note VARCHAR(1000) NULL,
  linked_case_id CHAR(36) NULL,
  linked_playbook_id CHAR(36) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_sentinel_resource_review_item (resource_id,created_at),
  KEY idx_sentinel_resource_review_actor (actor_admin_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Admin-defined flagging rules (safe JSON DSL, no raw SQL)
CREATE TABLE IF NOT EXISTS sentinel_custom_rules (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  name           VARCHAR(128)  NOT NULL,
  description    VARCHAR(512)  NULL,
  is_enabled     TINYINT(1)    NOT NULL DEFAULT 1,
  priority       INT           NOT NULL DEFAULT 100,
  severity       VARCHAR(16)   NOT NULL DEFAULT 'medium',
  condition_json TEXT          NOT NULL,
  actions_json   TEXT          NOT NULL,
  created_by     VARCHAR(64)   NULL,
  created_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_custom_rules_enabled (is_enabled, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- First-contact IP radar
CREATE TABLE IF NOT EXISTS sentinel_ip_sightings (
  ip                   VARCHAR(45)   NOT NULL PRIMARY KEY,
  first_seen           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  first_status_code    SMALLINT      NULL,
  first_path           VARCHAR(255)  NULL,
  first_method         VARCHAR(10)   NULL,
  first_was_auth_fail  TINYINT(1)    NOT NULL DEFAULT 0,
  total_requests       INT           NOT NULL DEFAULT 0,
  auth_fail_count      INT           NOT NULL DEFAULT 0,
  success_count        INT           NOT NULL DEFAULT 0,
  last_status_code     SMALLINT      NULL,
  notes                VARCHAR(512)  NULL,
  KEY idx_sightings_first_fail (first_was_auth_fail, first_seen),
  KEY idx_sightings_first_seen (first_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- RDAP/WHOIS cache (server-side enrichment)
CREATE TABLE IF NOT EXISTS sentinel_ip_intel_cache (
  ip             VARCHAR(45)   NOT NULL PRIMARY KEY,
  payload_json   MEDIUMTEXT    NULL,
  provider       VARCHAR(32)   NOT NULL DEFAULT 'rdap',
  fetched_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at     TIMESTAMP(3)  NOT NULL,
  error          VARCHAR(255)  NULL,
  KEY idx_intel_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tenant-scoped OWL contact synchronization endpoints. Each endpoint is bound
-- server-side to one API key, location, operational SQL source, and CRM integration.
CREATE TABLE IF NOT EXISTS owl_webhook_endpoints (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  api_key_id            CHAR(36)      NOT NULL,
  location_id           VARCHAR(128)  NOT NULL,
  data_source_slug      VARCHAR(63)   NOT NULL DEFAULT 'dial',
  integration_id        CHAR(36)      NOT NULL,
  public_id             VARCHAR(64)   NOT NULL,
  secret_enc            TEXT          NOT NULL,
  secret_hint           VARCHAR(12)   NOT NULL,
  allow_contact_created TINYINT(1)    NOT NULL DEFAULT 1,
  allow_contact_updated TINYINT(1)    NOT NULL DEFAULT 1,
  is_enabled            TINYINT(1)    NOT NULL DEFAULT 1,
  created_by            CHAR(36)      NULL,
  rotated_by            CHAR(36)      NULL,
  last_received_at      TIMESTAMP(3)  NULL,
  last_success_at       TIMESTAMP(3)  NULL,
  last_error_code       VARCHAR(64)   NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_owl_webhook_scope (api_key_id,location_id,data_source_slug),
  UNIQUE KEY uq_owl_webhook_public (public_id),
  KEY idx_owl_webhook_enabled (is_enabled,updated_at),
  KEY idx_owl_webhook_integration (integration_id,location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Delivery ledger stores bounded synchronization evidence, not credentials or
-- duplicated CRM payload bodies. Failed event IDs may be retried safely.
CREATE TABLE IF NOT EXISTS owl_webhook_deliveries (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  endpoint_id           CHAR(36)      NOT NULL,
  request_id            VARCHAR(64)   NULL,
  event_key             VARCHAR(191)  NOT NULL,
  event_name            VARCHAR(32)   NOT NULL,
  contact_id            VARCHAR(191)  NOT NULL,
  payload_sha256        CHAR(64)      NOT NULL,
  auth_mode             VARCHAR(16)   NOT NULL,
  status                VARCHAR(24)   NOT NULL DEFAULT 'accepted',
  lead_id               VARCHAR(128)  NULL,
  outcome               VARCHAR(48)   NULL,
  result_json           TEXT          NULL,
  error_code            VARCHAR(64)   NULL,
  error_message         VARCHAR(1000) NULL,
  duration_ms           INT UNSIGNED  NULL,
  received_at           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at          TIMESTAMP(3)  NULL,
  UNIQUE KEY uq_owl_webhook_event (endpoint_id,event_key),
  KEY idx_owl_webhook_delivery_status (endpoint_id,status,received_at),
  KEY idx_owl_webhook_delivery_contact (contact_id,received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Workbench preservation and application-integration control plane.
-- Secrets are never returned through the admin API. Registry records refer to
-- vault entries so credential rotation does not rewrite every consumer.
CREATE TABLE IF NOT EXISTS integration_secrets (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  name                  VARCHAR(128)  NOT NULL,
  secret_kind           VARCHAR(32)   NOT NULL,
  secret_enc            MEDIUMTEXT    NOT NULL,
  secret_hint           VARCHAR(16)   NULL,
  version_number        INT UNSIGNED  NOT NULL DEFAULT 1,
  status                VARCHAR(24)   NOT NULL DEFAULT 'active',
  created_by            VARCHAR(64)   NULL,
  rotated_by            VARCHAR(64)   NULL,
  rotated_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  retired_by            VARCHAR(64)   NULL,
  retired_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_integration_secret_status (status,updated_at),
  KEY idx_integration_secret_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS integration_registry (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  slug                  VARCHAR(63)   NOT NULL,
  name                  VARCHAR(128)  NOT NULL,
  adapter_type          VARCHAR(32)   NOT NULL,
  source_ref_type       VARCHAR(32)   NULL,
  source_ref_id         VARCHAR(191)  NULL,
  base_url              VARCHAR(1000) NULL,
  credential_id         CHAR(36)      NULL,
  config_json           MEDIUMTEXT    NULL,
  is_enabled            TINYINT(1)    NOT NULL DEFAULT 1,
  last_validation_status VARCHAR(24)  NULL,
  last_validated_at     TIMESTAMP(3)  NULL DEFAULT NULL,
  created_by            VARCHAR(64)   NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_integration_registry_slug (slug),
  KEY idx_integration_registry_adapter (adapter_type,is_enabled),
  KEY idx_integration_registry_credential (credential_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS preservation_destinations (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  slug                  VARCHAR(63)   NOT NULL,
  name                  VARCHAR(128)  NOT NULL,
  destination_type      VARCHAR(32)   NOT NULL,
  credential_id         CHAR(36)      NULL,
  config_json           MEDIUMTEXT    NULL,
  is_enabled            TINYINT(1)    NOT NULL DEFAULT 1,
  is_protection_target  TINYINT(1)    NOT NULL DEFAULT 1,
  last_validation_status VARCHAR(24)  NULL,
  last_validated_at     TIMESTAMP(3)  NULL DEFAULT NULL,
  created_by            VARCHAR(64)   NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_preservation_destination_slug (slug),
  KEY idx_preservation_destination_type (destination_type,is_enabled),
  KEY idx_preservation_destination_credential (credential_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS preservation_export_definitions (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  slug                  VARCHAR(63)   NOT NULL,
  name                  VARCHAR(160)  NOT NULL,
  description           VARCHAR(1000) NULL,
  location_id           VARCHAR(128)  NULL,
  source_type           VARCHAR(32)   NOT NULL,
  source_ref_id         VARCHAR(191)  NULL,
  source_key            VARCHAR(96)   NOT NULL,
  destination_id        CHAR(36)      NULL,
  export_format         VARCHAR(16)   NOT NULL,
  status                VARCHAR(24)   NOT NULL DEFAULT 'draft',
  current_version_id    CHAR(36)      NULL,
  retention_days        SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  schedule_cron         VARCHAR(128)  NULL,
  created_by            VARCHAR(64)   NULL,
  archived_by           VARCHAR(64)   NULL,
  archived_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_preservation_definition_slug (slug),
  KEY idx_preservation_definition_scope (location_id,status,updated_at),
  KEY idx_preservation_definition_destination (destination_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS preservation_export_versions (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  definition_id         CHAR(36)      NOT NULL,
  version_number        INT UNSIGNED  NOT NULL,
  status                VARCHAR(24)   NOT NULL DEFAULT 'draft',
  source_config_json    MEDIUMTEXT    NOT NULL,
  mapping_json          MEDIUMTEXT    NOT NULL,
  filters_json          MEDIUMTEXT    NULL,
  format_config_json    MEDIUMTEXT    NULL,
  schema_sha256         CHAR(64)      NOT NULL,
  created_by            VARCHAR(64)   NULL,
  published_by          VARCHAR(64)   NULL,
  published_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_preservation_definition_version (definition_id,version_number),
  KEY idx_preservation_version_status (definition_id,status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS preservation_jobs (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  job_type              VARCHAR(32)   NOT NULL DEFAULT 'export',
  definition_id         CHAR(36)      NULL,
  version_id            CHAR(36)      NULL,
  destination_id        CHAR(36)      NULL,
  idempotency_key       VARCHAR(191)  NOT NULL,
  status                VARCHAR(24)   NOT NULL DEFAULT 'queued',
  protection_status     VARCHAR(24)   NOT NULL DEFAULT 'unprotected',
  progress_percent      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  worker_id             VARCHAR(128)  NULL,
  lease_expires_at      TIMESTAMP(3)  NULL DEFAULT NULL,
  attempt_count         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  checkpoint_json       MEDIUMTEXT    NULL,
  watermark_json        MEDIUMTEXT    NULL,
  requested_by          VARCHAR(64)   NULL,
  error_code            VARCHAR(64)   NULL,
  error_summary         VARCHAR(1000) NULL,
  queued_at             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  completed_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  expires_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_preservation_job_idempotency (idempotency_key),
  KEY idx_preservation_job_queue (status,queued_at),
  KEY idx_preservation_job_lease (status,lease_expires_at),
  KEY idx_preservation_job_definition (definition_id,created_at),
  KEY idx_preservation_job_expiry (expires_at,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS preservation_artifacts (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  job_id                CHAR(36)      NOT NULL,
  logical_name          VARCHAR(255)  NOT NULL,
  media_type            VARCHAR(128)  NOT NULL,
  export_format         VARCHAR(16)   NOT NULL,
  storage_uri           VARCHAR(1000) NULL,
  byte_count            BIGINT UNSIGNED NOT NULL DEFAULT 0,
  record_count          BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rejected_count        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  sha256                CHAR(64)      NULL,
  is_encrypted          TINYINT(1)    NOT NULL DEFAULT 1,
  encryption_json       TEXT          NULL,
  status                VARCHAR(24)   NOT NULL DEFAULT 'staging',
  verified_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  expires_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  deleted_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_preservation_artifact_job (job_id,status),
  KEY idx_preservation_artifact_expiry (expires_at,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS preservation_job_manifests (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  job_id                CHAR(36)      NOT NULL,
  manifest_version      SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  manifest_json         MEDIUMTEXT    NOT NULL,
  manifest_sha256       CHAR(64)      NOT NULL,
  verified_at           TIMESTAMP(3)  NULL DEFAULT NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_preservation_manifest_job (job_id),
  KEY idx_preservation_manifest_hash (manifest_sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS preservation_delivery_attempts (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  job_id                CHAR(36)      NOT NULL,
  artifact_id           CHAR(36)      NOT NULL,
  destination_id        CHAR(36)      NOT NULL,
  attempt_number        SMALLINT UNSIGNED NOT NULL,
  idempotency_key       VARCHAR(191)  NOT NULL,
  status                VARCHAR(24)   NOT NULL DEFAULT 'queued',
  remote_reference      VARCHAR(1000) NULL,
  byte_count            BIGINT UNSIGNED NULL,
  sha256                CHAR(64)      NULL,
  error_code            VARCHAR(64)   NULL,
  error_summary         VARCHAR(1000) NULL,
  scheduled_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at            TIMESTAMP(3)  NULL DEFAULT NULL,
  completed_at          TIMESTAMP(3)  NULL DEFAULT NULL,
  UNIQUE KEY uq_preservation_delivery_attempt (artifact_id,destination_id,attempt_number),
  UNIQUE KEY uq_preservation_delivery_idempotency (idempotency_key),
  KEY idx_preservation_delivery_job (job_id,status,scheduled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS preservation_audit_events (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  request_id            VARCHAR(64)   NULL,
  actor_type            VARCHAR(32)   NULL,
  actor_id              VARCHAR(128)  NULL,
  action                VARCHAR(128)  NOT NULL,
  entity_type           VARCHAR(64)   NOT NULL,
  entity_id             VARCHAR(191)  NULL,
  outcome               VARCHAR(24)   NOT NULL DEFAULT 'success',
  details_json          TEXT          NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_preservation_audit_entity (entity_type,entity_id,created_at),
  KEY idx_preservation_audit_actor (actor_id,created_at),
  KEY idx_preservation_audit_action (action,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
