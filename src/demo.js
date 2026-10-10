import { ResourceGovernor } from './resource-governor.js';

const governor = new ResourceGovernor({ limits: { maxCpuPercent: 3, maxUploadKiBps: 64 } });
const samples = [
  ['idle', { telemetryHealthy: true, cpuPercent: 8, memoryPressure: 0.2, diskBusy: 0.1, networkBusy: 0.1, temperatureC: 42, onBattery: false, userActive: false }],
  ['host busy', { telemetryHealthy: true, cpuPercent: 94, memoryPressure: 0.4, diskBusy: 0.2, networkBusy: 0.2, temperatureC: 58, onBattery: false, userActive: true }],
  ['telemetry missing', { telemetryHealthy: false }],
];
for (const [name, sample] of samples) console.log(name, governor.evaluate(sample));
