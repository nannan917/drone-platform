import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import WebSocket from 'ws';
import { encodeV2Frame } from '../src/mavlink.js';

test('REST deletion broadcasts removal and repeated telemetry cannot recreate the device', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drone-api-test-'));
  process.env.DRONE_DATA_DIR = dataDir;
  const { ApiServer } = await import('../src/api.js');
  const api = new ApiServer({ port: 0, apiToken: 'local-test', webRoot:fileURLToPath(new URL('../public/',import.meta.url)),logger: { info() {}, error() {} } });
  await api.start();
  const port = api.http.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {headers:{'X-API-Token':'local-test'}});
  t.after(async () => { ws.terminate(); api.stop(); await rm(dataDir, { recursive: true, force: true }); });
  await once(ws, 'open');
  const headers = { 'X-API-Token': 'local-test' };
  const url = `http://127.0.0.1:${port}/api/drones`;
  const heartbeat = encodeV2Frame({ sysid: 23, compid: 1, msgid: 0,
    payload: Buffer.from('00000000020c510303', 'hex') });
  const meta = { transport: 'udp', host: '127.0.0.1', port: 12345 };
  await api.gateway.receive(heartbeat, meta);
  let snapshot = await (await fetch(url, { headers })).json();
  assert.equal(snapshot.drones[0].droneId, 'real-23');
  const removal = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('missing removal event')), 2000);
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.type === 'presence' && message.data.reason === 'remove') {
        clearTimeout(timeout); resolve(message.data);
      }
    });
  });
  const response = await fetch(`${url}/real-23`, { method: 'DELETE', headers });
  assert.equal(response.status, 200);
  assert.equal((await removal).droneId, 'real-23');
  await api.gateway.receive(heartbeat, meta);
  snapshot = await (await fetch(url, { headers })).json();
  assert.deepEqual(snapshot.drones, []);
  assert.deepEqual(snapshot.arp, []);
  const script = await (await fetch(`http://127.0.0.1:${port}/device-state.js`)).text();
  assert.match(script, /export function forgetDrone/);
});
