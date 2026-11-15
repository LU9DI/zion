# Trusted checkpoint and validator-set synchronization specification

**Status:** design specification and upstream source audit; no light-client runtime, trust registry, checkpoint service, or consensus integration implemented  
**Scope:** PR #68, branch `architecture/fully-decentralized-core`  
**Upstream reference:** CometBFT `v0.38.26`  
**Date:** 2026-11-15

## 1. Purpose

Specify how a Zion node that is new, restored, or returning after a long offline period can establish which project history and validator set it is allowed to trust, then verify subsequent committed state without treating peer discovery, one RPC endpoint, or a hosted service as an authority.

This document is deliberately engine-neutral at the product level. CometBFT-specific behavior below is a compatibility study, not an adoption decision.

## 2. Security conclusion: synchronization is not trust bootstrap

A light client can verify a chain of signed headers and validator-set transitions only after it has an authenticated starting trust anchor. Signatures prove that keys signed; they do not prove that the keys are the legitimate initial committee or that the chain belongs to the intended Zion project.

The CometBFT v0.38.26 `light.TrustOptions` API makes this explicit: initialization requires a trusting period, a trusted height, and a trusted header hash. Its source comment says the height/hash are expected from a trusted source (examples include a validator, friend, or secure website). The light client fetches the header at that height, checks that its hash exactly matches the supplied hash, verifies more than two-thirds of that header's validator voting power, cross-checks the same initial light block with witnesses, and only then stores it as trusted.

Therefore:
- Asking several arbitrary peers for a checkpoint and accepting their majority is not a trustless bootstrap. An attacker can Sybil the sample or eclipse the new node.
- A DHT record, DNS answer, website, GitHub branch, RPC response, TLS certificate, or peer ACK is a delivery mechanism, not proof that the checkpoint is the intended project's checkpoint.
- Several endpoints operated by the same person, organization, cloud account, or upstream provider are not independent witnesses.
- A fresh node cannot infer the authentic project history from an unauthenticated peer network alone. It needs an authenticated genesis/trust anchor supplied through an explicitly accepted trust process.
- If no trustworthy anchor or safe recovery path is available, the node must remain untrusted and refuse security-critical writes.

This is a fundamental trust assumption to disclose, not a defect that can be eliminated by adding more peers.

## 3. Trust-anchor object and acceptance

The project must define a canonical, versioned trust-anchor package. At minimum it binds:

- network/project identifier and canonical genesis-manifest digest;
- protocol, state-machine, and consensus-engine versions;
- trusted signed-header height and header hash;
- validator-set hash and the exact validator-set data needed to verify the header;
- the genesis/governance epoch and the authenticated authorization record for that validator set;
- the checkpoint creation/observation metadata needed to apply freshness policy;
- signature suite and canonical encoding version;
- the signatures/authorization evidence required by the project's genesis and checkpoint policy.

The trust-anchor package must be authenticated against the project's already accepted genesis/governance trust policy. A package's self-declared project ID or its own signatures are not enough unless the signing keys are independently bound to the accepted genesis.

### 3.1 First network genesis

The existing [Project Genesis and Validator Rotation specification](PROJECT_GENESIS_AND_VALIDATOR_ROTATION_SPEC.md) remains the authority for the human trust ceremony. Its genesis manifest binds the initial governance keys/threshold, initial validator keys and weights (if initialized), protocol versions, control-domain disclosures, initial state digest, epochs, and recovery policy.

Before joining, a new node must:
1. obtain the exact canonical genesis manifest and its digest;
2. validate canonical encoding, schema/version, project ID, cryptographic suites, thresholds, duplicate-key rules, and all required proof-of-possession material;
3. verify the required distinct governor signatures over the same manifest digest and domain separator;
4. authenticate the manifest digest through the project's declared independent verification procedure (for example, direct fingerprint comparison or a multi-party out-of-band process); and
5. retain the accepted manifest and signature evidence locally.

The repository owner, GitHub release, a single website, a seed peer, or a single governor must not silently become the sole trust root. The existing genesis ceremony does not cryptographically prove real-world operator independence; the project must disclose that limitation.

### 3.2 Later checkpoints

