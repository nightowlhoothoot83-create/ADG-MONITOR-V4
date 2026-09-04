import assert from 'node:assert/strict';
import test from 'node:test';
import { createScopedKV } from '../src/scoped-kv.js';

function fakeKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  const calls = [];
  return {
    store,
    calls,
    async get(key, type) {
      calls.push(['get', key, type]);
      if (!store.has(key)) return null;
      const value = store.get(key);
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) { calls.push(['put', key, value]); store.set(key, value); },
    async delete(key) { calls.push(['delete', key]); store.delete(key); },
    async list({ prefix = '' } = {}) {
      calls.push(['list', prefix]);
      return { keys: [...store.keys()].filter(name => name.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    },
    async getWithMetadata(key) {
      calls.push(['getWithMetadata', key]);
      return { value: store.has(key) ? store.get(key) : null, metadata: store.has(key) ? { source: key } : null };
    }
  };
}

test('reads scoped value before any legacy fallback', async () => {
  const kv = fakeKv({ 'adsense:latest-report-v5': '{"scoped":true}', 'latest-report-v5': '{"legacy":true}' });
  const scoped = createScopedKV(kv, 'adsense');
  assert.deepEqual(await scoped.get('latest-report-v5', 'json'), { scoped: true });
  assert.deepEqual(kv.calls.filter(call => call[0] === 'get').map(call => call[1]), ['adsense:latest-report-v5']);
});

test('allowlisted legacy values remain readable after scope rollout', async () => {
  const kv = fakeKv({ 'latest-report-v5': '{"legacy":true}' });
  const scoped = createScopedKV(kv, 'adsense');
  assert.deepEqual(await scoped.get('latest-report-v5', 'json'), { legacy: true });
  assert.deepEqual(kv.calls.filter(call => call[0] === 'get').map(call => call[1]), ['adsense:latest-report-v5', 'latest-report-v5']);
});

test('unknown and cross-monitor legacy keys never leak across scopes', async () => {
  const kv = fakeKv({ 'saas-shell-monitor-report-v4': '{"legacy":true}', 'mystery-key': 'secret' });
  const adsense = createScopedKV(kv, 'adsense');
  assert.equal(await adsense.get('saas-shell-monitor-report-v4', 'json'), null);
  assert.equal(await adsense.get('mystery-key'), null);
  assert.equal(kv.calls.some(call => call[1] === 'saas-shell-monitor-report-v4'), false);
  assert.equal(kv.calls.some(call => call[1] === 'mystery-key'), false);
});

test('all writes and deletes remain scoped only', async () => {
  const kv = fakeKv({ 'latest-report-v5': 'legacy' });
  const scoped = createScopedKV(kv, 'adsense');
  await scoped.put('latest-report-v5', 'new');
  assert.equal(kv.store.get('adsense:latest-report-v5'), 'new');
  assert.equal(kv.store.get('latest-report-v5'), 'legacy');
  await scoped.delete('latest-report-v5');
  assert.equal(kv.store.has('adsense:latest-report-v5'), false);
  assert.equal(kv.store.get('latest-report-v5'), 'legacy');
});

test('list hides physical scope prefixes from callers', async () => {
  const kv = fakeKv({ 'adsense:one': '1', 'adsense:sub:two': '2', 'saas:one': '3' });
  const scoped = createScopedKV(kv, 'adsense');
  const all = await scoped.list();
  assert.deepEqual(all.keys.map(item => item.name).sort(), ['one', 'sub:two']);
  const sub = await scoped.list({ prefix: 'sub:' });
  assert.deepEqual(sub.keys.map(item => item.name), ['sub:two']);
});

test('getWithMetadata uses legacy fallback only for allowlisted keys', async () => {
  const kv = fakeKv({ 'saas-alert-report-v1': 'legacy' });
  const scoped = createScopedKV(kv, 'saas');
  const result = await scoped.getWithMetadata('saas-alert-report-v1');
  assert.equal(result.value, 'legacy');
  assert.equal(result.metadata.source, 'saas-alert-report-v1');
});
