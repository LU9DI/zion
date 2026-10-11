import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialNodeBootstrap } from '../src/official-node-bootstrap.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture({ verifyOk = true, failSecondCheck = false, failAdmissionPreflight = false, listenFails = false, failCloseCount = 0, failStopStorageCount = 0, listenGate = null, storageGate = null, stopStorageGate = null, notificationDeliveryWorker = null, idleParticipationScheduler = null } = {}) {
  const events = [];
  let checks = 0;
  let closeFailuresRemaining = failCloseCount;
  let stopFailuresRemaining = failStopStorageCount;
  let activeStopStorage = 0;
  let maxActiveStopStorage = 0;
  let transportListening = false;
  let storageRunning = false;
  const quarantineListeners = new Set();
  const guard = {
    addQuarantineListener(listener) { quarantineListeners.add(listener); return () => quarantineListeners.delete(listener); },
    async quarantine() { this.status = { verified: false, quarantined: true }; await Promise.allSettled([...quarantineListeners].map(listener => listener({ reason: 'test-quarantine' }))); },
    status: { verified: false, quarantined: false },
    async verify() {
      events.push('verify');
      if (!verifyOk) { this.status = { verified: false, quarantined: true }; return { ok: false, reason: 'hash-mismatch' }; }
      this.status = { verified: true, quarantined: false };
      return { ok: true };
    },
    async checkHealthy() {
      events.push('check');
      checks++;
      if (failSecondCheck && checks === 2) {
        this.status = { verified: false, quarantined: true };
        const error = new Error('integrity changed during startup'); error.code = 'ZION_INTEGRITY_QUARANTINED'; throw error;
      }
    },
    assertHealthy() {
      events.push('assert');
      if (!this.status.verified || this.status.quarantined) throw Object.assign(new Error('not healthy'), { code: 'ZION_INTEGRITY_QUARANTINED' });
    }
  };
  const transport = {
    networkMode: 'official',
    integrityGuard: guard,
    admissionController: {
      async admit() { return { ok: true }; },
      async isAdmitted() { return false; },
      async releaseAdmission() { return { ok: true }; },
      async verifyPersistentState() { events.push('verifyAdmissionState'); if (failAdmissionPreflight) throw new Error('admission database state inconsistent'); return { ok: true }; },
    },
    async listen() { events.push('listen'); if (listenGate) { listenGate.entered?.(); await listenGate.promise; } if (listenFails) throw new Error('bind failed'); transportListening = true; return { host: '127.0.0.1', port: 1234 }; },
    async close() { events.push('close'); if (closeFailuresRemaining-- > 0) throw new Error('transport close failed'); transportListening = false; },
    async getStatus() { return { listening: transportListening }; }
  };
  const bootstrap = new OfficialNodeBootstrap({
    integrityGuard: guard, transport,
    async startStorage() { events.push('startStorage'); if (storageGate) { storageGate.entered?.(); await storageGate.promise; } storageRunning = true; },
    async stopStorage() {
      events.push('stopStorage');
      activeStopStorage++; maxActiveStopStorage = Math.max(maxActiveStopStorage, activeStopStorage);
      try {
        if (stopStorageGate) { stopStorageGate.entered?.(); await stopStorageGate.promise; }
        if (stopFailuresRemaining-- > 0) throw new Error('storage stop failed');
        storageRunning = false;
      } finally { activeStopStorage--; }
    },
    async getStorageStatus() { return { running: storageRunning }; },
    notificationDeliveryWorker,
    idleParticipationScheduler
  });
  return { bootstrap, events, guard, transport, get maxActiveStopStorage() { return maxActiveStopStorage; } };
}

