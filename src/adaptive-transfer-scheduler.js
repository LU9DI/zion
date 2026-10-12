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
    this.timer = setTimeout(() => { this.timer = null; void this.#pump(); }, delay);
  }

  async #pump() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && this.queue.length) {
        let telemetry;
        try { telemetry = await this.getTelemetry(); } catch { telemetry = null; }
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
        const elapsed = Math.max(0, time - this.lastRefillAt);
        this.tokens = Math.min(rate, this.tokens + elapsed * rate / 1000);
        this.lastRefillAt = time;
        const item = this.queue[0];
        if (item.socket.destroyed || !item.socket.writable) {
          this.queue.shift(); this.queuedBytes -= item.frame.length;
          item.reject(new Error('Peer socket is not writable')); continue;
        }
        if (this.tokens < item.frame.length) {
          const waitMs = Math.max(this.minTickMs, Math.ceil((item.frame.length - this.tokens) * 1000 / rate));
          this.#schedule(waitMs);
          break;
        }
        this.queue.shift(); this.queuedBytes -= item.frame.length; this.tokens -= item.frame.length;
        this.activeItem = item;
        try {
          await new Promise((resolve, reject) => {
            item.socket.write(item.frame, error => error ? reject(error) : resolve());
          });
          item.resolve({ bytes: item.frame.length, uploadKiBps: budget.uploadKiBps });
        } catch (error) { item.reject(error); }
        finally { if (this.activeItem === item) this.activeItem = null; }
      }
    } finally {
      this.pumping = false;
      if (this.queue.length && !this.closed && this.timer === null) this.#schedule(this.minTickMs);
    }
  }

  close(reason = new Error('Transfer scheduler is closed')) {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    // Reject the write currently awaiting a socket callback as well as queued
    // work. A stalled or closing socket must not leave enqueue() callers pending.
    if (this.activeItem) {
      this.activeItem.reject(reason);
      this.activeItem = null;
    }
    for (const item of this.queue.splice(0)) item.reject(reason);
    this.queuedBytes = 0;
  }
}
