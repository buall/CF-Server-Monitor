// Read-only checks against the current main program. No D1, Cloudflare or SSH access.
import assert from 'node:assert/strict';
import test from 'node:test';
import { serveFrontend } from '../../../src/handlers/frontend.js';
import { MetricsBroadcaster } from '../../../src/durable/MetricsBroadcaster.js';

test('normal theme HTML denies framing; admin uses the builtin frontend', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    return new Response('<html><head></head><body>original-theme</body></html>');
  };
  try {
    const env = { ASSETS: { fetch: async () => new Response('<html><head></head><body>builtin-admin</body></html>') } };
    const settings = { theme_url: 'https://github.com/example/theme/tree/build' };
    const theme = await serveFrontend(new Request('https://monitor.example/'), env, settings);
    assert.match(await theme.text(), /original-theme/);
    assert.equal(theme.headers.get('X-Frame-Options'), 'DENY');
    assert.match(theme.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
    const before = requests.length;
    const admin = await serveFrontend(new Request('https://monitor.example/admin'), env, settings);
    assert.match(await admin.text(), /builtin-admin/);
    assert.equal(requests.length, before);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('current subscription selection is mutable and is not a node ACL', async () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  let attachment = { scope: a, serverIds: [a] };
  const messages = [];
  const socket = {
    deserializeAttachment: () => attachment,
    serializeAttachment: value => { attachment = value; },
    send: value => messages.push(JSON.parse(value)),
    close: () => assert.fail('valid subscription syntax should be accepted by upstream')
  };
  const broadcaster = Object.create(MetricsBroadcaster.prototype);
  broadcaster.state = { getWebSockets: () => [socket] };
  // Avoid unrelated Agent interval hints; subscription and delivery methods are original.
  broadcaster._hintAgentRealtimeIntervals = async () => {};
  await broadcaster.webSocketMessage(socket, JSON.stringify({ type: 'subscribe', scope: 'all', ids: [b] }));
  assert.deepEqual(attachment, { scope: 'all', serverIds: [b] });
  broadcaster._broadcastBatch([
    { serverId: a, samples: [{ ts: 1, data: { cpu: 1 } }] },
    { serverId: b, samples: [{ ts: 1, data: { cpu: 2 } }] }
  ], 1);
  const batch = messages.find(message => message.type === 'batchUpdate');
  assert.deepEqual(batch.updates.map(update => update.serverId), [b]);
});