test('official bootstrap verifies release before opening storage and network', async () => {
  const { bootstrap, events } = fixture();
  const result = await bootstrap.start();
  assert.equal(result.ok, true);
  assert.ok(events.indexOf('verify') < events.indexOf('verifyAdmissionState'));
  assert.ok(events.indexOf('verifyAdmissionState') < events.indexOf('startStorage'));
  assert.ok(events.indexOf('startStorage') < events.indexOf('listen'));
  assert.equal(events.filter(e => e === 'listen').length, 1);
  await bootstrap.close();
  assert.ok(events.includes('stopStorage'));
});

test('inconsistent persistent admission state prevents storage and network startup', async () => {
  const { bootstrap, events } = fixture({ failAdmissionPreflight: true });
  await assert.rejects(bootstrap.start(), /admission database state inconsistent/);
  assert.ok(events.includes('verifyAdmissionState'));
  assert.equal(events.includes('startStorage'), false);
  assert.equal(events.includes('listen'), false);
});

test('invalid release manifest prevents storage and network startup', async () => {
  const { bootstrap, events } = fixture({ verifyOk: false });
  await assert.rejects(bootstrap.start(), { code: 'ZION_STARTUP_INTEGRITY_FAILED' });
  assert.equal(events.includes('startStorage'), false);
  assert.equal(events.includes('listen'), false);
  assert.ok(events.includes('close'));
});

test('integrity change between storage startup and bind closes storage without opening network', async () => {
  const { bootstrap, events } = fixture({ failSecondCheck: true });
  await assert.rejects(bootstrap.start(), { code: 'ZION_INTEGRITY_QUARANTINED' });
  assert.ok(events.includes('startStorage'));
  assert.ok(events.includes('stopStorage'));
  assert.equal(events.includes('listen'), false);
});

test('network bind failure rolls back started storage', async () => {
  const { bootstrap, events } = fixture({ listenFails: true });
  await assert.rejects(bootstrap.start(), /bind failed/);
  assert.ok(events.includes('stopStorage'));
  assert.ok(events.includes('close'));
});

test('runtime quarantine closes official transport and stops storage immediately', async () => {
  const { bootstrap, events, guard } = fixture();
  await bootstrap.start();
  await guard.quarantine();
  assert.ok(events.includes('close'));
  assert.ok(events.includes('stopStorage'));
  assert.equal(bootstrap.started, false);
  assert.equal(bootstrap.storageStarted, false);
  await bootstrap.close();
});

test('official bootstrap rejects legacy transport and incomplete guard at construction', () => {
  const valid = fixture();
  assert.throws(() => new OfficialNodeBootstrap({ integrityGuard: valid.guard, transport: { ...valid.transport, networkMode: 'legacy' }, startStorage: async () => {} }), /official-mode transport/);
  assert.throws(() => new OfficialNodeBootstrap({ integrityGuard: {}, transport: valid.transport, startStorage: async () => {} }), /complete IntegrityGuard/);
});


test('quarantine containment reports transport shutdown failure and can be retried', async () => {
  const { bootstrap, events, guard } = fixture({ failCloseCount: 1 });
  await bootstrap.start();
  await guard.quarantine();
  assert.equal(bootstrap.started, false);
  assert.equal(bootstrap.containmentStatus, 'failed');
  assert.match(bootstrap.containmentErrors.join(' '), /transport close failed/);
  const result = await bootstrap.retryContainment();
  assert.equal(result.status, 'contained');
  assert.equal(result.storageStopped, true);
  assert.equal(bootstrap.containmentErrors.length, 0);
  assert.equal(events.filter(event => event === 'close').length, 2);
});

test('failed storage shutdown preserves running-state evidence until retry succeeds', async () => {
  const { bootstrap, guard } = fixture({ failStopStorageCount: 1 });
  await bootstrap.start();
  await guard.quarantine();
  assert.equal(bootstrap.containmentStatus, 'failed');
  assert.equal(bootstrap.storageStarted, true, 'must not claim storage stopped when its adapter failed');
  const result = await bootstrap.retryContainment();
  assert.equal(result.status, 'contained');
  assert.equal(result.storageStopped, true);
  assert.equal(bootstrap.storageStarted, false);
});

