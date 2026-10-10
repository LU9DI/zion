/**
 * Fail-closed startup orchestration for an official Zion node.
 * Trust material and adapters must be provisioned by the deployment, not loaded
 * from paths writable by the running node. This is not an OS secure-boot boundary.
 */
export class OfficialNodeBootstrap {
  constructor({ integrityGuard, transport, startStorage, stopStorage = async () => {}, getStorageStatus, inactivityScheduler = null, idleParticipationScheduler = null, notificationDeliveryWorker = null, notificationApi = null, recordContainmentEvent, maxContainmentHistory = 100 } = {}) {
    if (!integrityGuard || typeof integrityGuard.verify !== 'function' ||
      typeof integrityGuard.checkHealthy !== 'function' || typeof integrityGuard.assertHealthy !== 'function' ||
      typeof integrityGuard.addQuarantineListener !== 'function' ||
      !integrityGuard.status || typeof integrityGuard.status !== 'object') {
      throw new TypeError('Official node bootstrap requires a complete IntegrityGuard');
    }
    if (!transport || transport.networkMode !== 'official' || typeof transport.listen !== 'function' || typeof transport.close !== 'function') {
      throw new TypeError('Official node bootstrap requires an official-mode transport');
    }
    if (typeof startStorage !== 'function' || typeof stopStorage !== 'function') {
      throw new TypeError('Storage startup and shutdown adapters are required');
    }
    this.integrityGuard = integrityGuard;
    this.transport = transport;
    this.startStorage = startStorage;
    this.stopStorage = stopStorage;
    this.getStorageStatus = typeof getStorageStatus === 'function' ? getStorageStatus : null;
    if (inactivityScheduler !== null && (typeof inactivityScheduler.start !== 'function' || typeof inactivityScheduler.stop !== 'function')) {
      throw new TypeError('inactivityScheduler must expose start() and stop()');
    }
    this.inactivityScheduler = inactivityScheduler;
    this.inactivitySchedulerStarted = false;
    if (idleParticipationScheduler !== null && (typeof idleParticipationScheduler.start !== 'function' || typeof idleParticipationScheduler.stop !== 'function')) {
      throw new TypeError('idleParticipationScheduler must expose start() and stop()');
    }
    this.idleParticipationScheduler = idleParticipationScheduler;
    this.idleParticipationSchedulerStarted = false;
    if (notificationDeliveryWorker !== null && (typeof notificationDeliveryWorker.start !== 'function' || typeof notificationDeliveryWorker.stop !== 'function')) {
      throw new TypeError('notificationDeliveryWorker must expose start() and stop()');
    }
    this.notificationDeliveryWorker = notificationDeliveryWorker;
    this.notificationDeliveryWorkerStarted = false;
    if (notificationApi !== null && (typeof notificationApi.listen !== 'function' || typeof notificationApi.close !== 'function')) {
      throw new TypeError('notificationApi must expose listen() and close()');
    }
    this.notificationApi = notificationApi;
    this.notificationApiStarted = false;
    if (recordContainmentEvent !== undefined && typeof recordContainmentEvent !== 'function') throw new TypeError('recordContainmentEvent must be a function when provided');
    if (!Number.isInteger(maxContainmentHistory) || maxContainmentHistory < 1 || maxContainmentHistory > 1000) throw new RangeError('maxContainmentHistory must be an integer between 1 and 1000');
    this.recordContainmentEvent = recordContainmentEvent ?? null;
    this.maxContainmentHistory = maxContainmentHistory;
    this.containmentHistory = [];
    this.containmentAuditErrors = [];
    this.containmentAuditQueue = Promise.resolve();
    this.started = false;
    this.storageStarted = false;
    this.starting = false;
    this.startPromise = null;
    this.lifecycleEpoch = 0;
    this.containmentPromise = null;
    // Serialize adapter shutdown calls across quarantine, rollback, retry, and close.
    this.adapterCleanupQueue = Promise.resolve();
    this.closePromise = null;
    // Explicit close is terminal for this instance; create a new bootstrap to restart.
    this.closed = false;
    // Logical lifecycle is tracked separately from adapter-observed resource state.
    this.transportState = 'stopped';
    this.storageState = 'stopped';
    this.containmentStatus = 'idle';
    this.containmentErrors = [];
    this.removeQuarantineListener = this.integrityGuard.addQuarantineListener(() => this.#contain());
    if (this.integrityGuard.status.quarantined === true) {
      this.#contain().catch(() => {});
    }
  }

  get containmentReport() {
    const transport = this.transportState;
    const storage = this.storageState;
    return Object.freeze({
      transport, storage,
      verifiedStopped: transport === 'stopped' && storage === 'stopped',
      audit: Object.freeze({ configured: Boolean(this.recordContainmentEvent), errors: Object.freeze([...this.containmentAuditErrors]) }),
      evidence: Object.freeze({
        transport: typeof this.transport.getStatus === 'function' ? 'adapter-observed' : 'unverified',
        storage: typeof this.getStorageStatus === 'function' ? 'adapter-observed' : 'unverified'
      })
    });
  }

  async #observeTransportStopped() {
    if (typeof this.transport.getStatus !== 'function') { this.transportState = 'unknown'; return; }
    let status;
    try { status = await this.transport.getStatus(); } catch (error) { this.transportState = 'unknown'; throw error; }
    if (!status || typeof status.listening !== 'boolean') { this.transportState = 'unknown'; return; }
    this.transportState = status.listening ? 'running' : 'stopped';
    if (status.listening) throw new Error('Transport adapter reports listener is still active after close');
  }

