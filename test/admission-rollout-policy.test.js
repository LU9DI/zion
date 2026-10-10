import test from 'node:test';
import assert from 'node:assert/strict';
import { AdmissionRolloutPolicy } from '../src/admission-rollout-policy.js';

test('pilot and cohort enforce stage-specific peer caps', () => {
  const policy = new AdmissionRolloutPolicy({ stage: 'pilot' });
  assert.equal(policy.evaluate({ activePeers: 24 }).allowed, true);
  assert.equal(policy.evaluate({ activePeers: 25 }).reason, 'rollout-stage-cap-reached');
  policy.setStage('cohort');
  assert.equal(policy.evaluate({ activePeers: 99 }).allowed, true);
  assert.equal(policy.evaluate({ activePeers: 100 }).allowed, false);
});

test('paused rollout fails closed and invalid stages are rejected', () => {
  const policy = new AdmissionRolloutPolicy({ stage: 'paused' });
  assert.equal(policy.evaluate({ activePeers: 0 }).reason, 'rollout-paused');
  assert.throws(() => policy.setStage('unbounded'), /Unknown admission rollout stage/);
});

test('invalid capacity and caps fail closed', () => {
  const policy = new AdmissionRolloutPolicy();
  assert.equal(policy.evaluate(null).reason, 'capacity-unavailable');
  assert.throws(() => new AdmissionRolloutPolicy({ caps: { paused: 0, pilot: -1, cohort: 100, scale: 500 } }), /valid non-negative integer cap/);
});