test('containment retry is forbidden before quarantine', async () => {
  const { bootstrap } = fixture();
  await assert.rejects(bootstrap.retryContainment(), /only allowed while integrity quarantine is active/);
});


test('quarantine during asynchronous listen cannot mark the node started after bind resolves', async () => {
  let signalListen;
  const entered = new Promise(resolve => { signalListen = resolve; });
  const gate = { ...deferred(), entered: signalListen };
  const { bootstrap, events, guard } = fixture({ listenGate: gate });
  const starting = bootstrap.start();
  await entered;
  await guard.quarantine();
  gate.resolve();
  await assert.rejects(starting, /quarantined|not healthy|integrity/i);
  assert.equal(bootstrap.started, false);
  assert.equal(bootstrap.storageStarted, false);
  assert.equal(bootstrap.containmentStatus, 'contained');
  assert.ok(events.filter(event => event === 'close').length >= 1);
});

test('quarantine during storage startup is reconciled after the adapter resolves', async () => {
  let signalStorage;
  const entered = new Promise(resolve => { signalStorage = resolve; });
  const gate = { ...deferred(), entered: signalStorage };
  const { bootstrap, events, guard } = fixture({ storageGate: gate });
  const starting = bootstrap.start();
  await entered;
  await guard.quarantine();
  gate.resolve();
  await assert.rejects(starting, /quarantined|not healthy|integrity/i);
  assert.equal(bootstrap.started, false);
  assert.equal(bootstrap.storageStarted, false);
  assert.equal(bootstrap.containmentStatus, 'contained');
  assert.ok(events.includes('stopStorage'));
  assert.equal(events.includes('listen'), false);
});

test('startup rollback reports failed containment when storage stop fails after a bind race', async () => {
  let signalListen;
  const entered = new Promise(resolve => { signalListen = resolve; });
  const gate = { ...deferred(), entered: signalListen };
  const { bootstrap, guard } = fixture({ listenGate: gate, failStopStorageCount: 2 });
  const starting = bootstrap.start();
  await entered;
  await guard.quarantine();
  gate.resolve();
  await assert.rejects(starting);
  assert.equal(bootstrap.started, false);
  assert.equal(bootstrap.storageStarted, true);
  assert.equal(bootstrap.containmentStatus, 'failed');
  assert.match(bootstrap.containmentErrors.join(' '), /storage stop failed/);
  const retried = await bootstrap.retryContainment();
  assert.equal(retried.status, 'contained');
  assert.equal(retried.storageStopped, true);
});


test('explicit close cancels and drains a pending network bind', async () => {
  let signalListen;
  const entered = new Promise(resolve => { signalListen = resolve; });
  const gate = { ...deferred(), entered: signalListen };
  const { bootstrap, events } = fixture({ listenGate: gate });
  const starting = bootstrap.start();
  await entered;
  const closing = bootstrap.close();
  gate.resolve();
  await assert.rejects(starting, error => error.code === 'ZION_STARTUP_CANCELLED');
  await closing;
  assert.equal(bootstrap.started, false);
  assert.equal(bootstrap.storageStarted, false);
  assert.equal(bootstrap.starting, false);
  assert.equal(bootstrap.containmentStatus, 'contained');
  assert.ok(events.filter(event => event === 'close').length >= 2);
  assert.ok(events.includes('stopStorage'));
});


