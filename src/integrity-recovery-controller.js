import { randomBytes } from 'node:crypto';

const STATES = new Set(['IDLE', 'QUARANTINED', 'STAGED', 'APPROVED', 'INSTALLING', 'RESTART_REQUIRED', 'FAILED']);

/**
 * Coordinates a non-destructive, operator-approved recovery after integrity quarantine.
 * This controller deliberately does not download, unpack, or install releases itself.
 * Those operations are injected adapters and must verify signatures against trust material
 * provisioned independently of the potentially compromised node.
 */
export class IntegrityRecoveryController {
  constructor({ integrityGuard, releaseProvider, releaseVerifier, releaseInstaller, operatorAuthorizer, nodeController, audit = () => {} } = {}) {
    if (!integrityGuard || typeof integrityGuard.status !== 'object' || typeof integrityGuard.assertHealthy !== 'function') throw new TypeError('A valid integrity guard is required');
    if (!releaseProvider || typeof releaseProvider.fetchApprovedRelease !== 'function') throw new TypeError('A trusted release provider is required');
    if (!releaseVerifier || typeof releaseVerifier.verifyStagedRelease !== 'function') throw new TypeError('A release verifier is required');
    if (!releaseInstaller || typeof releaseInstaller.installVerifiedRelease !== 'function') throw new TypeError('A trusted release installer is required');
    if (!operatorAuthorizer || typeof operatorAuthorizer.authorizeRecovery !== 'function') throw new TypeError('An operator authorization adapter is required');
    if (!nodeController || typeof nodeController.stopNetworkOperations !== 'function' || typeof nodeController.requireRestart !== 'function') throw new TypeError('A node controller is required');
    if (typeof audit !== 'function') throw new TypeError('Audit sink must be a function');
    this.integrityGuard = integrityGuard;
    this.releaseProvider = releaseProvider;
    this.releaseVerifier = releaseVerifier;
    this.releaseInstaller = releaseInstaller;
    this.operatorAuthorizer = operatorAuthorizer;
    this.nodeController = nodeController;
    this.audit = audit;
    this.state = 'IDLE';
    this.incidentId = null;
    this.stagedRelease = null;
    this.lastError = null;
  }

  async begin(reason = this.integrityGuard.status.reason ?? 'integrity-failure') {
    if (!this.integrityGuard.status.quarantined) throw new Error('Recovery can only begin after integrity quarantine');
    if (this.state === 'INSTALLING' || this.state === 'RESTART_REQUIRED') throw new Error(`Recovery is already ${this.state.toLowerCase()}`);
    this.incidentId ??= randomBytes(16).toString('hex');
    this.state = 'QUARANTINED';
    await this.nodeController.stopNetworkOperations({ reason, incidentId: this.incidentId });
    await this.#record('recovery-quarantine-confirmed', { reason });
    return Object.freeze({ state: this.state, incidentId: this.incidentId });
  }