  async #observeStorageStopped() {
    if (typeof this.getStorageStatus !== 'function') { this.storageState = 'unknown'; return; }
    let status;
    try { status = await this.getStorageStatus(); } catch (error) { this.storageState = 'unknown'; throw error; }
    if (!status || typeof status.running !== 'boolean') { this.storageState = 'unknown'; return; }
    this.storageState = status.running ? 'running' : 'stopped';
    if (status.running) throw new Error('Storage adapter reports storage is still active after stop');
  }

  async #recordEvent(type, details = {}) {
    const safeDetails = Object.fromEntries(Object.entries(details).map(([key, value]) => [String(key).slice(0, 48), String(value ?? '').slice(0, 240)]));
    const record = Object.freeze({
      schema: 'zion.containment-event.v1', at: new Date().toISOString(),
      sequence: (this.containmentHistory.at(-1)?.sequence ?? 0) + 1,
      event: String(type).slice(0, 64), status: this.containmentStatus,
      transport: this.transportState, storage: this.storageState, details: Object.freeze(safeDetails)
    });
    this.containmentHistory.push(record);
    if (this.containmentHistory.length > this.maxContainmentHistory) this.containmentHistory.splice(0, this.containmentHistory.length - this.maxContainmentHistory);
    if (!this.recordContainmentEvent) return;
    const write = this.containmentAuditQueue.then(() => this.recordContainmentEvent(record));
    this.containmentAuditQueue = write.then(() => undefined, () => undefined);
    try { await write; } catch (error) {
      this.containmentAuditErrors.push(String(error?.message ?? error).slice(0, 240));
      if (this.containmentAuditErrors.length > 20) this.containmentAuditErrors.shift();
    }
  }

  async #cleanupAdapters() {
    // Each caller gets a turn; adapter shutdown methods never overlap even if
    // close(), quarantine containment, rollback, and retry are requested together.
    const operation = this.adapterCleanupQueue.then(async () => {
      const errors = [];
      if (this.idleParticipationSchedulerStarted && this.idleParticipationScheduler) {
        try { await this.idleParticipationScheduler.stop(); this.idleParticipationSchedulerStarted = false; }
        catch (error) { errors.push(error); }
      }
      if (this.notificationDeliveryWorkerStarted && this.notificationDeliveryWorker) {
        try { await this.notificationDeliveryWorker.stop(); this.notificationDeliveryWorkerStarted = false; }
        catch (error) { errors.push(error); }
      }
      if (this.notificationApiStarted && this.notificationApi) {
        try { await this.notificationApi.close(); this.notificationApiStarted = false; }
        catch (error) { errors.push(error); }
      }
      if (this.inactivitySchedulerStarted && this.inactivityScheduler) {
        try { this.inactivityScheduler.stop(); this.inactivitySchedulerStarted = false; }
        catch (error) { errors.push(error); }
      }
      this.transportState = 'stopping';
      try { await this.transport.close(); await this.#observeTransportStopped(); }
      catch (error) { if (this.transportState !== 'running') this.transportState = 'unknown'; errors.push(error); }
      if (this.storageStarted) {
        this.storageState = 'stopping';
        try {
          await this.stopStorage();
          this.storageStarted = false;
          await this.#observeStorageStopped();
        } catch (error) { if (this.storageState !== 'running') this.storageState = 'unknown'; errors.push(error); }
      }
      return errors;
    });
    this.adapterCleanupQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #contain() {
    if (this.containmentPromise) return this.containmentPromise;
    this.lifecycleEpoch++;
    this.started = false;
    this.containmentStatus = 'pending';
    this.containmentPromise = (async () => {
      await this.#recordEvent('containment-started', { reason: 'integrity-quarantine' });
      const errors = await this.#cleanupAdapters();
      this.containmentErrors = errors.map(error => String(error?.message ?? error).slice(0, 240));
      if (errors.length) {
        this.containmentStatus = 'failed';
        await this.#recordEvent('containment-failed', { errors: this.containmentErrors.join('; ') });
        throw new AggregateError(errors, 'Quarantine containment was incomplete');
      }
      this.containmentStatus = 'contained';
      await this.#recordEvent('containment-completed', { verifiedStopped: this.containmentReport.verifiedStopped });
    })();
    try { await this.containmentPromise; } finally { this.containmentPromise = null; }
  }

  /** Retry containment after a transport or storage shutdown adapter failed. */
  async retryContainment() {
    if (this.integrityGuard.status.quarantined !== true) {
      throw new Error('Containment retry is only allowed while integrity quarantine is active');
    }
    await this.#contain();
    return Object.freeze({ status: this.containmentStatus, storageStopped: this.storageState === 'stopped', report: this.containmentReport });
  }

  start() {
    if (this.closed) return Promise.reject(Object.assign(new Error('Official node bootstrap is permanently closed; create a new instance to restart'), { code: 'ZION_BOOTSTRAP_CLOSED' }));
    if (this.started || this.starting) return Promise.reject(new Error('Official node bootstrap already started'));
    this.starting = true;
    const epoch = this.lifecycleEpoch;
    this.startPromise = this.#start(epoch).finally(() => {
      this.starting = false;
      this.startPromise = null;
    });
    return this.startPromise;
  }

  #assertLifecycle(epoch) {
    if (epoch !== this.lifecycleEpoch || this.integrityGuard.status.quarantined === true) {
      throw Object.assign(new Error('Official node startup was cancelled by shutdown or integrity quarantine'), { code: 'ZION_STARTUP_CANCELLED' });
    }
  }

  async #start(epoch) {
    try {
      const report = await this.integrityGuard.verify();
      if (!report?.ok) throw Object.assign(new Error(`Official node integrity verification failed: ${report?.reason ?? 'unknown'}`), { code: 'ZION_STARTUP_INTEGRITY_FAILED' });
      this.#assertLifecycle(epoch);
      await this.integrityGuard.checkHealthy();
      this.#assertLifecycle(epoch);
      this.integrityGuard.assertHealthy();
      if (this.integrityGuard.status.verified !== true || this.integrityGuard.status.quarantined === true) {
        throw Object.assign(new Error('Official node integrity state is not healthy'), { code: 'ZION_STARTUP_INTEGRITY_FAILED' });
      }

      // Storage may create/open persistent state, so it is not touched before verification.
      this.storageState = 'starting';
      await this.startStorage();
      this.storageStarted = true;
      this.storageState = 'running';
      this.#assertLifecycle(epoch);
      // Recheck immediately before opening the network listener.
      await this.integrityGuard.checkHealthy();
      this.#assertLifecycle(epoch);
      this.integrityGuard.assertHealthy();
      this.transportState = 'starting';
      const address = await this.transport.listen();
      this.transportState = 'running';
      // Binding is asynchronous: shutdown or quarantine can happen while listen() is pending.
      this.#assertLifecycle(epoch);
      await this.integrityGuard.checkHealthy();
      this.#assertLifecycle(epoch);
      this.integrityGuard.assertHealthy();
      if (this.integrityGuard.status.verified !== true || this.integrityGuard.status.quarantined === true) {
        throw Object.assign(new Error('Official node integrity changed while opening network listener'), { code: 'ZION_INTEGRITY_QUARANTINED' });
      }
      // Start authenticated notification API only after integrity, storage, and transport are healthy.
      if (this.notificationApi) {
        await this.notificationApi.listen();
        this.notificationApiStarted = true;
        this.#assertLifecycle(epoch);
        await this.integrityGuard.checkHealthy();
        this.#assertLifecycle(epoch);
      }
      // Start inactivity automation only after integrity, storage, and transport are healthy.
      // The scheduler must use real host adapters; bootstrap only owns its lifecycle.
      if (this.inactivityScheduler) {
        this.inactivityScheduler.start({ runImmediately: false });
        this.inactivitySchedulerStarted = true;
      }
      if (this.idleParticipationScheduler) {
        this.idleParticipationScheduler.start({ runImmediately: false });
        this.idleParticipationSchedulerStarted = true;
      }
      if (this.notificationDeliveryWorker) {
        this.notificationDeliveryWorker.start({ runImmediately: false });
        this.notificationDeliveryWorkerStarted = true;
      }
      this.started = true;
      return Object.freeze({ ok: true, address, integrity: this.integrityGuard.status,
        inactivityPolicy: this.inactivityScheduler ? 'scheduled' : 'not-configured',
        idleParticipation: this.idleParticipationScheduler ? 'scheduled' : 'not-configured',
        notificationDelivery: this.notificationDeliveryWorker ? 'scheduled' : 'not-configured',
        notificationApi: this.notificationApi ? 'listening' : 'not-configured' });
    } catch (error) {
      // Serialize rollback with quarantine/close so storage is never stopped twice concurrently.
      const cleanupErrors = await this.#cleanupAdapters();
      if (cleanupErrors.length) {
        this.containmentStatus = 'failed';
        this.containmentErrors = cleanupErrors.map(item => String(item?.message ?? item).slice(0, 240));
      } else if (this.integrityGuard.status.quarantined === true) {
        this.containmentStatus = 'contained';
        this.containmentErrors = [];
      }
      this.started = false;
      throw error;
    }
  }

  close() {
    // Latch terminal state synchronously, before any await or adapter call.
    this.closed = true;
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.#close().finally(() => { this.closePromise = null; });
    return this.closePromise;
  }

  async #close() {
    this.lifecycleEpoch++;
    this.removeQuarantineListener?.();
    this.removeQuarantineListener = null;
    // Cancel and drain in-flight startup before final shutdown, preventing a late bind.
    if (this.startPromise) await this.startPromise.catch(() => {});
    if (this.containmentPromise) await this.containmentPromise.catch(() => {});
    await this.#recordEvent('shutdown-started', { reason: 'explicit-close' });
    const errors = await this.#cleanupAdapters();
    this.started = false;
    if (errors.length) {
      this.containmentStatus = 'failed';
      this.containmentErrors = errors.map(error => String(error?.message ?? error).slice(0, 240));
      await this.#recordEvent('shutdown-failed', { errors: this.containmentErrors.join('; ') });
      throw new AggregateError(errors, 'Official node shutdown was incomplete');
    }
    this.containmentStatus = 'contained';
    this.containmentErrors = [];
    await this.#recordEvent('shutdown-completed', { verifiedStopped: this.containmentReport.verifiedStopped });
  }
}
