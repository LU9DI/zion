# Integrity Guard and quarantine contract

## Goal

Detect release-file modification against a signed Ed25519 manifest and fail closed for critical operations. This is defense-in-depth; it is not secure boot and cannot defend against a fully privileged host attacker by itself.

## Quarantine behavior

When manifest verification fails, the `IntegrityGuard` enters a one-way quarantine state for the lifetime of that instance. Re-running verification does not clear it. Subsystems can register with `addQuarantineListener(listener)` and are notified after the guard marks itself quarantined. Listener failures do not clear quarantine.

`PeerStorageService` uses this hook to overwrite temporary transfer-part buffers on a best-effort basis, clear incomplete transfers and buffered-byte accounting, and reject pending downloads. The service also checks integrity before inbound handling, outbound chunk send/fetch, storage commit/read-back receipt flow, and contribution-credit refresh. Contribution credit is not applied unless integrity is still healthy after the inventory audit.

Persisted encrypted chunks are not automatically deleted. Destruction would create an easy denial-of-service path and would not prevent an attacker from modifying other nodes. Recover from a trusted, signed release and verify before rejoining.

## Release signing and trust configuration

1. Generate the Ed25519 release-signing key offline and keep the private key out of source control.
2. Sign an explicit list of critical release files using `npm run manifest:sign -- <version> <relative-file>...` with `ZION_RELEASE_SIGNING_KEY` set to the offline key path.
3. Provision the signed manifest and the matching public key independently of the files being checked. Pin the expected release version and required critical paths in deployment configuration.
4. Protect the installation directory and trust configuration using OS permissions and, where available, verified boot or an independently privileged supervisor.
5. Exercise tamper, quarantine, recovery, and reboot tests before production use.

The manifest does not authenticate itself if an attacker can replace both the manifest and the trusted public key. Buffer overwriting is best-effort and cannot erase copies held by the runtime, kernel, or transport.

## Immediate transport isolation (v0.32.11)

`PeerTransport` in `networkMode: 'official'` registers an IntegrityGuard quarantine listener. The callback destroys all established sockets, clears the local connection set, stops accepting new connections, and marks the transport as stopped. `close()` unregisters the listener. This avoids relying on a future message to trigger the integrity check. Listener callbacks must remain local and non-blocking; an external supervisor is still required to enforce process-level isolation if the JavaScript runtime itself is compromised.

## Operator-approved recovery controller (v0.32.10)

`IntegrityRecoveryController` coordinates recovery without pretending that the compromised process can securely repair itself. The node is first isolated; a specific release version and SHA-256 digest are pinned; the release provider stages the candidate; an independent verifier must confirm both signature and digest using trust material outside the node; a separate operator authorization is required; and the candidate is verified again immediately before the injected installer runs. A successful install requires a restart and does not clear the original `IntegrityGuard` quarantine in place.

The provider, verifier, installer, operator authorizer, and node controller are explicit adapters. Production deployment must implement them with an out-of-process supervisor or trusted OS/package manager. The included controller is orchestration logic, not a standalone secure updater. Audit sink failures do not authorize recovery. Failed staging or installation leaves the controller in `FAILED`; persisted user data is not deleted.

## Three-node isolation validation (v0.32.12)

The regression suite models three independent official-mode transports. When the middle node's integrity guard enters quarantine, its listener and established peer sessions are closed; the two healthy nodes retain their separate direct session and can still exchange a signed protocol message. This is an in-process TCP integration test, not a deployment test across separate hosts, NATs, or a public DHT.

## Independent-process isolation test

The integration test `test/three-node-process-isolation.test.js` starts three independent Node.js child processes with separate identities and TCP listeners. It establishes A→B, C→B, and A→C sessions, quarantines B, then verifies B's listener and sessions are closed while A and C remain healthy and can exchange an authenticated PING. This is a local process-isolation test; it does not substitute for testing separate hosts, NAT, relays, or public DHT behavior.

## Fail-closed official startup (v0.32.19)

`OfficialNodeBootstrap` runs the release manifest verification before storage startup, checks the guard again before binding the official transport, and rolls back storage if integrity changes or the network bind fails. It refuses incomplete guards and transports not explicitly configured with `networkMode: 'official'`. The deployment must still provision the manifest and pinned public key independently of the mutable application directory. This orchestration does not defend against a compromised runtime or privileged host; use an independently trusted service manager / OS controls for that boundary.
