-- Zion peer-admission schema, migration 0001.
-- This schema is inert until a reviewed adapter executes all admission writes
-- in one PostgreSQL transaction. Do not point the file-backed controller at it.
BEGIN;

CREATE TABLE peer_admission_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  max_active_peers integer NOT NULL CHECK (max_active_peers > 0),
  max_admissions_per_issuer integer NOT NULL CHECK (max_admissions_per_issuer > 0),
  min_storage_headroom_ratio double precision NOT NULL
    CHECK (min_storage_headroom_ratio >= 0 AND min_storage_headroom_ratio <= 1),
  policy_version bigint NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE peer_admission_capacity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_reservations integer NOT NULL DEFAULT 0
    CHECK (active_reservations >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE peer_admissions (
  subject_node_id char(64) PRIMARY KEY
    CHECK (subject_node_id ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released', 'revoked')),
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE peer_admission_issuers (
  subject_node_id char(64) NOT NULL
    REFERENCES peer_admissions(subject_node_id) ON DELETE CASCADE,
  issuer_node_id char(64) NOT NULL
    CHECK (issuer_node_id ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (subject_node_id, issuer_node_id)
);

CREATE INDEX peer_admission_issuers_by_issuer
  ON peer_admission_issuers (issuer_node_id, subject_node_id);

CREATE TABLE consumed_peer_invitations (
  issuer_node_id char(64) NOT NULL
    CHECK (issuer_node_id ~ '^[a-f0-9]{64}$'),
  nonce char(32) NOT NULL
    CHECK (nonce ~ '^[a-f0-9]{32}$'),
  subject_node_id char(64) NOT NULL
    REFERENCES peer_admissions(subject_node_id)
    DEFERRABLE INITIALLY DEFERRED,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer_node_id, nonce)
);

-- One row per database. The application must lock policy/capacity rows before
-- checking quotas and must update active_reservations in the same transaction.
INSERT INTO peer_admission_policy (
  singleton, max_active_peers, max_admissions_per_issuer,
  min_storage_headroom_ratio, policy_version
) VALUES (true, 100, 5, 0.1, 1);

INSERT INTO peer_admission_capacity (singleton, active_reservations)
VALUES (true, 0);

COMMIT;