A later checkpoint must be linked to the accepted genesis by a verifiable chain of committed validator-set transitions and signed headers, or by a separately defined threshold-authorized checkpoint certificate that is explicitly part of the project protocol.

A checkpoint advertised by one validator is not automatically trustworthy. A snapshot or state database copied from an outgoing validator must be checked against the authenticated checkpoint and verified history. State bytes without a matching authenticated state root and proof are not sufficient.

Checkpoint signatures from a quorum do not independently prove the checkpoint is the canonical history if the signer set itself is not authenticated against the prior trusted state. Do not verify a new committee by using that new committee's own unanchored claim that it is the new committee.

## 4. Validator-set transition verification

For a CometBFT-style light client, the following exact v0.38.26 behaviors were inspected:

- The default skipping trust level is 1/3. For a non-adjacent target header, the light verifier requires at least the configured trust fraction of the previously trusted validator voting power to have signed the target header, and more than two-thirds of the target validator set to have committed it.
- The light client uses a bisection/trust-path procedure when the distant validator set does not overlap sufficiently with the last trusted set. It fetches intermediate light blocks until it can establish a valid trust path or fails.
- For adjacent headers, the next-validator hash in the trusted header must equal the validator-set hash supplied for the next header, and more than two-thirds of that next set must have signed the new header.
- The target header must have the expected chain ID, valid structure, strictly increasing height/time, a validator hash matching the supplied validator set, and a timestamp no further into the future than the configured maximum clock drift.
- A non-adjacent verification fails when the last trusted header has expired under the configured trusting period.

These are light-client verification rules, not a substitute for safe validator reconfiguration. The project's consensus engine and governance state machine must already enforce the safe committee handoff rules in [Project Genesis and Validator Rotation](PROJECT_GENESIS_AND_VALIDATOR_ROTATION_SPEC.md). A mathematically valid signature set for an unauthorized validator set must not become authorized merely because its signatures verify.

### 4.1 No arbitrary committee replacement

A validator-set change is accepted only when it is derived from the previously trusted state by the selected protocol's committed transition rules. The verifier must bind:
- prior project state digest and validator epoch;
- exact old and new validator public keys and voting weights;
- effective height/epoch and consensus protocol version;
- the authorization and quorum evidence for the transition;
- any DKG/resharing transcript digest if the selected engine requires threshold keys.

Old-epoch votes, stale certificates, replayed transitions, duplicate validators, malformed weights, invalid thresholds, and conflicting transition histories must be rejected.

## 5. Freshness, offline recovery, and clock assumptions

CometBFT's `TrustOptions.Period` is not an arbitrary convenience timeout. Its source documentation says the trusting period should be significantly shorter than the validator unbonding period, leaving time to verify headers and report/punish misbehavior. The verifier rejects a trusted header once `header.Time + trustingPeriod` is no longer after the verifier's current time.

Consequences for Zion:
- A node that returns after the trusting period cannot simply continue trusting the old checkpoint and fast-forward through peers. It needs a new authenticated checkpoint under the project's checkpoint/recovery policy.
- The new checkpoint must be authenticated independently; refreshing the timestamp or trusting period locally does not renew trust.
- A node must not silently reset its trust anchor to whatever a current RPC endpoint reports.
- If the project cannot provide a safe, authenticated refresh checkpoint, the node remains read-only/untrusted for security-critical operations until the recovery procedure succeeds.
- Local clock assumptions and maximum future drift must be explicit and tested. Clock rollback, severe skew, or unavailable trustworthy time must not cause the node to accept expired or future-dated checkpoints.
- Trusting period, validator unbonding/exit delay, evidence retention, and misbehavior-reporting windows must be chosen together for the selected engine. No numeric value is selected here.

A node that has been offline beyond the safe trust window is a recovery case, not an ordinary peer synchronization case.

## 6. Witnesses, eclipse resistance, and provider diversity

CometBFT v0.38.26's light client requires at least one witness when using its default skipping mode. Its source documents the correctness assumption that at least one full node among the primary and witnesses is correct. Witnesses cross-check the primary's light blocks and can expose conflicting histories; they do not create the initial trust anchor and they do not prove that the providers are independent.

