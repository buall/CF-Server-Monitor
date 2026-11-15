import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchHistoryData } from '../src/handlers/history.js';
import { handleShellAtlas } from '../src/integrations/shellatlas.js';
import { clearAllCaches, setMetricsHistoryCache } from '../src/utils/cache.js';

const appPassword = 'history-test-password';
const settings = { is_public: 'true', app_password: appPassword, long_history_points: '120' };

function historyFixture() {
  clearAllCaches();
  const servers = [
    { id: 'visible-history', is_hidden: 0 },
    { id: 'hidden-history', is_hidden: 1 }
  ];
  const samples = [{ timestamp: Date.now(), cpu: 42 }];
  for (const server of servers) {
    for (const hours of [24, 48, 168]) setMetricsHistoryCache(server.id, hours, 'cpu', samples, 120);
  }
  const env = { DB: { prepare: () => ({ bind: id => ({ first: async () => servers.find(server => server.id === id) || null }) }) } };
  const read = (id, hours, password, sys = settings, trustedRead = false) => fetchHistoryData(
    env,
    new Request(`https://monitor.example/api/history/all?id=${id}&hours=${hours}`, {
      headers: password ? { 'X-App-Password': password } : {}
    }),
    id, hours, 'cpu', sys, trustedRead
  );
  return { read, samples };
}

test('history authorization checks hidden nodes and long queries before returning cached data', async () => {
  const { read, samples } = historyFixture();
  try {
    assert.equal((await read('visible-history', 24)).status, 200);
    assert.equal((await read('hidden-history', 24)).status, 404);
    assert.equal((await read('visible-history', 48)).status, 401);
    assert.equal((await read('hidden-history', 48, 'incorrect-password')).status, 401);
    for (const id of ['visible-history', 'hidden-history']) {
      for (const hours of [24, 48, 168]) {
        const response = await read(id, hours, appPassword);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), samples);
      }
    }
    assert.equal((await read('missing-history', 48, appPassword)).status, 404);
    assert.equal((await read('visible-history', 999, appPassword)).status, 400);
  } finally {
    clearAllCaches();
  }
});

test('private history accepts the upstream App password and the verified dashboard read context', async () => {
  const { read, samples } = historyFixture();
  const privateSettings = { ...settings, is_public: 'false' };
  try {
    assert.equal((await read('visible-history', 24, null, privateSettings)).status, 401);
    for (const password of [undefined, 'incorrect-password']) {
      assert.equal((await read('hidden-history', 48, password, privateSettings)).status, 401);
    }
    const app = await read('hidden-history', 48, appPassword, privateSettings);
    assert.equal(app.status, 200);
    assert.deepEqual(await app.json(), samples);
    const dashboard = await read('hidden-history', 48, null, privateSettings, true);
    assert.equal(dashboard.status, 200);
    assert.deepEqual(await dashboard.json(), samples);
  } finally {
    clearAllCaches();
  }
});

test('the upstream App password cannot replace Cloudflare service authentication on integration routes', async () => {
  const env = {
    SHELLATLAS_ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com',
    SHELLATLAS_ACCESS_AUD: 'application-a'
  };
  for (const path of ['health', 'dashboard/embed/api/servers', 'nodes/11111111-1111-4111-8111-111111111111/embed/api/servers']) {
    const response = await handleShellAtlas(new Request(`https://monitor.example/integrations/shellatlas/${path}`, {
      headers: { 'X-App-Password': appPassword }
    }), env, {});
    assert.equal(response.status, 401);
  }
});
