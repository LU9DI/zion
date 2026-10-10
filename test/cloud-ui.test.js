import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`preview server exited early with ${child.exitCode}`);
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('preview server did not become ready');
}

test('cloud preview serves the UI and assets with defensive headers', async t => {
  const port = await freePort();
  const child = spawn(process.execPath, ['scripts/serve-cloud.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore'
  });
  t.after(() => { child.kill('SIGTERM'); });
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(base, child);
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(html.headers.get('content-security-policy'), /default-src 'self'/);
  const htmlBody = await html.text();
  assert.match(htmlBody, /Meus arquivos/);
  assert.match(htmlBody, /Social e mensagens/);
  assert.match(htmlBody, /data-page="notificacoes"/);
  assert.match(htmlBody, /Central de notificações/);
  assert.match(htmlBody, /inactivity-notifications-api-client\.js/);
  assert.match(htmlBody, /mensagens não são entregues a outros usuários/i);
  const css = await fetch(`${base}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const js = await fetch(`${base}/app.js`);
  assert.equal(js.status, 200);
  const jsBody = await js.text();
  assert.match(jsBody, /Adicionado\(s\) à visualização local/);
  assert.match(jsBody, /function renderPeople/);
  assert.match(jsBody, /function renderNotifications/);
  assert.match(jsBody, /Marcar como visualizada/);
  const notificationsClient = await fetch(`${base}/inactivity-notifications-api-client.js`);
  assert.equal(notificationsClient.status, 200);
  assert.match(await notificationsClient.text(), /markViewed/);
  assert.match(jsBody, /Mensagem registrada nesta prévia; não foi enviada pela rede/);
});

test('cloud preview rejects unsupported methods and missing paths', async t => {
  const port = await freePort();
  const child = spawn(process.execPath, ['scripts/serve-cloud.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore'
  });
  t.after(() => { child.kill('SIGTERM'); });
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(base, child);
  const post = await fetch(base, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  const missing = await fetch(`${base}/does-not-exist`);
  assert.equal(missing.status, 404);
});
