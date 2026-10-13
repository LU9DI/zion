/**
 * Application-level outbound byte scheduler. It enforces the policy's computed
 * upload ceiling for writes submitted through it; it does not shape other
 * processes or inbound traffic. Missing telemetry fails closed.
 */
export class AdaptiveTransferScheduler {
  constructor({ policy, getTelemetry, now = () => Date.now(), maxQueuedBytes = 4 * 1024 * 1024, minTickMs = 10 } = {}) {
    if (!policy || typeof policy.evaluate !== 'function') throw new TypeError('A bandwidth policy is required');
    if (typeof getTelemetry !== 'function') throw new TypeError('getTelemetry must be a function');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < 1 || maxQueuedBytes > 1024 * 1024 * 1024) throw new RangeError('Invalid maxQueuedBytes');
    if (!Number.isSafeInteger(minTickMs) || minTickMs < 1 || minTickMs > 1000) throw new RangeError('Invalid minTickMs');
    this.policy = policy; this.getTelemetry = getTelemetry; this.now = now;
    this.maxQueuedBytes = maxQueuedBytes; this.minTickMs = minTickMs;
    this.queue = []; this.queuedBytes = 0; this.tokens = 0; this.lastRefillAt = now();
    this.timer = null; this.closed = false; this.pumping = false; this.activeItem = null;
    this.closedPromise = new Promise(resolve => { this.resolveClosed = resolve; });
  }

  enqueue(socket, frame) {
    if (this.closed) return Promise.reject(new Error('Transfer scheduler is closed'));
    if (!socket || socket.destroyed || !socket.writable) return Promise.reject(new Error('Peer socket is not writable'));
    if (!Buffer.isBuffer(frame) || frame.length < 1) return Promise.reject(new TypeError('frame must be a non-empty Buffer'));
    if (this.queuedBytes + frame.length > this.maxQueuedBytes) return Promise.reject(new Error('Outbound bandwidth queue capacity reached'));
    return new Promise((resolve, reject) => {
      this.queue.push({ socket, frame, resolve, reject });
      this.queuedBytes += frame.length;
      this.#schedule(0);
    });
  }

  #schedule(delay) {
    if (this.closed || this.timer !== null || this.pumping) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // #pump is intentionally fire-and-forget; contain unexpected dependency
      // failures and settle every queued caller instead of leaking an unhandled
      // rejection while leaving transfers permanently pending.
      void this.#pump().catch(error => {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        const pending = this.queue.splice(0);
        this.queuedBytes = 0;
        for (const item of pending) item.reject(error);
      });
    }, delay);
  }

  async #pump() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    let nextDelay = this.minTickMs;
    try {
      while (!this.closed && this.queue.length) {
        const telemetryResult = await Promise.race([
          Promise.resolve().then(() => this.getTelemetry())
            .then(value => ({ value }), () => ({ value: null })),
          this.closedPromise.then(() => ({ closed: true }))
        ]);
        if (telemetryResult.closed || this.closed) break;
        const telemetry = telemetryResult.value;
        const budget = this.policy.evaluate(telemetry ?? {});
        if (!budget.enabled || !Number.isFinite(budget.uploadKiBps) || budget.uploadKiBps <= 0) {
          // Reject queued transfers instead of retaining data while the policy is disabled.
          const pending = this.queue.splice(0);
          this.queuedBytes = 0;
          for (const item of pending) item.reject(new Error(`Outbound transfer disabled: ${budget.reason ?? 'no-budget'}`));
          break;
        }
        const time = this.now();
        const rate = budget.uploadKiBps * 1024;
        const item = this.queue[0];
        // A token bucket capped below a frame's size can never transmit that
        // frame, regardless of how long it waits. Permit one queued frame to
        // accumulate enough tokens while still refilling at the configured rate.
        const burstCapacity = Math.max(rate, item.frame.length);
        const elapsed = Math.max(0, time - this.lastRefillAt);
        this.tokens = Math.min(burstCapacity, this.tokens + elapsed * rate / 1000);
        this.lastRefillAt = time;
        if (item.socket.destroyed || !item.socket.writable) {
          this.queue.shift(); this.queuedBytes -= item.frame.length;
          item.reject(new Error('Peer socket is not writable')); continue;
        }
        if (this.tokens < item.frame.length) {
          const waitMs = Math.max(this.minTickMs, Math.ceil((item.frame.length - this.tokens) * 1000 / rate));
          nextDelay = waitMs;
          break;
        }
        this.queue.shift(); this.queuedBytes -= item.frame.length; this.tokens -= item.frame.length;
        let cancelWrite;
        const cancelled = new Promise((_, reject) => { cancelWrite = reject; });
        item.cancelWrite = cancelWrite;
        this.activeItem = item;
        try {
          const writeCompleted = new Promise((resolve, reject) => {
            item.socket.write(item.frame, error => error ? reject(error) : resolve());
          });
          await Promise.race([writeCompleted, cancelled]);
          item.resolve({ bytes: item.frame.length, uploadKiBps: budget.uploadKiBps });
        } catch (error) { item.reject(error); }
        finally {
          item.cancelWrite = null;
          if (this.activeItem === item) this.activeItem = null;
        }
      }
    } finally {
      this.pumping = false;
      if (this.queue.length && !this.closed && this.timer === null) this.#schedule(nextDelay);
    }
  }

  close(reason = new Error('Transfer scheduler is closed')) {
    if (this.closed) return;
    this.closed = true;
    this.resolveClosed();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    // Reject the write currently awaiting a socket callback as well as queued
    // work. A stalled or closing socket must not leave enqueue() callers pending.
    if (this.activeItem) {
      this.activeItem.reject(reason);
      this.activeItem.cancelWrite?.(reason);
      this.activeItem = null;
    }
    for (const item of this.queue.splice(0)) item.reject(reason);
    this.queuedBytes = 0;
  }
}