test('concurrent close and containment retry serialize storage shutdown adapters', async () => {
  let signalStop;
  const entered = new Promise(resolve => { signalStop = resolve; });
  const gate = { ...deferred(), entered: signalStop };
  const fixtureState = fixture({ stopStorageGate: gate });
  const { bootstrap, guard, events } = fixtureState;
  await bootstrap.start();

  // Model a quarantine already latched while an operator races explicit close
  // with a retry request (for example, from an external supervisor).
  guard.status = { verified: false, quarantined: true };
  const closing = bootstrap.close();
  const retrying = bootstrap.retryContainment();
  await entered;
  gate.resolve();
  await Promise.all([closing, retrying]);

  assert.equal(bootstrap.started, false);
  assert.equal(bootstrap.storageStarted, false);
  assert.equal(bootstrap.containmentStatus, 'contained');
  assert.equal(fixtureState.maxActiveStopStorage, 1, 'storage shutdown adapters must never overlap');
  assert.ok(events.filter(event => event === 'stopStorage').length >= 1);
});


test('explicit close is terminal and cannot restart without a new bootstrap instance', async () => {
  const { bootstrap, events } = fixture();
  await bootstrap.start();
  await bootstrap.close();
  const storageStarts = events.filter(event => event === 'startStorage').length;
  const listens = events.filter(event => event === 'listen').length;
  assert.equal(bootstrap.closed, true);
  await assert.rejects(bootstrap.start(), { code: 'ZION_BOOTSTRAP_CLOSED' });
  assert.equal(events.filter(event => event === 'startStorage').length, storageStarts);
  assert.equal(events.filter(event => event === 'listen').length, listens);
});

test('close latches terminal state before waiting for an in-flight startup', async () => {
  let signalListen;
  const entered = new Promise(resolve => { signalListen = resolve; });
  const gate = { ...deferred(), entered: signalListen };
  const { bootstrap } = fixture({ listenGate: gate });
  const starting = bootstrap.start();
  await entered;
  const closing = bootstrap.close();
  assert.equal(bootstrap.closed, true);
  await assert.rejects(bootstrap.start(), { code: 'ZION_BOOTSTRAP_CLOSED' });
  gate.resolve();
  await assert.rejects(starting, error => error.code === 'ZION_STARTUP_CANCELLED');
  await closing;
  assert.equal(bootstrap.started, false);
});


test('containment report distinguishes adapter acknowledgement from observed stopped state', async () => {
  const { bootstrap, guard } = fixture();
  await bootstrap.start();
  await guard.quarantine();
  assert.deepEqual(bootstrap.containmentReport, {
    transport: 'stopped', storage: 'stopped', verifiedStopped: true,
    audit: { configured: false, errors: [] },
    evidence: { transport: 'adapter-observed', storage: 'adapter-observed' }
  });
  await bootstrap.close();
});

test('adapter reporting a still-active listener prevents verified containment', async () => {
  const state = fixture();
  await state.bootstrap.start();
  state.transport.getStatus = async () => ({ listening: true });
  await state.guard.quarantine();
  assert.equal(state.bootstrap.containmentStatus, 'failed');
  assert.equal(state.bootstrap.containmentReport.transport, 'running');
  assert.equal(state.bootstrap.containmentReport.verifiedStopped, false);
});

test('adapters without observation methods are reported as unverified, not stopped', async () => {
  const { bootstrap, guard, transport } = fixture();
  delete transport.getStatus;
  bootstrap.getStorageStatus = null;
  await bootstrap.start();
  await guard.quarantine();
  assert.equal(bootstrap.containmentStatus, 'contained', 'shutdown commands completed');
  assert.equal(bootstrap.containmentReport.transport, 'unknown');
  assert.equal(bootstrap.containmentReport.storage, 'unknown');
  assert.equal(bootstrap.containmentReport.verifiedStopped, false);
  assert.equal(bootstrap.containmentReport.evidence.transport, 'unverified');
});


