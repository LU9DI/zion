-- Zion project lifecycle, storage leases, and anti-abuse accounting.
-- This migration adds durable policy state only. Runtime enforcement remains
-- disabled until the project service, scheduler, storage adapters, and tests
-- are integrated and reviewed.
BEGIN;

CREATE TABLE zion_projects (
  project_id uuid PRIMARY KEY,
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  lifecycle_status text NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'paused', 'storage_release_pending', 'storage_released')),
  last_meaningful_activity_at timestamptz NOT NULL DEFAULT now(),
  paused_at timestamptz,
  storage_released_at timestamptz,
  policy_version bigint NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (paused_at IS NULL OR paused_at >= created_at),
  CHECK (storage_released_at IS NULL OR storage_released_at >= created_at),
  CHECK (lifecycle_status <> 'storage_released' OR storage_released_at IS NOT NULL)
);

CREATE INDEX zion_projects_by_inactivity
  ON zion_projects (last_meaningful_activity_at, project_id)
  WHERE lifecycle_status IN ('active', 'paused', 'storage_release_pending');

CREATE TABLE project_activity_events (
  event_id uuid PRIMARY KEY,
  project_id uuid NOT NULL
    REFERENCES zion_projects(project_id) ON DELETE RESTRICT,
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  actor_kind text NOT NULL CHECK (actor_kind IN ('owner', 'collaborator')),
  activity_type text NOT NULL CHECK (activity_type IN (
    'upload_committed',
    'file_replaced',
    'download_completed',
    'restore_completed',
    'configuration_committed',
    'source_change_committed',
    'user_operation_committed'
  )),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 256),
  source_node_id char(64)
    CHECK (source_node_id IS NULL OR source_node_id ~ '^[a-f0-9]{64}$'),
  object_sha256 char(64)
    CHECK (object_sha256 IS NULL OR object_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, actor_id, idempotency_key)
);

CREATE INDEX project_activity_events_by_project_time
  ON project_activity_events (project_id, recorded_at DESC);

CREATE TABLE project_storage_leases (
  lease_id uuid PRIMARY KEY,
  project_id uuid NOT NULL
    REFERENCES zion_projects(project_id) ON DELETE RESTRICT,
  node_id char(64) NOT NULL CHECK (node_id ~ '^[a-f0-9]{64}$'),
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes >= 0),
  lease_status text NOT NULL DEFAULT 'reserved'
    CHECK (lease_status IN ('reserved', 'active', 'release_pending', 'released')),
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  released_at timestamptz,
  CHECK (expires_at IS NULL OR expires_at > issued_at),
  CHECK (released_at IS NULL OR released_at >= issued_at),
  CHECK (lease_status <> 'released' OR released_at IS NOT NULL)
);

CREATE UNIQUE INDEX project_storage_leases_one_live_node_project
  ON project_storage_leases (project_id, node_id)
  WHERE lease_status IN ('reserved', 'active', 'release_pending');

CREATE INDEX project_storage_leases_by_node_status
  ON project_storage_leases (node_id, lease_status, project_id);

CREATE TABLE project_storage_usage (
  project_id uuid NOT NULL
    REFERENCES zion_projects(project_id) ON DELETE RESTRICT,
  node_id char(64) NOT NULL CHECK (node_id ~ '^[a-f0-9]{64}$'),
  verified_unique_bytes bigint NOT NULL CHECK (verified_unique_bytes >= 0),
  object_count bigint NOT NULL CHECK (object_count >= 0),
  audit_sha256 char(64) NOT NULL CHECK (audit_sha256 ~ '^[a-f0-9]{64}$'),
  audited_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, node_id)
);

CREATE TABLE project_resource_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  pause_after_seconds integer NOT NULL DEFAULT 604800
    CHECK (pause_after_seconds = 604800),
  release_after_seconds integer NOT NULL DEFAULT 1296000
    CHECK (release_after_seconds = 1296000),
  policy_version bigint NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pause_after_seconds < release_after_seconds)
);

INSERT INTO project_resource_policy (
  singleton, pause_after_seconds, release_after_seconds, policy_version
) VALUES (true, 604800, 1296000, 1);

CREATE TABLE project_resource_events (
  event_id uuid PRIMARY KEY,
  project_id uuid NOT NULL
    REFERENCES zion_projects(project_id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN (
    'project_paused',
    'storage_release_pending',
    'storage_released',
    'project_reactivated',
    'capacity_reacquired'
  )),
  actor_id text,
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_resource_events_by_project_time
  ON project_resource_events (project_id, recorded_at DESC);

CREATE TABLE project_abuse_events (
  abuse_event_id uuid PRIMARY KEY,
  project_id uuid
    REFERENCES zion_projects(project_id) ON DELETE RESTRICT,
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  category text NOT NULL CHECK (category IN (
    'duplicate_upload_burst',
    'object_churn',
    'quota_exceeded',
    'upload_rate_exceeded',
    'reservation_without_verified_usage',
    'archive_expansion_limit',
    'protocol_violation'
  )),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'high', 'critical')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'triaged', 'dismissed', 'enforced')),
  evidence_sha256 char(64)
    CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

CREATE INDEX project_abuse_events_by_actor_time
  ON project_abuse_events (actor_id, created_at DESC);

CREATE INDEX project_abuse_events_open_by_project
  ON project_abuse_events (project_id, severity, created_at DESC)
  WHERE status IN ('open', 'triaged');

COMMIT;
