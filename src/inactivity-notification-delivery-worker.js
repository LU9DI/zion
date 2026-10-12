/**
 * Bounded, owner-scoped delivery retry worker for the durable inactivity outbox.
 * The provider adapter must return { delivered: true, receipt: nonEmptyString } only
 * when it can verify delivery. This worker never treats a successful HTTP call alone
 * as proof of delivery.
 */
async function invokeWithTimeout(operation, payload, timeoutMs, phase, parentSignal = null) {
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  let removeParentAbort = () => {};
  const parentAbort = new Promise((_, reject) => {
    if (!parentSignal) return;
    const abort = () => {
      const error = new Error(`Notification ${phase} aborted during worker shutdown`);
      error.code = 'WORKER_SHUTDOWN';
      if (phase === 'delivery') error.deliveryOutcomeUnknown = true;
      controller.abort(error);
      reject(error);
    };
    if (parentSignal.aborted) abort();
    else { parentSignal.addEventListener('abort', abort, { once: true }); removeParentAbort = () => parentSignal.removeEventListener('abort', abort); }
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = new Error(`Notification ${phase} timed out`);
      error.code = 'ETIMEDOUT';
      if (phase === 'delivery') error.deliveryOutcomeUnknown = true;
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => { if (controller.signal.aborted) throw controller.signal.reason || new Error('Operation aborted'); return operation(Object.freeze({ ...payload, signal: controller.signal })); }),
      timeout, parentAbort,
    ]);
  } finally {
    clearTimeout(timer);
    removeParentAbort();
    // A timed-out operation may still be running if the adapter ignores AbortSignal.
    // The delivery state is therefore treated as ambiguous, never as a safe retry.
    void timedOut;
  }
}

export class InactivityNotificationDeliveryWorker {
  constructor({ store, listOwnerIdentityIds, deliver, intervalMs = 30_000,
    baseBackoffMs = 30_000, maxBackoffMs = 6 * 60 * 60 * 1000, maxAttempts = 12,
    batchSizePerOwner = 100, deliveryLeaseMs = 120_000, providerTimeoutMs = 30_000, reconcile = null, now = () => Date.now(), setIntervalFn = setInterval,
    clearIntervalFn = clearInterval, onError = () => {} } = {}) {
    if (!store || typeof store.list !== 'function' || typeof store.recordAttempt !== 'function' ||
        typeof store.claimDelivery !== 'function' || typeof store.markDeliveryStarted !== 'function' || typeof store.releaseDeliveryClaim !== 'function' || typeof store.markDeliveryAmbiguous !== 'function' || typeof store.resolveDeliveryAmbiguity !== 'function' || typeof store.confirmDelivered !== 'function' || typeof listOwnerIdentityIds !== 'function' ||
        typeof deliver !== 'function' || (reconcile !== null && typeof reconcile !== 'function') || !Number.isSafeInteger(intervalMs) || intervalMs < 1 ||
        !Number.isSafeInteger(baseBackoffMs) || baseBackoffMs < 1 || !Number.isSafeInteger(maxBackoffMs) ||
        maxBackoffMs < baseBackoffMs || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 ||
        !Number.isSafeInteger(batchSizePerOwner) || batchSizePerOwner < 1 || batchSizePerOwner > 500 ||
        !Number.isSafeInteger(deliveryLeaseMs) || deliveryLeaseMs < 1_000 || deliveryLeaseMs > 15 * 60 * 1000 ||
        !Number.isSafeInteger(providerTimeoutMs) || providerTimeoutMs < 100 || providerTimeoutMs >= deliveryLeaseMs ||
        typeof now !== 'function' || typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function' ||
        typeof onError !== 'function') throw new TypeError('Invalid inactivity notification delivery worker configuration');
    Object.assign(this, { store, listOwnerIdentityIds, deliver, intervalMs, baseBackoffMs, maxBackoffMs,
      maxAttempts, batchSizePerOwner, deliveryLeaseMs, providerTimeoutMs, reconcile, now, setIntervalFn, clearIntervalFn, onError });
    this.timer = null;
    this.inFlight = null;
    this.closed = false;
    this.lifecycleController = new AbortController();
    this.lastResult = null;
  }

  start({ runImmediately = true } = {}) {
    if (this.closed) throw new Error('Notification delivery worker is stopped permanently');
    if (this.timer !== null) return false;
    this.timer = this.setIntervalFn(() => { void this.runOnce(); }, this.intervalMs);
    this.timer?.unref?.();
    if (runImmediately) void this.runOnce();
    return true;
  }