test('containment emits bounded structured events to the optional audit adapter', async () => {
  const persisted = [];
  const base = fixture();
  const bootstrap = new OfficialNodeBootstrap({
    integrityGuard: base.guard, transport: base.transport,
    startStorage: async () => { await base.bootstrap.startStorage?.(); },
    stopStorage: async () => { await base.bootstrap.stopStorage?.(); },
    getStorageStatus: async () => ({ running: false }),
    recordContainmentEvent: async event => { persisted.push(event); },
    maxContainmentHistory: 2
  });
  await base.guard.quarantine();
  assert.ok(persisted.some(event => event.event === 'containment-started'));
  assert.ok(persisted.some(event => event.event === 'containment-completed'));
  assert.equal(bootstrap.containmentHistory.length, 2);
  assert.ok(bootstrap.containmentHistory.every(event => event.schema === 'zion.containment-event.v1'));
  assert.equal(bootstrap.containmentReport.audit.configured, true);
});

test('audit adapter failure is exposed without preventing urgent resource containment', async () => {
  const state = fixture();
  const bootstrap = new OfficialNodeBootstrap({
    integrityGuard: state.guard, transport: state.transport,
    startStorage: async () => {}, stopStorage: async () => {},
    getStorageStatus: async () => ({ running: false }),
    recordContainmentEvent: async () => { throw new Error('audit store unavailable'); }
  });
  await state.guard.quarantine();
  assert.equal(bootstrap.containmentStatus, 'contained');
  assert.equal(bootstrap.containmentReport.verifiedStopped, true);
  assert.ok(bootstrap.containmentReport.audit.errors.some(message => message.includes('audit store unavailable')));
});

test('containment adapter reporting a still-running storage resource preserves contradictory evidence', async () => {
  const state = fixture();
  const bootstrap = new OfficialNodeBootstrap({
    integrityGuard: state.guard, transport: state.transport,
    startStorage: async () => {}, stopStorage: async () => {},
    getStorageStatus: async () => ({ running: true })
  });
  // Model resources as having been started before quarantine.
  bootstrap.storageStarted = true;
  await state.guard.quarantine();
  assert.equal(bootstrap.containmentStatus, 'failed');
  assert.equal(bootstrap.containmentReport.storage, 'running');
  assert.equal(bootstrap.containmentReport.verifiedStopped, false);
});

test('inactivity scheduler starts only after healthy node startup and stops before storage shutdown', async () => {
  const state = fixture();
  const events = state.events;
  const bootstrap = new OfficialNodeBootstrap({
    integrityGuard: state.guard,
    transport: state.transport,
    async startStorage() { events.push('startStorage'); },
    async stopStorage() { events.push('stopStorage'); },
    async getStorageStatus() { return { running: false }; },
    inactivityScheduler: {
      start(options) { events.push(`inactivity-start:${options.runImmediately}`); },
      stop() { events.push('inactivity-stop'); }
    }
  });
  const result = await bootstrap.start();
  assert.equal(result.inactivityPolicy, 'scheduled');
  assert.ok(events.includes('inactivity-start:false'));
  assert.ok(events.indexOf('inactivity-start:false') > state.events.indexOf('listen'));
  await bootstrap.close();
  assert.ok(events.indexOf('inactivity-stop') < events.indexOf('stopStorage'));
});

test('inactivity scheduler is not started when integrity verification fails', async () => {
  const state = fixture({ verifyOk: false });
  let starts = 0;
  const bootstrap = new OfficialNodeBootstrap({
    integrityGuard: state.guard, transport: state.transport,
    async startStorage() {}, async stopStorage() {},
    inactivityScheduler: { start() { starts++; }, stop() {} }
  });
  await assert.rejects(bootstrap.start(), { code: 'ZION_STARTUP_INTEGRITY_FAILED' });
  assert.equal(starts, 0);
});

test('official bootstrap rejects malformed inactivity scheduler lifecycle adapter', () => {
  const state = fixture();
  assert.throws(() => new OfficialNodeBootstrap({ integrityGuard: state.guard, transport: state.transport,
    startStorage: async () => {}, inactivityScheduler: { start() {} } }), /inactivityScheduler must expose/);
});