  async stage({ releaseVersion, expectedDigest } = {}) {
    this.#requireState('QUARANTINED');
    if (typeof releaseVersion !== 'string' || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(releaseVersion)) throw new TypeError('A pinned release version is required');
    if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) throw new TypeError('A pinned release digest is required');
    try {
      const candidate = await this.releaseProvider.fetchApprovedRelease({ releaseVersion, expectedDigest, incidentId: this.incidentId });
      if (!candidate || candidate.releaseVersion !== releaseVersion || candidate.digest !== expectedDigest || typeof candidate.stagingHandle !== 'string' || !candidate.stagingHandle) throw new Error('Release provider returned an unexpected candidate');
      const verification = await this.releaseVerifier.verifyStagedRelease({ candidate, releaseVersion, expectedDigest });
      if (verification?.ok !== true || verification.releaseVersion !== releaseVersion || verification.digest !== expectedDigest || verification.signatureVerified !== true || verification.trustRootIndependent !== true) throw new Error('Staged release failed independent signature or digest verification');
      this.stagedRelease = Object.freeze({ ...candidate, verification });
      this.state = 'STAGED';
      await this.#record('recovery-release-staged-and-verified', { releaseVersion, expectedDigest });
      return Object.freeze({ state: this.state, releaseVersion, digest: expectedDigest });
    } catch (error) {
      await this.#fail(error, 'recovery-stage-failed');
      throw error;
    }
  }

  async approve({ operatorId, authorization } = {}) {
    this.#requireState('STAGED');
    if (typeof operatorId !== 'string' || !operatorId.trim() || typeof authorization !== 'string' || !authorization.trim()) throw new TypeError('Explicit operator identity and authorization are required');
    const approved = await this.operatorAuthorizer.authorizeRecovery({ operatorId, authorization, incidentId: this.incidentId,
      releaseVersion: this.stagedRelease.releaseVersion, digest: this.stagedRelease.digest });
    if (approved !== true) throw new Error('Recovery was not authorized by an operator');
    this.state = 'APPROVED';
    await this.#record('recovery-explicitly-approved', { operatorId, releaseVersion: this.stagedRelease.releaseVersion, digest: this.stagedRelease.digest });
    return Object.freeze({ state: this.state, releaseVersion: this.stagedRelease.releaseVersion, digest: this.stagedRelease.digest });
  }

  async install() {
    this.#requireState('APPROVED');
    this.state = 'INSTALLING';
    try {
      // Re-verify immediately before installation to reduce staging-to-install race risk.
      const check = await this.releaseVerifier.verifyStagedRelease({ candidate: this.stagedRelease,
        releaseVersion: this.stagedRelease.releaseVersion, expectedDigest: this.stagedRelease.digest });
      if (check?.ok !== true || check.signatureVerified !== true || check.trustRootIndependent !== true ||
        check.releaseVersion !== this.stagedRelease.releaseVersion || check.digest !== this.stagedRelease.digest) throw new Error('Staged release changed or lost trust before installation');
      const installed = await this.releaseInstaller.installVerifiedRelease({ candidate: this.stagedRelease, incidentId: this.incidentId });
      if (installed?.ok !== true || installed.releaseVersion !== this.stagedRelease.releaseVersion || installed.digest !== this.stagedRelease.digest) throw new Error('Installer did not confirm the exact verified release');
      await this.nodeController.requireRestart({ incidentId: this.incidentId, releaseVersion: installed.releaseVersion });
      this.state = 'RESTART_REQUIRED';
      await this.#record('recovery-installed-restart-required', { releaseVersion: installed.releaseVersion, digest: installed.digest });
      return Object.freeze({ state: this.state, releaseVersion: installed.releaseVersion, digest: installed.digest, restartRequired: true });
    } catch (error) {
      await this.#fail(error, 'recovery-install-failed');
      throw error;
    }
  }

  #requireState(expected) {
    if (!STATES.has(this.state) || this.state !== expected) throw new Error(`Invalid recovery state: expected ${expected}, got ${this.state}`);
  }
  async #record(event, details) {
    try { await this.audit(Object.freeze({ event, incidentId: this.incidentId, at: new Date().toISOString(), ...details })); }
    catch { /* audit sink failure must never relax quarantine or authorize recovery */ }
  }
  async #fail(error, event) {
    this.state = 'FAILED';
    this.lastError = typeof error?.message === 'string' ? error.message.slice(0, 240) : 'recovery-failed';
    try { await this.nodeController.stopNetworkOperations({ reason: this.lastError, incidentId: this.incidentId }); } catch { /* keep the recovery state failed even if isolation signaling fails */ }
    await this.#record(event, { reason: this.lastError });
  }
  get status() {
    return Object.freeze({ state: this.state, incidentId: this.incidentId, releaseVersion: this.stagedRelease?.releaseVersion ?? null,
      digest: this.stagedRelease?.digest ?? null, lastError: this.lastError });
  }
}
