import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { NotificationRecoveryAuditAnchor } from './notification-recovery-audit-anchor.js';
import { verifyNotificationRecoveryCheckpointChain } from './notification-recovery-checkpoint-chain-verifier.js';
import { validateNotificationRecoveryAnchorTrustPolicy } from './notification-recovery-anchor-trust-policy.js';
import { verifyNotificationRecoveryAnchorKeyRotation } from './notification-recovery-anchor-key-rotation.js';
import { verifyNotificationRecoveryAnchorKeyRevocations } from './notification-recovery-anchor-key-revocation.js';
import { verifyNotificationRecoveryAnchorFreshnessWitness } from './notification-recovery-anchor-freshness-witness.js';
import { verifyNotificationRecoveryAnchorFreshnessQuorum } from './notification-recovery-anchor-freshness-quorum.js';
import { verifyNotificationRecoveryAnchorWitnessChallengeResponse } from './notification-recovery-anchor-witness-challenge.js';

const issue = (code, detail) => ({ code, detail });

function inspectRegularJson(path) {
  let fd;
  try {
    // O_NOFOLLOW is not reliably enforced by Node.js on Windows; inspect the path first.
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) return { status: 'unsafe', issue: issue('SYMLINK_REFUSED', 'Symbolic links and non-regular files are not followed') };
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { status: 'unsafe', issue: issue('UNSAFE_FILE', 'Path is not a regular file') };
    const raw = readFileSync(fd, 'utf8');
    try { return { status: 'readable', value: JSON.parse(raw), bytes: Buffer.byteLength(raw), mode: stat.mode & 0o777 }; }
    catch { return { status: 'corrupt', issue: issue('INVALID_JSON', 'File is not valid JSON'), bytes: Buffer.byteLength(raw), mode: stat.mode & 0o777 }; }
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' };
    if (error.code === 'ELOOP') return { status: 'unsafe', issue: issue('SYMLINK_REFUSED', 'Symbolic links are not followed') };
    return { status: 'unreadable', issue: issue(error.code || 'READ_FAILED', error.message) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function inspectRegularText(path) {
  let fd;
  try {
    // O_NOFOLLOW is not reliably enforced by Node.js on Windows; inspect the path first.
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) return { status: 'unsafe', issue: issue('SYMLINK_REFUSED', 'Symbolic links and non-regular files are not followed') };
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { status: 'unsafe' };
    return { status: 'readable', value: readFileSync(fd, 'utf8'), bytes: stat.size, mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' };
    if (error.code === 'ELOOP') return { status: 'unsafe', issue: issue('SYMLINK_REFUSED', 'Symbolic links are not followed') };
    return { status: 'unreadable', issue: issue(error.code || 'READ_FAILED', error.message) };
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Read-only operational report. It never reclaims locks or deletes/rewrites evidence. */
export function inspectPersistentAnchorState({ anchorPath, historyPath, publicKeyPath, trustPolicyPath, rotationHistoryPath, revocationHistoryPath, revocationAuthorityPublicKeyPath, freshnessWitnessPath, freshnessPublicKeyPath, freshnessQuorumManifestPath, freshnessChallengeResponsePath, freshnessChallengeNonce, expectedWitnessKeyId, minimumWitnessSequence = 1, freshnessMaxAgeMs = 300_000, requireFreshnessWitness = false, expectedSignerKeyId, now = Date.now(), maxAgeMs = Infinity } = {}) {
  if (typeof anchorPath !== 'string' || !anchorPath.trim()) throw new TypeError('anchorPath is required');
  const canonicalPath = resolve(anchorPath);
  const directory = dirname(canonicalPath);
  const anchor = inspectRegularJson(canonicalPath);
  let checkpoint;
  if (anchor.status === 'missing') checkpoint = { state: 'absent', issue: null };
  else if (anchor.status === 'corrupt' || anchor.status === 'unsafe' || anchor.status === 'unreadable') checkpoint = { state: 'untrusted', issue: anchor.issue };
  else if (!NotificationRecoveryAuditAnchor.verifyCheckpointShape(anchor.value)) checkpoint = { state: 'untrusted', issue: issue('INVALID_CHECKPOINT_SHAPE', 'Checkpoint JSON does not match the expected structural schema') };
  else checkpoint = { state: 'visible_checkpoint', revision: anchor.value.revision, checkpointSha256: NotificationRecoveryAuditAnchor.checkpointSha256(anchor.value), durability: 'historical_durability_unknown' };

  const lockPath = `${canonicalPath}.lock`;
  const lock = inspectRegularJson(lockPath);
  let lockReport;
  if (lock.status === 'missing') lockReport = { state: 'absent', ownership: 'not_applicable' };
  else if (lock.status === 'readable' && lock.value && typeof lock.value === 'object' && !Array.isArray(lock.value)) {
    lockReport = { state: 'present', ownership: 'unknown', pid: Number.isSafeInteger(lock.value.pid) ? lock.value.pid : null, acquiredAt: Number.isFinite(lock.value.acquiredAt) ? lock.value.acquiredAt : null, tokenPresent: typeof lock.value.token === 'string' && lock.value.token.length > 0, note: 'A PID or timestamp cannot prove that the lock is stale. Verify the owner before manual intervention.' };
  } else lockReport = { state: lock.status === 'corrupt' ? 'malformed' : lock.status, issue: lock.issue || null, ownership: 'unknown' };

  let entries = [];
  let directoryIssue = null;
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.name.startsWith(`${basename(canonicalPath)}.tmp-`))
      .map(entry => {
        let kind = entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'other';
        let bytes = null;
        try { const stat = lstatSync(resolve(directory, entry.name)); if (stat.isFile()) bytes = stat.size; } catch {}
        return { name: entry.name, kind, bytes, action: 'preserve_for_manual_inspection' };
      });
  } catch (error) {
    if (error.code !== 'ENOENT') directoryIssue = issue(error.code || 'DIRECTORY_READ_FAILED', error.message);
  }

  let checkpointChain = { state: 'not_checked', reason: 'Supply historyPath and either publicKeyPath or trustPolicyPath to verify signatures and chain continuity.' };
  let freshness = { state: 'not_checked', reason: requireFreshnessWitness ? 'An independent freshness witness is required but has not been verified.' : 'Supply freshness witness evidence to verify independent freshness.' };
  if (historyPath || publicKeyPath || trustPolicyPath || rotationHistoryPath || revocationHistoryPath || revocationAuthorityPublicKeyPath || freshnessWitnessPath || freshnessPublicKeyPath || freshnessQuorumManifestPath || freshnessChallengeResponsePath || requireFreshnessWitness) {
    if (!historyPath || (Boolean(publicKeyPath) === Boolean(trustPolicyPath)) || (rotationHistoryPath && !trustPolicyPath) || (Boolean(revocationHistoryPath) !== Boolean(revocationAuthorityPublicKeyPath)) || (Boolean(freshnessWitnessPath) && !freshnessPublicKeyPath) || (Boolean(freshnessPublicKeyPath) && !freshnessWitnessPath && !freshnessChallengeResponsePath) || (Boolean(freshnessQuorumManifestPath) && Boolean(freshnessWitnessPath || freshnessChallengeResponsePath)) || (freshnessChallengeResponsePath && !freshnessPublicKeyPath) || (Boolean(freshnessChallengeResponsePath) !== Boolean(freshnessChallengeNonce)) || (freshnessChallengeResponsePath && Boolean(freshnessWitnessPath || freshnessQuorumManifestPath)) || (requireFreshnessWitness && !freshnessWitnessPath && !freshnessQuorumManifestPath && !freshnessChallengeResponsePath)) {
      checkpointChain = { state: 'not_checked', issue: issue('CHAIN_INPUTS_INCOMPLETE', 'Supply historyPath and exactly one of publicKeyPath or trustPolicyPath; rotation history requires trustPolicyPath; revocation history and authority key must be supplied together; single freshness witness and public key must be supplied together; use one freshness mode (single witness, quorum, or challenge response); challenge responses require a public key and expected nonce.') };
    } else {
      const historyRead = inspectRegularJson(resolve(historyPath));
      let keyText = null;
      let trustedSignerKeyId = expectedSignerKeyId;
      let trustPolicy = null;
      if (trustPolicyPath) {
        const policyRead = inspectRegularJson(resolve(trustPolicyPath));
        if (policyRead.status === 'readable') {
          trustPolicy = validateNotificationRecoveryAnchorTrustPolicy(policyRead.value);
          if (trustPolicy.valid) { keyText = trustPolicy.publicKey; trustedSignerKeyId = trustPolicy.signerKeyId; }
          else checkpointChain = { state: 'untrusted', issue: issue('INVALID_TRUST_POLICY', trustPolicy.code), trustPolicyPath: resolve(trustPolicyPath) };
        } else checkpointChain = { state: 'untrusted', issue: policyRead.issue || issue('TRUST_POLICY_UNREADABLE', 'Trust policy must be a readable regular JSON file, not a symlink.'), trustPolicyPath: resolve(trustPolicyPath) };
      } else {
        const keyRead = inspectRegularJson(resolve(publicKeyPath));
        // Public keys are PEM text rather than JSON; read through the same no-follow regular-file checks.
        if (keyRead.status === 'corrupt' && typeof keyRead.bytes === 'number') {
          const keyFile = inspectRegularText(resolve(publicKeyPath));
          if (keyFile.status === 'readable') keyText = keyFile.value;
        }
      }
      let revocationReport = null;
      if (revocationHistoryPath && checkpointChain.state !== 'untrusted') {
        const revocationsRead = inspectRegularJson(resolve(revocationHistoryPath));
        const authorityRead = inspectRegularText(resolve(revocationAuthorityPublicKeyPath));
        if (revocationsRead.status !== 'readable' || !Array.isArray(revocationsRead.value) || authorityRead.status !== 'readable') {
          checkpointChain = { state: 'untrusted', issue: issue('REVOCATION_INPUTS_UNTRUSTED', 'Revocation history must be a JSON array and authority public key must be a readable regular PEM file.') };
        } else {
          revocationReport = verifyNotificationRecoveryAnchorKeyRevocations({ events: revocationsRead.value, authorityPublicKey: authorityRead.value, now, maxAgeMs });
          if (!revocationReport.valid) checkpointChain = { state: 'untrusted', issue: issue('KEY_REVOCATION_UNTRUSTED', revocationReport.code), revocation: { valid: false, code: revocationReport.code, index: revocationReport.index ?? null, verifiedCount: revocationReport.verifiedCount } };
        }
      }
      let rotationReport = null;
      if (trustPolicyPath && rotationHistoryPath && checkpointChain.state !== 'untrusted') {
        const rotationsRead = inspectRegularJson(resolve(rotationHistoryPath));
        if (rotationsRead.status !== 'readable' || !Array.isArray(rotationsRead.value)) {
          checkpointChain = { state: 'untrusted', issue: rotationsRead.issue || issue('INVALID_ROTATION_HISTORY', 'Rotation history must be a JSON array of signed transitions.') };
        } else {
          rotationReport = verifyNotificationRecoveryAnchorKeyRotation({ trustPolicy: { schemaVersion: 1, signerKeyId: trustPolicy.signerKeyId, publicKeyPem: trustPolicy.publicKey.export({ type: 'spki', format: 'pem' }), publicKeySha256: trustPolicy.publicKeySha256 }, transitions: rotationsRead.value, now, maxAgeMs });
          if (!rotationReport.valid) checkpointChain = { state: 'untrusted', issue: issue('KEY_ROTATION_UNTRUSTED', rotationReport.code), rotation: { valid: false, code: rotationReport.code, index: rotationReport.index ?? null, verifiedCount: rotationReport.verifiedCount } };
          else { keyText = rotationReport.activePublicKey; trustedSignerKeyId = rotationReport.activeSignerKeyId; }
        }
      }
      if (revocationReport?.valid && trustedSignerKeyId && revocationReport.revokedSignerKeyIds.includes(trustedSignerKeyId)) {
        checkpointChain = { state: 'untrusted', issue: issue('ACTIVE_SIGNER_REVOKED', 'The signer selected for checkpoint verification appears in the verified revocation history.'), revocation: { valid: true, verifiedCount: revocationReport.verifiedCount, revokedSignerKeyIds: revocationReport.revokedSignerKeyIds, source: resolve(revocationHistoryPath) } };
      }
      if (historyRead.status !== 'readable' || !Array.isArray(historyRead.value)) {
        checkpointChain = { state: 'untrusted', issue: historyRead.issue || issue('INVALID_HISTORY', 'History must be a JSON array of checkpoints.') };
      } else if (checkpointChain.state === 'untrusted' && (trustPolicyPath || rotationHistoryPath || revocationHistoryPath)) {
        // Preserve the more specific trust-policy validation failure.
      } else if (!keyText) {
        checkpointChain = { state: 'untrusted', issue: issue('PUBLIC_KEY_UNREADABLE', 'Public key must be a readable regular PEM file, not a symlink.') };
      } else {
        const result = verifyNotificationRecoveryCheckpointChain({ checkpoints: historyRead.value, publicKey: keyText, expectedSignerKeyId: trustedSignerKeyId, now, maxAgeMs });
        checkpointChain = result.valid
          ? { state: 'verified', ...result, source: resolve(historyPath), ...(trustPolicyPath ? { trustPolicyPath: resolve(trustPolicyPath), trustPolicySignerKeyId: trustPolicy.signerKeyId, trustPolicyPublicKeySha256: trustPolicy.publicKeySha256 } : { publicKeyPath: resolve(publicKeyPath) }), ...(rotationReport ? { rotation: { valid: true, verifiedCount: rotationReport.verifiedCount, activeSignerKeyId: rotationReport.activeSignerKeyId, activePublicKeySha256: rotationReport.activePublicKeySha256, source: resolve(rotationHistoryPath) } } : {}), ...(revocationReport?.valid ? { revocation: { valid: true, verifiedCount: revocationReport.verifiedCount, revokedSignerKeyIds: revocationReport.revokedSignerKeyIds, source: resolve(revocationHistoryPath) } } : {}) }
          : { state: 'untrusted', ...result, source: resolve(historyPath), ...(trustPolicyPath ? { trustPolicyPath: resolve(trustPolicyPath), trustPolicySignerKeyId: trustPolicy.signerKeyId, trustPolicyPublicKeySha256: trustPolicy.publicKeySha256 } : { publicKeyPath: resolve(publicKeyPath) }), ...(rotationReport ? { rotation: { valid: true, verifiedCount: rotationReport.verifiedCount, activeSignerKeyId: rotationReport.activeSignerKeyId, activePublicKeySha256: rotationReport.activePublicKeySha256, source: resolve(rotationHistoryPath) } } : {}), ...(revocationReport?.valid ? { revocation: { valid: true, verifiedCount: revocationReport.verifiedCount, revokedSignerKeyIds: revocationReport.revokedSignerKeyIds, source: resolve(revocationHistoryPath) } } : {}) };
        if (result.valid && checkpoint.state === 'visible_checkpoint') {
          const last = historyRead.value.at(-1);
          if (NotificationRecoveryAuditAnchor.checkpointSha256(last) !== checkpoint.checkpointSha256) {
            checkpointChain = { ...checkpointChain, state: 'untrusted', code: 'latest-checkpoint-mismatch', issue: issue('LATEST_CHECKPOINT_MISMATCH', 'The last verified history checkpoint does not match the currently visible anchor file.') };
          }
        }
        if (result.valid && checkpointChain.state !== 'untrusted') {
          if (freshnessChallengeResponsePath) {
            const responsePath = resolve(freshnessChallengeResponsePath);
            const responseRead = inspectRegularJson(responsePath);
            const responseKeyRead = inspectRegularText(resolve(freshnessPublicKeyPath));
            if (responseRead.status !== 'readable' || responseKeyRead.status !== 'readable') {
              freshness = { state: 'untrusted', issue: issue('FRESHNESS_CHALLENGE_INPUTS_UNTRUSTED', 'Challenge response must be JSON and its independently trusted public key must be a readable regular PEM file.'), source: responsePath };
            } else if (!historyRead.value.length) {
              freshness = { state: 'untrusted', issue: issue('FRESHNESS_HISTORY_EMPTY', 'An empty checkpoint history has no head to bind to a challenge response.') };
            } else {
              const expectedHistoryHeadSha256 = NotificationRecoveryAuditAnchor.checkpointSha256(historyRead.value.at(-1));
              const responseResult = verifyNotificationRecoveryAnchorWitnessChallengeResponse({ response: responseRead.value, publicKey: responseKeyRead.value, expectedWitnessKeyId, expectedNonce: freshnessChallengeNonce, expectedHistoryHeadSha256, now, maxResponseAgeMs: freshnessMaxAgeMs, minimumSequence: minimumWitnessSequence });
              freshness = responseResult.valid
                ? { state: 'verified', ...responseResult, source: responsePath, publicKeyPath: resolve(freshnessPublicKeyPath), replayProtection: 'caller_must_generate_a_new_random_nonce_for_each_check' }
                : { state: 'untrusted', ...responseResult, issue: issue('FRESHNESS_CHALLENGE_RESPONSE_UNTRUSTED', responseResult.code), source: responsePath };
            }
            if (freshness.state === 'untrusted') checkpointChain = { ...checkpointChain, state: 'untrusted', issue: freshness.issue };
          } else if (freshnessQuorumManifestPath) {
            const manifestPath = resolve(freshnessQuorumManifestPath);
            const manifestRead = inspectRegularJson(manifestPath);
            if (manifestRead.status !== 'readable' || manifestRead.value?.schemaVersion !== 1 || !Array.isArray(manifestRead.value.witnesses) || !Number.isSafeInteger(manifestRead.value.threshold)) {
              freshness = { state: 'untrusted', issue: issue('FRESHNESS_QUORUM_MANIFEST_INVALID', 'Quorum manifest must be a regular JSON file with schemaVersion 1, threshold, and witness entries.'), source: manifestPath };
            } else if (!historyRead.value.length) {
              freshness = { state: 'untrusted', issue: issue('FRESHNESS_HISTORY_EMPTY', 'An empty checkpoint history has no head to bind to a freshness quorum.'), source: manifestPath };
            } else {
              const entries = [];
              let inputIssue = null;
              for (const member of manifestRead.value.witnesses) {
                if (!member || typeof member.witnessPath !== 'string' || typeof member.publicKeyPath !== 'string') { inputIssue = issue('FRESHNESS_QUORUM_MEMBER_INVALID', 'Each quorum member requires witnessPath and publicKeyPath strings.'); break; }
                const witnessPath = resolve(dirname(manifestPath), member.witnessPath);
                const publicKeyPath = resolve(dirname(manifestPath), member.publicKeyPath);
                const witnessRead = inspectRegularJson(witnessPath);
                const keyRead = inspectRegularText(publicKeyPath);
                if (witnessRead.status !== 'readable' || keyRead.status !== 'readable') { inputIssue = issue('FRESHNESS_QUORUM_MEMBER_UNREADABLE', `Witness or public key is not a readable regular file for member ${String(member.expectedWitnessKeyId || 'unknown')}.`); break; }
                entries.push({ witness: witnessRead.value, publicKey: keyRead.value, expectedWitnessKeyId: member.expectedWitnessKeyId, minimumSequence: member.minimumSequence ?? 1 });
              }
              if (inputIssue) freshness = { state: 'untrusted', issue: inputIssue, source: manifestPath };
              else {
                const expectedHistoryHeadSha256 = NotificationRecoveryAuditAnchor.checkpointSha256(historyRead.value.at(-1));
                const quorumResult = verifyNotificationRecoveryAnchorFreshnessQuorum({ witnesses: entries, threshold: manifestRead.value.threshold, expectedHistoryHeadSha256, now, maxAgeMs: freshnessMaxAgeMs });
                freshness = quorumResult.valid
                  ? { state: 'verified', ...quorumResult, source: manifestPath }
                  : { state: 'untrusted', ...quorumResult, issue: issue('FRESHNESS_QUORUM_UNTRUSTED', quorumResult.code), source: manifestPath };
              }
            }
            if (freshness.state === 'untrusted') checkpointChain = { ...checkpointChain, state: 'untrusted', issue: freshness.issue };
          } else if (freshnessWitnessPath && freshnessPublicKeyPath) {
            const witnessRead = inspectRegularJson(resolve(freshnessWitnessPath));
            const witnessKeyRead = inspectRegularText(resolve(freshnessPublicKeyPath));
            if (witnessRead.status !== 'readable' || witnessKeyRead.status !== 'readable') {
              freshness = { state: 'untrusted', issue: issue('FRESHNESS_INPUTS_UNTRUSTED', 'Freshness witness must be valid JSON and its independently trusted public key must be a readable regular PEM file.'), witnessPath: resolve(freshnessWitnessPath), publicKeyPath: resolve(freshnessPublicKeyPath) };
            } else if (!historyRead.value.length) {
              freshness = { state: 'untrusted', issue: issue('FRESHNESS_HISTORY_EMPTY', 'An empty checkpoint history has no head to bind to a freshness witness.') };
            } else {
              const expectedHistoryHeadSha256 = NotificationRecoveryAuditAnchor.checkpointSha256(historyRead.value.at(-1));
              const witnessResult = verifyNotificationRecoveryAnchorFreshnessWitness({ witness: witnessRead.value, publicKey: witnessKeyRead.value, expectedWitnessKeyId, expectedHistoryHeadSha256, now, maxAgeMs: freshnessMaxAgeMs, minimumSequence: minimumWitnessSequence });
              freshness = witnessResult.valid
                ? { state: 'verified', ...witnessResult, source: resolve(freshnessWitnessPath), publicKeyPath: resolve(freshnessPublicKeyPath), minimumSequence: minimumWitnessSequence }
                : { state: 'untrusted', ...witnessResult, issue: issue('FRESHNESS_WITNESS_UNTRUSTED', witnessResult.code), source: resolve(freshnessWitnessPath), publicKeyPath: resolve(freshnessPublicKeyPath), minimumSequence: minimumWitnessSequence };
            }
            if (freshness.state === 'untrusted') checkpointChain = { ...checkpointChain, state: 'untrusted', issue: freshness.issue };
          } else if (requireFreshnessWitness) {
            freshness = { state: 'not_checked', issue: issue('FRESHNESS_WITNESS_REQUIRED', 'An independent freshness witness is required but was not supplied.') };
          }
        }
      }
    }
  }

  const freshnessRequiredButMissing = requireFreshnessWitness && freshness.state !== 'verified';
  const status = checkpoint.state === 'untrusted' || checkpointChain.state === 'untrusted' || freshness.state === 'untrusted' || freshnessRequiredButMissing ? 'attention_required' : lockReport.state !== 'absent' ? 'attention_required' : entries.length || directoryIssue ? 'attention_required' : 'no_obvious_local_recovery_artifacts';
  return {
    schemaVersion: 1,
    mode: 'read_only',
    anchorPath: canonicalPath,
    overall: status,
    checkpoint,
    checkpointChain,
    freshness,
    lock: lockReport,
    temporaryArtifacts: entries,
    directoryIssue,
    limitations: [
      'This report does not modify, repair, or delete files.',
      'A readable checkpoint does not prove its historical fsync completed or prevent rollback to an older copy.',
      'Lock PID and timestamp are advisory only; lock ownership and staleness require independent operational verification.',
      'A local file anchor is not a remote independent freshness witness.',
      'Chain verification is only meaningful when the supplied history is complete from its trusted start and the public key is independently trusted.',
      'A trust-policy file is not self-authenticating; provision or pin it through a separate trusted channel. Signed key rotation is only trusted when its complete transition history is supplied and verified against that external trust root.',
      'Revocation is enforced only when both a complete revocation history and independently provisioned authority public key are supplied; local history alone cannot prove freshness or prevent rollback.',
      'A freshness witness proves only the signed statement and history-head binding. Witness quorum improves fault tolerance only when member keys and quorum membership are provisioned independently; it does not itself prevent rollback if the accepted minimum sequence can also be rolled back.'
    ]
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const anchorPath = process.argv[2];
  if (!anchorPath) {
    console.error('Usage: node src/notification-recovery-anchor-diagnostics.js <anchor-path> [--history <history.json> (--public-key <public-key.pem> [--signer-key-id <id>] | --trust-policy <trust-policy.json>) [--freshness-witness <witness.json> --freshness-public-key <witness-public.pem> | --freshness-quorum-manifest <quorum.json> | --freshness-challenge-response <response.json> --freshness-public-key <witness-public.pem> --freshness-challenge-nonce <hex>] [--freshness-max-age-ms <ms>] [--freshness-key-id <id>] [--minimum-witness-sequence <n>] [--require-freshness-witness] [--max-age-ms <ms>]]');
    process.exitCode = 2;
  } else {
    const options = { anchorPath };
    for (let index = 3; index < process.argv.length; index += 1) {
      const flag = process.argv[index];
      if (flag === '--require-freshness-witness') { options.requireFreshnessWitness = true; continue; }
      const value = process.argv[++index];
      if (flag === '--history') options.historyPath = value;
      else if (flag === '--public-key') options.publicKeyPath = value;
      else if (flag === '--trust-policy') options.trustPolicyPath = value;
      else if (flag === '--rotation-history') options.rotationHistoryPath = value;
      else if (flag === '--revocation-history') options.revocationHistoryPath = value;
      else if (flag === '--revocation-authority-public-key') options.revocationAuthorityPublicKeyPath = value;
      else if (flag === '--freshness-witness') options.freshnessWitnessPath = value;
      else if (flag === '--freshness-quorum-manifest') options.freshnessQuorumManifestPath = value;
      else if (flag === '--freshness-challenge-response') options.freshnessChallengeResponsePath = value;
      else if (flag === '--freshness-challenge-nonce' && /^[a-f0-9]{64}$/.test(value || '')) options.freshnessChallengeNonce = value;
      else if (flag === '--freshness-public-key') options.freshnessPublicKeyPath = value;
      else if (flag === '--freshness-key-id') options.expectedWitnessKeyId = value;
      else if (flag === '--minimum-witness-sequence' && /^\d+$/.test(value || '') && Number.isSafeInteger(Number(value)) && Number(value) >= 1) options.minimumWitnessSequence = Number(value);
      else if (flag === '--freshness-max-age-ms' && /^\d+$/.test(value || '') && Number.isSafeInteger(Number(value))) options.freshnessMaxAgeMs = Number(value);
      else if (flag === '--signer-key-id') options.expectedSignerKeyId = value;
      else if (flag === '--max-age-ms' && /^\d+$/.test(value || '')) options.maxAgeMs = Number(value);
      else { console.error(`Unknown or invalid option: ${flag}`); process.exitCode = 2; break; }
    }
    if (!process.exitCode) try { process.stdout.write(`${JSON.stringify(inspectPersistentAnchorState(options), null, 2)}\n`); }
    catch (error) { console.error(`${error.code || error.name}: ${error.message}`); process.exitCode = 1; }
  }
}
