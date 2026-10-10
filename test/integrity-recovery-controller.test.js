import test from 'node:test';
import assert from 'node:assert/strict';
import { IntegrityRecoveryController } from '../src/integrity-recovery-controller.js';

const releaseVersion = '0.32.10';
const digest = 'a'.repeat(64);
function fixture(overrides = {}) {
  const events = [];
  const guard = { status: { quarantined: true, reason: 'hash-mismatch:src/peer-transport.js' }, assertHealthy() { throw new Error('quarantined'); } };
  const nodeController = { async stopNetworkOperations(v) { events.push(['stop', v]); }, async requireRestart(v) { events.push(['restart', v]); } };
  const candidate = { releaseVersion, digest, stagingHandle: 'opaque-staging-handle' };
  const verifier = { async verifyStagedRelease() { return { ok: true, releaseVersion, digest, signatureVerified: true, trustRootIndependent: true }; } };
  const controller = new IntegrityRecoveryController({
    integrityGuard: guard,
    releaseProvider: { async fetchApprovedRelease() { return candidate; } },
    releaseVerifier: verifier,
    releaseInstaller: { async installVerifiedRelease() { events.push(['install']); return { ok: true, releaseVersion, digest }; } },
    operatorAuthorizer: { async authorizeRecovery() { return true; } },
    nodeController,
    audit: async event => events.push(['audit', event.event]),
    ...overrides,
  });
  return { controller, events, guard };
}

test('requires quarantine before starting recovery', async () => {
  const f = fixture(); f.guard.status.quarantined = false;
  await assert.rejects(f.controller.begin(), /only begin after integrity quarantine/);
});

test('requires staged signature verification and explicit operator approval before install', async () => {
  const f = fixture({ operatorAuthorizer: { async authorizeRecovery() { return false; } } });
  await f.controller.begin();
  await f.controller.stage({ releaseVersion, expectedDigest: digest });
  assert.equal(f.controller.status.state, 'STAGED');
  await assert.rejects(f.controller.install(), /expected APPROVED/);
  await assert.rejects(f.controller.approve({ operatorId: 'operator-1', authorization: 'ticket-123' }), /not authorized/);
});

test('installs only the exact reverified release and requires restart', async () => {
  const f = fixture();
  await f.controller.begin();
  await f.controller.stage({ releaseVersion, expectedDigest: digest });
  await f.controller.approve({ operatorId: 'operator-1', authorization: 'change-123' });
  const result = await f.controller.install();
  assert.equal(result.state, 'RESTART_REQUIRED');
  assert.equal(result.restartRequired, true);
  assert.equal(f.events.filter(e => e[0] === 'install').length, 1);
  assert.equal(f.events.filter(e => e[0] === 'restart').length, 1);
});

test('fails closed when staged release no longer verifies immediately before install', async () => {
  let calls = 0;
  const f = fixture({ releaseVerifier: { async verifyStagedRelease() {
    calls++;
    return calls === 1 ? { ok: true, releaseVersion, digest, signatureVerified: true, trustRootIndependent: true }
      : { ok: false, releaseVersion, digest, signatureVerified: false, trustRootIndependent: true };
  } } });
  await f.controller.begin();
  await f.controller.stage({ releaseVersion, expectedDigest: digest });
  await f.controller.approve({ operatorId: 'operator-1', authorization: 'change-123' });
  await assert.rejects(f.controller.install(), /changed or lost trust/);
  assert.equal(f.controller.status.state, 'FAILED');
  assert.equal(f.events.some(e => e[0] === 'install'), false);
});

test('rejects mismatched release metadata from provider', async () => {
  const f = fixture({ releaseProvider: { async fetchApprovedRelease() { return { releaseVersion: '0.1.0', digest, stagingHandle: 'x' }; } } });
  await f.controller.begin();
  await assert.rejects(f.controller.stage({ releaseVersion, expectedDigest: digest }), /unexpected candidate/);
  assert.equal(f.controller.status.state, 'FAILED');
});
