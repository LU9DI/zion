import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const mode = process.env.ZION_TEST_CRASH_MODE;
const originalLinkSync = fs.linkSync.bind(fs);
const originalFsyncSync = fs.fsyncSync.bind(fs);

const terminateAbruptly = () => {
  // Windows child processes cannot report POSIX SIGKILL; exit without running
  // application cleanup there, while retaining a real uncatchable kill on POSIX.
  if (process.platform === 'win32') process.exit(137);
  process.kill(process.pid, 'SIGKILL');
};

if (mode === 'before-link') {
  fs.linkSync = terminateAbruptly;
} else if (mode === 'after-link') {
  fs.linkSync = (source, target) => {
    originalLinkSync(source, target);
    terminateAbruptly();
  };
} else if (mode === 'directory-fsync-error') {
  fs.fsyncSync = fd => {
    try {
      if (fs.fstatSync(fd).isDirectory()) {
        const error = new Error('injected directory fsync failure');
        error.code = 'EIO';
        throw error;
      }
    } catch (error) {
      if (error?.code === 'EIO') throw error;
    }
    return originalFsyncSync(fd);
  };
} else {
  throw new Error('Unknown ZION_TEST_CRASH_MODE');
}

syncBuiltinESMExports();