Zion's provider policy must:
- use multiple witnesses where available and require at least one witness for the selected skipping-verification profile;
- prefer independently operated providers across distinct organizations/control domains, networks, and geographic/failure domains;
- treat provider count, IP diversity, or distinct keys as weak signals, not proof of operator independence;
- limit per-domain witness concentration and rotate providers to reduce eclipse exposure;
- detect and retain conflicting signed headers and validator evidence for investigation;
- fail closed on a conflicting verified header rather than choose whichever endpoint has the most responses;
- bound concurrent witness requests, response sizes, retries, timeouts, and signature-verification work to prevent light-client DoS;
- never let an untrusted witness alter the trusted checkpoint, validator membership, or governance state.

If all witnesses are unreachable, the client may retry or change transport peers, but it must not downgrade to trusting an unverified primary response. A provider's failure to respond is not evidence that another provider's history is canonical.

## 7. Local trusted-store integrity and rollback

A light client must persist its latest trusted light block and validator set locally. Zion must additionally bind the stored checkpoint to the accepted genesis digest, project ID, chain ID, verification profile, and software/protocol version.

Required protections:
- atomic, crash-safe writes of trusted header, validator set, trust metadata, and monotonic height;
- integrity checks and bounded parsing on every load;
- no-follow/path-safe file handling and restrictive local permissions;
- reject a stored height that regresses relative to any independently retained high-water checkpoint;
- retain enough authenticated transition/checkpoint evidence to recover after ordinary process restart;
- make backup/restore procedures preserve the trusted height/hash and clearly identify a restored older snapshot.

A local file hash or MAC whose key is stored beside the file does not prevent an attacker from rolling back both. Without a hardware-backed monotonic counter or an independent external checkpoint, software-only local storage cannot prove that the entire trusted store has not been rolled back. Zion must not claim rollback resistance beyond its actual platform assumptions.

If a node detects a lower trusted height, conflicting same-height hash, mismatched genesis digest, corrupted store, or unexplained validator-set regression, it must quarantine the local trust state and enter explicit recovery. It must not overwrite the higher checkpoint with a peer-supplied lower state.

## 8. Snapshot/state synchronization

Bulk state synchronization and consensus trust verification are separate operations.

A snapshot is acceptable only if:
1. its project/network ID and application/state-machine version match the accepted genesis and local compatibility policy;
2. its height and application state root are bound to a trusted signed header/checkpoint;
3. the snapshot provider supplies verifiable chunk/manifest proofs or the receiver recomputes and checks the complete state root using the canonical state encoding;
4. the snapshot is followed by a verified header/commit path from that checkpoint to a sufficiently fresh height;
5. the application replay/recovery contract is satisfied, including the block-store/application-store boundary described in [the ABCI commit audit](COMETBFT_0_38_26_ABCI_COMMIT_CONTRACT_AUDIT.md);
6. untrusted snapshot bytes are parsed under strict size, depth, time, disk, and CPU limits.

A snapshot is an optimization for state transfer, not an authority. A single peer's database dump, signed transport ACK, matching filename, or claimed height does not establish validity. If the snapshot cannot be proven to correspond to the authenticated state root, discard it and synchronize from a verified source or remain unavailable.

## 9. Fail-closed state machine

A node should expose explicit trust states rather than a single connected/healthy boolean:

- **UNINITIALIZED:** no authenticated genesis/trust anchor; no project-critical reads/writes.
- **GENESIS_AUTHENTICATED:** canonical genesis and required signatures/out-of-band verification accepted; initial checkpoint still pending.
- **CHECKPOINT_VERIFIED:** signed header and validator set verified against the accepted anchor; state sync may proceed.
- **SYNCING:** downloading bounded snapshot/log data; no security-critical mutations.
- **CURRENT_TRUSTED:** state root and committed history verified and checkpoint within freshness policy; critical operations may be considered subject to live quorum checks.
- **STALE_TRUST:** trusting period expired or fresh checkpoint unavailable; critical writes stop.
- **CONFLICT_QUARANTINE:** conflicting valid histories, rollback, malformed transition, or trust-store integrity failure detected; no automatic resolution.
- **RECOVERY_REQUIRED:** precommitted recovery ceremony or explicit re-genesis required.

Network reachability must never promote a node's trust state. Only successful verification of the required cryptographic and committed-state evidence may do so.

