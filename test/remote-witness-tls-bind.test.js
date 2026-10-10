import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('remote witness refuses non-loopback plaintext bind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-witness-tls-'));
  try {
    const keys = generateKeyPairSync('ed25519');
    const privatePath = join(dir, 'witness.pem');
    const tokenPath = join(dir, 'token');
    writeFileSync(privatePath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(tokenPath, 'a'.repeat(48), { mode: 0o600 });
    const result = spawnSync(process.execPath, ['scripts/serve-remote-witness.js'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
      env: { ...process.env, ZION_WITNESS_ID: 'tls-test', ZION_WITNESS_KEY_ID: 'key', ZION_WITNESS_PRIVATE_KEY: privatePath, ZION_WITNESS_STATE: join(dir, 'state.json'), ZION_WITNESS_CLIENT_TOKEN_FILE: tokenPath, ZION_WITNESS_HOST: '0.0.0.0', ZION_WITNESS_PORT: '18787' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Non-loopback bind requires TLS/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('remote witness rejects incomplete TLS configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-witness-tls-'));
  try {
    const keys = generateKeyPairSync('ed25519');
    const privatePath = join(dir, 'witness.pem');
    const tokenPath = join(dir, 'token');
    writeFileSync(privatePath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(tokenPath, 'a'.repeat(48), { mode: 0o600 });
    const result = spawnSync(process.execPath, ['scripts/serve-remote-witness.js'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
      env: { ...process.env, ZION_WITNESS_ID: 'tls-test', ZION_WITNESS_KEY_ID: 'key', ZION_WITNESS_PRIVATE_KEY: privatePath, ZION_WITNESS_STATE: join(dir, 'state.json'), ZION_WITNESS_CLIENT_TOKEN_FILE: tokenPath, ZION_WITNESS_TLS_CERT: join(dir, 'missing-cert.pem'), ZION_WITNESS_TLS_KEY: '' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /TLS requires both/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
