import { verifyNotificationRecoveryAnchorFreshnessWitness } from './notification-recovery-anchor-freshness-witness.js';

/** Verify a threshold of distinct independently provisioned freshness witnesses. */
export function verifyNotificationRecoveryAnchorFreshnessQuorum({ witnesses, threshold, expectedHistoryHeadSha256, now = Date.now(), maxAgeMs = 300_000 } = {}) {
  const invalid = (code, extra = {}) => ({ valid: false, code, verifiedCount: 0, threshold: Number.isSafeInteger(threshold) ? threshold : null, ...extra });
  if (!Array.isArray(witnesses) || witnesses.length < 1 || !Number.isSafeInteger(threshold) || threshold < 1 || threshold > witnesses.length) return invalid('quorum-configuration-invalid');
  const witnessIds = new Set();
  const keyIds = new Set();
  for (const entry of witnesses) {
    const witness = entry?.witness;
    const keyId = entry?.expectedWitnessKeyId ?? witness?.witnessKeyId;
    if (!witness || typeof keyId !== 'string' || !keyId || witnessIds.has(witness.witnessId) || keyIds.has(keyId)) return invalid('quorum-membership-duplicate-or-malformed');
    witnessIds.add(witness.witnessId);
    keyIds.add(keyId);
  }
  const results = witnesses.map(entry => {
    const result = verifyNotificationRecoveryAnchorFreshnessWitness({
      witness: entry.witness,
      publicKey: entry.publicKey,
      expectedWitnessKeyId: entry.expectedWitnessKeyId,
      expectedHistoryHeadSha256,
      now,
      maxAgeMs,
      minimumSequence: entry.minimumSequence ?? 1
    });
    return { witnessId: entry.witness?.witnessId ?? null, witnessKeyId: entry.expectedWitnessKeyId ?? entry.witness?.witnessKeyId ?? null, ...result };
  });
  const accepted = results.filter(result => result.valid);
  const distinctHeads = new Set(accepted.map(result => result.historyHeadSha256));
  if (distinctHeads.size > 1) return invalid('quorum-head-divergence', { results, verifiedCount: accepted.length });
  if (accepted.length < threshold) return invalid('quorum-threshold-not-met', { results, verifiedCount: accepted.length });
  return { valid: true, code: 'quorum-verified', threshold, configuredCount: witnesses.length, verifiedCount: accepted.length, witnessIds: accepted.map(result => result.witnessId), witnessKeyIds: accepted.map(result => result.witnessKeyId), sequenceMinimum: Math.min(...accepted.map(result => result.sequence)), sequenceMaximum: Math.max(...accepted.map(result => result.sequence)), historyHeadSha256: expectedHistoryHeadSha256, results };
}
