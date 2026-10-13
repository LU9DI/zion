import { Pool } from 'pg';
import { PostgresPeerAdmissionStore } from '../../src/peer-admission-postgres-store.js';

const pool = new Pool({
  connectionString: process.env.ZION_POSTGRES_TEST_URL,
  max: 1,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 1000,
});

try {
  const input = JSON.parse(process.env.ZION_ADMISSION_INPUT_JSON ?? 'null');
  const store = new PostgresPeerAdmissionStore({ pool, maxTransactionRetries: 5 });
  const result = await store.commitAdmission(input);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