test('notification delivery worker starts only after verified node startup and stops during shutdown', async () => {
  const lifecycle = [];
  const worker = {
    start(options) { lifecycle.push(`start:${options.runImmediately}`); },
    async stop() { lifecycle.push('stop'); }
  };
  const { bootstrap, events } = fixture({ notificationDeliveryWorker: worker });
  const result = await bootstrap.start();
  assert.equal(result.notificationDelivery, 'scheduled');
  assert.ok(events.indexOf('listen') >= 0);
  assert.deepEqual(lifecycle, ['start:false']);
  await bootstrap.close();
  assert.deepEqual(lifecycle, ['start:false', 'stop']);
});

test('notification API starts only after healthy transport and closes before transport shutdown', async () => {
  const state = fixture();
  const lifecycle = [];
  const api = {
    async listen() { lifecycle.push('api-listen'); return { host: '127.0.0.1', port: 1234 }; },
    async close() { lifecycle.push('api-close'); }
  };
  const bootstrap = new OfficialNodeBootstrap({
    integrityGuard: state.guard, transport: state.transport,
    async startStorage() { lifecycle.push('storage-start'); },
    async stopStorage() { lifecycle.push('storage-stop'); },
    notificationApi: api,
  });
  const result = await bootstrap.start();
  assert.equal(result.notificationApi, 'listening');
  assert.ok(lifecycle.indexOf('api-listen') > lifecycle.indexOf('storage-start'));
  await bootstrap.close();
  assert.ok(lifecycle.indexOf('api-close') >= 0);
  assert.ok(lifecycle.indexOf('api-close') < state.events.indexOf('close'));
});

test('official bootstrap rejects malformed notification API lifecycle adapter', () => {
  const state = fixture();
  assert.throws(() => new OfficialNodeBootstrap({ integrityGuard: state.guard, transport: state.transport,
    startStorage: async () => {}, notificationApi: { listen() {} } }), /notificationApi must expose/u);
});


test('starts idle participation scheduler only after the official network is healthy and drains it on close', async () => {
  const events = [];
  const idleParticipationScheduler = {
    start(options) { events.push(['idle-start', options]); },
    async stop() { events.push(['idle-stop']); },
  };
  const { bootstrap, events: bootstrapEvents } = fixture({ idleParticipationScheduler });
  const result = await bootstrap.start();
  assert.equal(result.idleParticipation, 'scheduled');
  assert.deepEqual(events, [['idle-start', { runImmediately: false }]]);
  assert.ok(bootstrapEvents.indexOf('listen') >= 0);
  await bootstrap.close();
  assert.deepEqual(events, [['idle-start', { runImmediately: false }], ['idle-stop']]);
});

test('idle participation scheduler failure rolls back startup', async () => {
  const idleParticipationScheduler = {
    start() { throw new Error('idle scheduler failed'); },
    async stop() {},
  };
  const { bootstrap, events } = fixture({ idleParticipationScheduler });
  await assert.rejects(bootstrap.start(), /idle scheduler failed/);
  assert.ok(events.includes('close'));
  assert.ok(events.includes('stopStorage'));
});

test('official bootstrap refuses a transport that bypasses persistent admission', () => {
  const { guard, transport } = fixture();
  assert.throws(() => new OfficialNodeBootstrap({
    integrityGuard: guard,
    transport: { ...transport, admissionController: null },
    startStorage: async () => {},
    stopStorage: async () => {},
  }), /persistent admission controller/);
});

test('official bootstrap refuses a transport wired to a different integrity guard', () => {
  const { guard, transport } = fixture();
  const otherGuard = {
    ...guard,
    status: { verified: false, quarantined: false },
    addQuarantineListener() { return () => {}; },
  };
  assert.throws(() => new OfficialNodeBootstrap({
    integrityGuard: otherGuard,
    transport,
    startStorage: async () => {},
    stopStorage: async () => {},
  }), /same IntegrityGuard instance/);
});
