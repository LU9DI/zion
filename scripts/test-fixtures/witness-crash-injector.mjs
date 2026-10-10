import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const mode = process.env.ZION_TEST_CRASH_MODE;
const originalLinkSync = fs.linkSync.bind(fs);
const originalFsyncSync = fs.fsyncSync.bind(fs);

if (mode === 'before-link') {
  fs.linkSync = () => process.kill(process.pid, 'SIGKILL');
} else if (mode === 'after-link') {
  fs.linkSync = (source, target) => {
    originalLinkSync(source, target);
    process.kill(process.pid, 'SIGKILL');
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
