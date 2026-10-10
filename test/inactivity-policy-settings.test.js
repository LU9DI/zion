import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadSettings(storage = null) {
  const window = { localStorage: storage };
  vm.runInNewContext(readFileSync(new URL('../cloud/inactivity-settings.js', import.meta.url), 'utf8'), { window, Object, Number, JSON, String });
  return window.ZionInactivitySettings;
}
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key,value) => values.set(key,value), removeItem: key => values.delete(key), values };
}

test('uses documented defaults and previews all four deadlines', () => {
  const api = loadSettings();
  assert.deepEqual(JSON.parse(JSON.stringify(api.defaults)), { pauseWarningAtDays: 7, pauseAfterDays: 14, reductionWarningAtDays: 30, reduceAfterDays: 37, reductionPercent: 50 });
  const preview = api.preview(api.defaults);
  assert.equal(preview.ok, true);
  assert.equal(preview.daysBetweenReductionWarningAndAction, 7);
  assert.equal(preview.remainingCapacityPercent, 50);
});

test('rejects pause warning after the pause deadline', () => {
  const api = loadSettings();
  const result = api.validate({ ...api.defaults, pauseWarningAtDays: 14 });
  assert.equal(result.ok, false);
  assert.match(result.error, /aviso da pausa/);
});

test('rejects reduction deadlines that precede or equal their warning', () => {
  const api = loadSettings();
  assert.equal(api.validate({ ...api.defaults, reduceAfterDays: 30 }).ok, false);
  assert.equal(api.validate({ ...api.defaults, reductionWarningAtDays: 14 }).ok, false);
});

test('rejects invalid or extreme reduction percentages', () => {
  const api = loadSettings();
  assert.equal(api.validate({ ...api.defaults, reductionPercent: 0 }).ok, false);
  assert.equal(api.validate({ ...api.defaults, reductionPercent: 100 }).ok, false);
  assert.equal(api.validate({ ...api.defaults, reductionPercent: 20.5 }).ok, false);
});

test('saves and reloads only validated browser-local preferences', () => {
  const storage = memoryStorage(); const api = loadSettings(storage);
  const changed = { ...api.defaults, pauseAfterDays: 21, pauseWarningAtDays: 10 };
  assert.equal(api.save(storage, changed).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(api.load(storage))), { ...changed, persistence: 'saved-local' });
  assert.equal(api.save(storage, { ...changed, reductionPercent: 99 }).ok, false);
});

test('falls back safely when storage is unavailable or contains invalid data', () => {
  const broken = { getItem() { throw new Error('blocked'); } };
  const api = loadSettings(broken);
  assert.equal(api.load(broken).persistence, 'storage-unavailable');
  const storage = memoryStorage(); storage.setItem(api.KEY, '{not-json');
  assert.equal(api.load(storage).persistence, 'invalid-reset');
});

test('cannot claim the settings are applied to a node', () => {
  const api = loadSettings();
  assert.match(api.preview(api.defaults).note, /só serão aplicados a um nó quando houver backend conectado/);
});

test('cloud settings page exposes accessible controls and loads the settings model first', () => {
  const html = readFileSync(new URL('../cloud/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="idle-pause-warning"/);
  assert.match(html, /id="idle-pause-after"/);
  assert.match(html, /id="idle-reduction-warning"/);
  assert.match(html, /id="idle-reduction-after"/);
  assert.match(html, /id="idle-reduction-percent"/);
  assert.match(html, /id="inactivity-preview-text"/);
  assert.ok(html.indexOf('inactivity-settings.js') < html.indexOf('app.js'));
  assert.match(html, /não altera um nó real/);
});
