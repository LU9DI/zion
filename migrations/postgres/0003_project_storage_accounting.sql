-- Durable storage accounting and upload-abuse evidence.
-- Depends on migration 0002_project_resource_policy.sql.
-- This migration creates enforcement state only; it does not activate limits.
BEGIN;

CREATE TABLE project_storage_blobs (
  blob_id uuid PRIMARY KEY,
  project_id uuid NOT NULL
    REFERENCES zion_projects(project_id) ON DELETE RESTRICT,
  ciphertext_sha256 char(64) NOT NULL
    CHECK (ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
  ciphertext_bytes bigint NOT NULL CHECK (ciphertext_bytes > 0),
  verification_status text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'verified', 'quarantined', 'released')),
  verified_at timestamptz,
  replica_count integer NOT NULL DEFAULT 0 CHECK (replica_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, ciphertext_sha256),
  CHECK ((verification_status = 'verified') = (verified_at IS NOT NULL))
);

CREATE INDEX project_storage_blobs_verified_by_project
  ON project_storage_blobs (project_id, ciphertext_bytes)
  WHERE verification_status = 'verified';

CREATE TABLE project_storage_objects (
  object_id uuid PRIMARY KEY,
  project_id uuid NOT NULL
    REFERENCES zion_projects(project_id) ON DELETE RESTRICT,
  blob_id uuid NOT NULL
    REFERENCES project_storage_blobs(blob_id) ON DELETE RESTRICT,
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  object_state text NOT NULL DEFAULT 'active'
    CHECK (object_state IN ('pending', 'active', 'deleted', 'quarantined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, object_id)
);

CREATE INDEX project_storage_objects_by_project_state
  ON project_storage_objects (project_id, object_state, created_at DESC);

CREATE INDEX project_storage_objects_by_owner_state
  ON project_storage_objects (owner_id, object_state, created_at DESC);

CREATE TABLE project_storage_upload_events (
  upload_event_id uuid PRIMARY KEY,
  project_id uuid NOT NULL
    REFERENCES zion_projects(project_id) ON DELETE RESTRICT,
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  node_id char(64) CHECK (node_id IS NULL OR node_id ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 256),
  ciphertext_sha256 char(64)
    CHECK (ciphertext_sha256 IS NULL OR ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
  declared_bytes bigint NOT NULL CHECK (declared_bytes >= 0),
  verified_bytes bigint CHECK (verified_bytes IS NULL OR verified_bytes >= 0),
  operation text NOT NULL CHECK (operation IN ('create', 'replace', 'delete')),
  outcome text NOT NULL CHECK (outcome IN ('started', 'accepted', 'rejected', 'verified', 'failed')),
  rejection_category text CHECK (rejection_category IS NULL OR rejection_category IN (
    'quota_exceeded', 'upload_rate_exceeded', 'concurrency_exceeded',
    'object_count_exceeded', 'churn_exceeded', 'archive_expansion_limit',
    'invalid_payload', 'verification_failed'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (project_id, actor_id, idempotency_key),
  CHECK (verified_bytes IS NULL OR verified_bytes <= declared_bytes),
  CHECK (outcome NOT IN ('verified') OR (verified_bytes IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE INDEX project_storage_upload_events_actor_time
  ON project_storage_upload_events (actor_id, created_at DESC);

CREATE INDEX project_storage_upload_events_project_time
  ON project_storage_upload_events (project_id, created_at DESC);

CREATE INDEX project_storage_upload_events_project_outcome_time
  ON project_storage_upload_events (project_id, outcome, created_at DESC);

CREATE TABLE project_storage_upload_leases (
  upload_lease_id uuid PRIMARY KEY,
  project_id uuid NOT NULL
    REFERENCES zion_projects(project_id) ON DELETE RESTRICT,
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 256),
  declared_bytes bigint NOT NULL CHECK (declared_bytes >= 0),
  lease_status text NOT NULL DEFAULT 'active'
    CHECK (lease_status IN ('active', 'completed', 'cancelled', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (project_id, actor_id, idempotency_key),
  CHECK (expires_at > created_at),
  CHECK (lease_status <> 'completed' OR completed_at IS NOT NULL)
);

CREATE INDEX project_storage_upload_leases_live
  ON project_storage_upload_leases (project_id, expires_at)
  WHERE lease_status = 'active';

CREATE TABLE project_storage_quotas (
  quota_id uuid PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('project', 'owner', 'node')),
  scope_id text NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 128),
  max_unique_bytes bigint NOT NULL CHECK (max_unique_bytes >= 0),
  max_objects bigint NOT NULL CHECK (max_objects >= 0),
  max_uploads_per_hour integer NOT NULL CHECK (max_uploads_per_hour > 0),
  max_concurrent_uploads integer NOT NULL CHECK (max_concurrent_uploads > 0),
  max_churn_events_per_hour integer NOT NULL CHECK (max_churn_events_per_hour > 0),
  max_archive_expansion_ratio integer NOT NULL
    CHECK (max_archive_expansion_ratio BETWEEN 1 AND 1000),
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id)
);

CREATE TABLE project_storage_usage_audit (
  audit_id uuid PRIMARY KEY,
  project_id uuid NOT NULL
    REFERENCES zion_projects(project_id) ON DELETE RESTRICT,
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  node_id char(64) CHECK (node_id IS NULL OR node_id ~ '^[a-f0-9]{64}$'),
  verified_unique_bytes bigint NOT NULL CHECK (verified_unique_bytes >= 0),
  active_object_count bigint NOT NULL CHECK (active_object_count >= 0),
  active_upload_count integer NOT NULL CHECK (active_upload_count >= 0),
  churn_events_last_hour integer NOT NULL CHECK (churn_events_last_hour >= 0),
  evidence_sha256 char(64) NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  audited_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_storage_usage_audit_by_project_time
  ON project_storage_usage_audit (project_id, audited_at DESC);

COMMIT;
