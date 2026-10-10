const STAGES = Object.freeze(['paused', 'pilot', 'cohort', 'scale']);

const DEFAULT_CAPS = Object.freeze({
  paused: 0,
  pilot: 25,
  cohort: 100,
  scale: 500,
});

/**
 * Explicit, operator-controlled rollout gate. Every stage still uses the normal
 * voucher checks; advancing a stage never disables invite-only admission.
 * This is a local policy, not a distributed/global network-wide cap.
 */
export class AdmissionRolloutPolicy {
  constructor({ stage = 'pilot', caps = DEFAULT_CAPS } = {}) {
    if (!STAGES.includes(stage) || !caps || typeof caps !== 'object') {
      throw new TypeError('Invalid admission rollout configuration');
    }
    const normalized = {};
    for (const name of STAGES) {
      const cap = caps[name];
      if (!Number.isSafeInteger(cap) || cap < 0 || (name !== 'paused' && cap < 1)) {
        throw new TypeError('Every rollout stage requires a valid non-negative integer cap');
      }
      normalized[name] = cap;
    }
    this.stage = stage;
    this.caps = Object.freeze(normalized);
  }

  setStage(stage) {
    if (!STAGES.includes(stage)) throw new TypeError('Unknown admission rollout stage');
    this.stage = stage;
    return this.snapshot();
  }

  evaluate(capacity) {
    if (!capacity || !Number.isSafeInteger(capacity.activePeers) || capacity.activePeers < 0) {
      return Object.freeze({ allowed: false, reason: 'capacity-unavailable', stage: this.stage });
    }
    const stageCap = this.caps[this.stage];
    if (this.stage === 'paused' || stageCap === 0) {
      return Object.freeze({ allowed: false, reason: 'rollout-paused', stage: this.stage, stageCap });
    }
    if (capacity.activePeers >= stageCap) {
      return Object.freeze({ allowed: false, reason: 'rollout-stage-cap-reached', stage: this.stage, stageCap });
    }
    return Object.freeze({ allowed: true, reason: 'rollout-stage-open', stage: this.stage, stageCap });
  }

  snapshot() {
    return Object.freeze({ stage: this.stage, stageCap: this.caps[this.stage] });
  }
}

export const ADMISSION_ROLLOUT_STAGES = STAGES;