## 10. Required adversarial tests

Before implementation approval, test at least:

1. Fresh node receives a forged genesis manifest signed by arbitrary peer keys.
2. Same genesis name/chain ID but different manifest digest or initial validator set.
3. A malicious primary supplies a false checkpoint while all witnesses are unreachable.
4. Multiple witness endpoints share one operator/control domain and collude.
5. Eclipse attacker controls all discovered peers but not the authenticated genesis trust process.
6. Valid old-set signatures below the required trust fraction; valid target-set signatures below two-thirds.
7. Adjacent validator hash does not match the previous header's next-validator hash.
8. Non-adjacent rotation requires bisection; malicious intermediate validator set or conflicting trust path.
9. Expired trusting period after extended offline operation; forged "fresh" checkpoint from an unauthenticated source.
10. Future timestamp, local clock rollback/skew, and max-clock-drift boundary.
11. Rollback of local trusted store and restore of an older backup.
12. Snapshot has correct metadata but wrong state root; snapshot root matches but subsequent commit path is invalid.
13. Provider response floods, huge validator sets, malformed proofs, slowloris, retry amplification, and witness exhaustion.
14. Crash during checkpoint persistence and during snapshot installation.
15. Conflicting valid signed headers trigger quarantine and preserve both evidence sets.
16. New validator committee cannot reach quorum during handoff; no old/new split-brain or local fallback.

Test operator/control-domain compromise separately from key compromise. Test vectors must cover canonical manifest, checkpoint, validator transition, and state-root encodings across all supported implementations.

## 11. Existing decisions and unresolved gates

Already recorded in the repository:
- Validator membership is project-permissioned by project threshold governance; Zion does not currently require permissionless validator admission.
- Zion does not select a token, mining, stake, proof-of-personhood provider, centralized identity service, or mandatory hardware attestation for the current scope.
- The genesis/governor trust ceremony and non-invasive operator-independence evidence remain unresolved.
- The BFT engine, committee size/threshold, random beacon, DKG/resharing, and production topology remain unselected.
- A project committee is not a Zion-wide admission committee. The global first-1,000 invitation semantics remain blocked by the separate admission-scope decision.

This specification does not resolve those gates by assumption.

## 12. Exact upstream source audit

Inspected the CometBFT `v0.38.26` tag:
- `light/trust_options.go`: trust-anchor inputs and requirement to obtain height/hash from a trusted source; trusting-period relationship to unbonding and evidence windows.
- `light/client.go`: initial checkpoint hash equality, >2/3 initial commit verification, witness comparison, persisted trusted light block, skipping/sequential modes, witness requirements, and trust-path bisection.
- `light/verifier.go`: adjacent/non-adjacent verification, validator overlap trust level, >2/3 target commit, chain/time/hash checks, and trusted-header expiration.
- `light/store/db/db.go`: local light-block persistence implementation.
- `spec/light-client/README.md`: light-client verification protocol and TLA+ model-checking materials.

Useful upstream references:
- [Trust options](https://github.com/cometbft/cometbft/blob/v0.38.26/light/trust_options.go)
- [Light client](https://github.com/cometbft/cometbft/blob/v0.38.26/light/client.go)
- [Light verifier](https://github.com/cometbft/cometbft/blob/v0.38.26/light/verifier.go)
- [Light-client specification](https://github.com/cometbft/cometbft/tree/v0.38.26/spec/light-client)
- [Genesis and validator rotation requirements in Zion](PROJECT_GENESIS_AND_VALIDATOR_ROTATION_SPEC.md)
- [Validator Sybil model in Zion](DECENTRALIZED_VALIDATOR_SYBIL_MODEL.md)

## 13. Explicit non-claims

- This does not select or integrate CometBFT.
- No Zion trust-anchor format, checkpoint registry, light client, witness network, snapshot verifier, or rollback-resistant store is implemented.
- No genesis ceremony has been conducted and no real operator independence has been verified.
- No BFT safety/liveness, Sybil resistance, checkpoint availability, or trustless bootstrap is proven.
- This does not resolve Zion-wide invitation consensus.
- No runtime, dependency, launcher, database, migration, secret, CI workflow, or deployment is changed by this specification.