  async runOnce() {
    if (this.closed) return Object.freeze({ ok: false, status: 'stopped' });
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const stats = { ok: true, status: 'completed', owners: 0, examined: 0, delivered: 0, deferred: 0, failed: 0, exhausted: 0, ambiguous: 0, reconciled: 0 };
      try {
        const owners = await this.listOwnerIdentityIds();
        if (!Array.isArray(owners) || owners.length > 10_000 || owners.some(owner => typeof owner !== 'string' || !owner.trim() || owner.length > 256)) {
          throw new TypeError('Owner identity provider returned an invalid list');
        }
        const uniqueOwners = [...new Set(owners)];
        for (const owner of uniqueOwners) {
          if (this.closed) break;
          stats.owners++;
          const ambiguousRecords = await this.store.list(owner, { status: 'ambiguous', limit: this.batchSizePerOwner });
          for (const record of ambiguousRecords) {
            if (this.closed) break;
            stats.examined++;
            if (!this.reconcile) { stats.ambiguous++; continue; }
            const claim = await this.store.claimDelivery(owner, record.id, { leaseMs: this.deliveryLeaseMs });
            if (!claim) { stats.deferred++; continue; }
            try {
              const result = await invokeWithTimeout(this.reconcile, { ...record, ownerIdentityId: owner,
                idempotencyKey: `zion-inactivity-notification:${record.id}` }, this.providerTimeoutMs, 'reconciliation', this.lifecycleController.signal);
              const outcome = result?.outcome;
              if (outcome === 'delivered' && typeof result.receipt === 'string' && result.receipt.trim()) {
                await this.store.resolveDeliveryAmbiguity(owner, record.id, claim.claimToken, 'delivered', result.receipt);
                stats.delivered++; stats.reconciled++;
              } else if (outcome === 'not-delivered') {
                await this.store.resolveDeliveryAmbiguity(owner, record.id, claim.claimToken, 'not-delivered');
                stats.reconciled++;
              } else {
                await this.store.resolveDeliveryAmbiguity(owner, record.id, claim.claimToken, 'unknown');
                stats.ambiguous++;
              }
            } catch {
              try { await this.store.releaseDeliveryClaim(owner, record.id, claim.claimToken); } catch {}
              stats.failed++;
            }
          }
          const records = await this.store.list(owner, { status: 'pending', limit: this.batchSizePerOwner });
          for (const record of records) {
            if (this.closed) break;
            stats.examined++;
            if (record.attempts >= this.maxAttempts) { stats.exhausted++; continue; }
            const attemptedAt = Date.parse(record.lastAttemptAt ?? '');
            const delay = Math.min(this.maxBackoffMs, this.baseBackoffMs * (2 ** Math.min(Math.max(record.attempts - 1, 0), 30)));
            if (Number.isFinite(attemptedAt) && this.now() - attemptedAt < delay) { stats.deferred++; continue; }
            const claim = await this.store.claimDelivery(owner, record.id, { leaseMs: this.deliveryLeaseMs });
            if (!claim) { stats.deferred++; continue; }
            let dispatchStarted = false;
            try {
              // Persist intent before any external side effect. If the process crashes
              // after this point, lease recovery converts the record to ambiguous.
              await this.store.recordAttempt(owner, record.id, claim.claimToken);
              await this.store.markDeliveryStarted(owner, record.id, claim.claimToken);
              dispatchStarted = true;
              const idempotencyKey = `zion-inactivity-notification:${record.id}`;
              let receipt;
              try {
                receipt = await invokeWithTimeout(this.deliver, { ...record, ownerIdentityId: owner, idempotencyKey }, this.providerTimeoutMs, 'delivery', this.lifecycleController.signal);
              } catch (providerError) {
                // Once dispatch began, an exception alone cannot prove that the
                // provider did not accept the request. Reconcile instead of resending.
                await this.store.markDeliveryAmbiguous(owner, record.id, claim.claimToken, providerError?.code || 'provider-outcome-unknown');
                dispatchStarted = false;
                stats.ambiguous++;
                continue;
              }
              if (receipt?.outcome === 'unknown') {
                await this.store.markDeliveryAmbiguous(owner, record.id, claim.claimToken, receipt.reason || 'provider-outcome-unknown');
                dispatchStarted = false;
                stats.ambiguous++;
              } else if (receipt?.delivered === true && typeof receipt.receipt === 'string' && receipt.receipt.trim()) {
                try {
                  await this.store.confirmDelivered(owner, record.id, receipt.receipt, claim.claimToken);
                  dispatchStarted = false;
                  stats.delivered++;
                } catch {
                  // A provider receipt that could not be durably recorded is still
                  // an uncertain external outcome. Keep the lease/intent if even
                  // ambiguity cannot be persisted; recovery will fence a resend.
                  try {
                    await this.store.markDeliveryAmbiguous(owner, record.id, claim.claimToken, 'receipt-persistence-failed');
                    dispatchStarted = false;
                  } catch {}
                  stats.ambiguous++;
                }
              } else {
                // Adapter's explicit negative result is the contract for a known
                // non-delivery; release clears the durable dispatch marker.
                await this.store.releaseDeliveryClaim(owner, record.id, claim.claimToken);
                dispatchStarted = false;
                stats.failed++;
              }
            } catch {
              if (dispatchStarted) {
                try { await this.store.markDeliveryAmbiguous(owner, record.id, claim.claimToken, 'delivery-state-persistence-failed'); } catch {}
              } else {
                try { await this.store.releaseDeliveryClaim(owner, record.id, claim.claimToken); } catch {}
              }
              stats.failed++;
            }
          }
        }
      } catch (error) {
        stats.ok = false;
        stats.status = 'worker-error';
        const safeError = Object.freeze({ name: error?.name || 'Error', message: String(error?.message || 'Delivery worker failed').slice(0, 240) });
        stats.error = safeError;
        try { await this.onError(safeError); } catch {}
      }
      this.lastResult = Object.freeze(stats);
      return this.lastResult;
    })().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async stop() {
    const errors = [];
    if (!this.closed) {
      this.closed = true;
      this.lifecycleController.abort(new Error('Notification worker is shutting down'));
      if (this.timer !== null) {
        const timer = this.timer;
        this.timer = null;
        try { this.clearIntervalFn(timer); } catch (error) { errors.push(error); }
      }
    }
    // Shutdown cancellation is not complete until the active batch has
    // reconciled its durable state and stopped using storage/provider adapters.
    if (this.inFlight) {
      try { await this.inFlight; } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Notification worker shutdown was incomplete');
    return true;
  }

  snapshot() {
    return Object.freeze({ running: this.timer !== null && !this.closed, stopped: this.closed,
      processing: this.inFlight !== null, intervalMs: this.intervalMs, maxAttempts: this.maxAttempts,
      providerTimeoutMs: this.providerTimeoutMs, deliveryLeaseMs: this.deliveryLeaseMs,
      lastResult: this.lastResult });
  }
}
