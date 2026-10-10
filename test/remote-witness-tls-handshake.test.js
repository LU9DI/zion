import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixtureDir = join(here, 'fixtures', 'witness-tls');
const cert = readFileSync(join(fixtureDir, 'localhost-cert.pem'));
const key = readFileSync(join(fixtureDir, 'localhost-key.pem'));
const testCa = readFileSync(join(fixtureDir, 'test-ca.pem'));
const expiredCert = readFileSync(join(fixtureDir, 'expired-localhost-cert.pem'));
const expiredKey = readFileSync(join(fixtureDir, 'expired-localhost-key.pem'));
const expiredTestCa = readFileSync(join(fixtureDir, 'expired-test-ca.pem'));

async function withTlsServer(t, run) {
  const server = createServer({ cert, key }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(() => resolve())));
  await run(server.address().port);
}

function tlsRequest(port, { servername = 'localhost', ca } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: '/', method: 'GET',
      servername, ...(ca ? { ca } : {}),
      rejectUnauthorized: true, timeout: 3000,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.once('error', reject);
    req.end();
  });
}

test('Witness TLS: trusted CA and matching hostname complete a real HTTPS handshake', async t => {
  await withTlsServer(t, async port => {
    const response = await tlsRequest(port, { servername: 'localhost', ca: testCa });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true });
  });
});

test('Witness TLS: trusted chain with hostname mismatch is rejected', async t => {
  await withTlsServer(t, async port => {
    await assert.rejects(tlsRequest(port, { servername: 'wrong.example', ca: testCa }), /hostname|subject alternative name|certificate/i);
  });
});

test('Witness TLS: certificate from an untrusted test CA is rejected', async t => {
  await withTlsServer(t, async port => {
    await assert.rejects(tlsRequest(port, { servername: 'localhost' }), /self-signed|issuer|certificate|unable to verify/i);
  });
});


test('Witness TLS: an expired certificate is rejected even when its issuing CA is trusted', async t => {
  const server = createServer({ cert: expiredCert, key: expiredKey }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(() => resolve())));
  await assert.rejects(
    tlsRequest(server.address().port, { servername: 'localhost', ca: expiredTestCa }),
    /certificate has expired|CERT_HAS_EXPIRED|certificate/i,
  );
});
