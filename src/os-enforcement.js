import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const MiB = 1024 * 1024;
const safeComponent = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(value)) {
    throw new TypeError('Cgroup name must contain only letters, digits, underscore or hyphen');
  }
  return value;
};

/**
 * Partial cgroup v2 enforcement for a separately launched worker process.
 * It enforces CPU, memory and PID ceilings only. It does NOT enforce disk I/O,
 * network bandwidth, thermal limits, or user-activity policy, so `complete`
 * deliberately remains false and must never authorize production participation.
 * The caller must configure a delegated, writable cgroup parent for this service.
 */
export class LinuxCgroupV2Adapter {
  constructor({ root = '/sys/fs/cgroup/rea-cloud', name = `worker-${process.pid}`, fs = { mkdir, readFile, writeFile, rm, access } } = {}) {
    if (process.platform !== 'linux') throw new Error('Linux cgroup v2 is only available on Linux');
    this.root = path.resolve(root);
    this.name = safeComponent(name);
    this.directory = path.join(this.root, this.name);
    this.fs = fs;
    this.verified = false;
    this.complete = false;
    this.capabilities = Object.freeze({ cpu: false, memory: false, pids: false, diskIo: false, network: false, thermal: false });
  }

  async initialize({ maxCpuPercent = 1, maxMemoryMiB = 128, maxPids = 8 } = {}) {
    if (!Number.isFinite(maxCpuPercent) || maxCpuPercent <= 0 || maxCpuPercent > 100 ||
        !Number.isSafeInteger(maxMemoryMiB) || maxMemoryMiB < 1 ||
        !Number.isSafeInteger(maxPids) || maxPids < 1 || maxPids > 4096) {
      throw new RangeError('Invalid cgroup resource limits');
    }
    // Refuse symlink-like path escapes by requiring a direct child name.
    if (path.dirname(this.directory) !== this.root) throw new Error('Invalid cgroup directory');
    await this.fs.access(path.join(this.root, 'cgroup.controllers'));
    const controllers = (await this.fs.readFile(path.join(this.root, 'cgroup.controllers'), 'utf8')).trim().split(/\s+/);
    if (!controllers.includes('cpu') || !controllers.includes('memory') || !controllers.includes('pids')) {
      throw new Error('Required cgroup v2 controllers (cpu, memory, pids) are unavailable');
    }
    await this.fs.mkdir(this.directory, { recursive: false });
    try {
      const period = 100_000;
      const quota = Math.max(1_000, Math.floor(period * maxCpuPercent / 100));
      await this.fs.writeFile(path.join(this.directory, 'cpu.max'), `${quota} ${period}`);
      await this.fs.writeFile(path.join(this.directory, 'memory.max'), String(maxMemoryMiB * MiB));
      await this.fs.writeFile(path.join(this.directory, 'pids.max'), String(maxPids));
      const [cpu, memory, pids] = await Promise.all([
        this.fs.readFile(path.join(this.directory, 'cpu.max'), 'utf8'),
        this.fs.readFile(path.join(this.directory, 'memory.max'), 'utf8'),
        this.fs.readFile(path.join(this.directory, 'pids.max'), 'utf8'),
      ]);
      if (cpu.trim() !== `${quota} ${period}` || memory.trim() !== String(maxMemoryMiB * MiB) || pids.trim() !== String(maxPids)) {
        throw new Error('cgroup limits did not read back as configured');
      }
      this.verified = true;
      this.capabilities = Object.freeze({ cpu: true, memory: true, pids: true, diskIo: false, network: false, thermal: false });
      return Object.freeze({ verified: true, complete: false, directory: this.directory, capabilities: this.capabilities });
    } catch (error) {
      this.verified = false;
      await this.fs.rm(this.directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async attachPid(pid) {
    if (!this.verified) throw new Error('cgroup limits must be verified before attaching a process');
    if (!Number.isSafeInteger(pid) || pid < 2) throw new RangeError('Invalid worker PID');
    await this.fs.writeFile(path.join(this.directory, 'cgroup.procs'), String(pid));
  }

  async close() {
    this.verified = false;
    // cgroups with active processes cannot be safely removed; don't force-kill them.
    await this.fs.rm(this.directory, { recursive: false }).catch(error => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY' && error.code !== 'EBUSY') throw error;
    });
  }
}

/** Detect support without pretending that detection itself enforces anything. */
export function getEnforcementStatus(platform = os.platform()) {
  if (platform === 'linux') return Object.freeze({ platform, supported: true, complete: false, enforced: false, missing: ['disk-io', 'network-bandwidth', 'thermal-monitoring', 'user-activity-policy'] });
  if (platform === 'win32') return Object.freeze({ platform, supported: false, complete: false, enforced: false, missing: ['Windows Job Objects adapter', 'disk-io', 'network-bandwidth', 'thermal-monitoring', 'user-activity-policy'] });
  if (platform === 'darwin') return Object.freeze({ platform, supported: false, complete: false, enforced: false, missing: ['macOS resource enforcement adapter', 'disk-io', 'network-bandwidth', 'thermal-monitoring', 'user-activity-policy'] });
  return Object.freeze({ platform, supported: false, complete: false, enforced: false, missing: ['platform adapter'] });
}
