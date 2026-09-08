import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { Aop } from '../src/aop.js';
import { ArpTable } from '../src/arp.js';
import { MavlinkGateway } from '../src/gateway.js';
import { DroneSimulator } from '../src/simulator.js';
import { decodePayload, encodeV2Frame, parseFrame, feed, crc16 } from '../src/mavlink.js';
import { forgetDrone, replaceSnapshot, applyPresence } from '../public/device-state.js';

const quiet = { info() {}, error() {} };
// Wire fixtures use the offsets specified by mavlink_msg_heartbeat.h, not the simulator.
const px4Payload = Buffer.from('78563412020c510303', 'hex');
const gcsPayload = Buffer.from('000000000608000403', 'hex');
const hb = (sysid = 1, payload = px4Payload, compid = 1) =>
  encodeV2Frame({ sysid, compid, msgid: 0, payload });
const attitude = (sysid = 1, compid = 1) =>
  encodeV2Frame({ sysid, compid, msgid: 30, payload: Buffer.alloc(28) });
function fixture(t) {
  const arp = new ArpTable();
  const aop = new Aop();
  const gateway = new MavlinkGateway(arp, aop, { logger: quiet });
  t.after(() => { arp.dispose(); gateway.dispose(); });
  return { arp, gateway };
}

test('HEARTBEAT wire layout identifies PX4 and GCS correctly', () => {
  const px4 = decodePayload(0, px4Payload);
  assert.equal(px4.customMode, 0x12345678);
  assert.equal(px4.typeName, 'QUADROTOR');
  assert.equal(px4.autopilotName, 'PX4');
  assert.equal(px4.baseMode, 0x51);
  assert.equal(decodePayload(0, gcsPayload).autopilotName, 'INVALID');
});

test('GCS heartbeat and other GCS traffic never create a vehicle', async (t) => {
  const { arp, gateway } = fixture(t);
  await gateway.receive(Buffer.concat([hb(255, gcsPayload, 190), attitude(255, 190)]), { transport: 'udp' });
  assert.deepEqual(gateway.allStates(), []);
  assert.equal(arp.size, 0);
});

test('real and simulated flight controllers may use sysid 255; no hard-coded ID ban', async (t) => {
  const { gateway } = fixture(t);
  await gateway.receive(hb(255), { transport: 'udp' });
  await gateway.receive(hb(255), { transport: 'sim' });
  assert.deepEqual(gateway.allStates().map((d) => d.droneId), ['real-255', 'uav-255']);
});

test('telemetry cannot register a vehicle before a valid heartbeat', async (t) => {
  const { gateway, arp } = fixture(t);
  await gateway.receive(attitude(), { transport: 'udp' });
  assert.equal(arp.size, 0);
  await gateway.receive(Buffer.concat([hb(), attitude()]), { transport: 'udp' });
  assert.equal(gateway.getState('real-1').telemetryCount, 1);
});

test('companion heartbeats cannot overwrite a flight controller sharing its sysid', async (t) => {
  const { gateway, arp } = fixture(t);
  await gateway.receive(hb(), { transport: 'udp' });
  await gateway.receive(hb(1, gcsPayload, 190), { transport: 'udp' });
  await gateway.receive(attitude(1, 190), { transport: 'udp' });
  assert.equal(arp.resolve('real-1').compid, 1);
  assert.equal(gateway.getState('real-1').autopilot, 'PX4');
  assert.equal(gateway.getState('real-1').telemetryCount, 0);
});

test('deleting an external vehicle removes state and prevents immediate rediscovery', async (t) => {
  const { gateway, arp } = fixture(t);
  await gateway.receive(hb(), { transport: 'udp' });
  assert.equal(gateway.removeDrone('real-1'), true);
  await gateway.receive(Buffer.concat([attitude(), hb()]), { transport: 'udp' });
  assert.equal(gateway.getState('real-1'), null);
  assert.equal(arp.size, 0);
});

test('invalid heartbeat removes a legacy misclassified entry from its own component', async (t) => {
  const { gateway, arp } = fixture(t);
  const entry = arp.learn('real-255', { transport: 'udp', sysid: 255, compid: 190 });
  gateway.states.set('real-255', gateway._initState('real-255', entry));
  await gateway.receive(hb(255, gcsPayload, 190), { transport: 'udp' });
  assert.equal(gateway.getState('real-255'), null);
  assert.equal(arp.size, 0);
});

test('corrupt heartbeat is rejected; fragmented v1 heartbeat is accepted', () => {
  const bad = hb(); bad[10] ^= 1;
  assert.throws(() => parseFrame(bad), /checksum/);
  const header = Buffer.from([0xfe, 9, 0, 1, 1, 0]);
  const body = Buffer.concat([header, px4Payload]);
  const checksum = Buffer.alloc(2);
  checksum.writeUInt16LE(crc16(Buffer.from([50]), crc16(body.subarray(1))));
  const v1 = Buffer.concat([body, checksum]);
  const state = { buffer: Buffer.alloc(0) };
  assert.equal(feed(v1.subarray(0, 1), state).length, 0);
  assert.equal(feed(v1.subarray(1, 7), state).length, 0);
  const frames = feed(v1.subarray(7), state);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].decoded.autopilotName, 'PX4');
});

test('simulator still registers using the corrected heartbeat layout', async (t) => {
  const { gateway } = fixture(t);
  const simulator = new DroneSimulator(gateway, { count: 1 });
  simulator._emitHeartbeat({ sysid: 1, mode: 'STABILIZE', armed: false, state: 'idle' });
  await flush();
  assert.equal(gateway.getState('uav-1').autopilot, 'ARDUPILOTMEGA');
});

function uiFixture() {
  return { state: { drones: new Map([['real-255', { droneId: 'real-255' }]]),
    arp: new Map([['real-255', {}]]), selected: 'real-255' },
  history: new Map([['real-255', [1]]]) };
}
test('delete response and remove event clear UI, selection and telemetry history', () => {
  const { state, history } = uiFixture();
  applyPresence(state, history, { droneId: 'real-255', reason: 'remove' });
  forgetDrone(state, history, 'real-255'); // REST and WS can arrive in either order.
  assert.equal(state.drones.size, 0);
  assert.equal(state.arp.size, 0);
  assert.equal(history.size, 0);
  assert.equal(state.selected, null);
});
test('reconnect snapshot removes stale ghost devices', () => {
  const { state, history } = uiFixture();
  replaceSnapshot(state, history, { drones: [{ droneId: 'real-1' }], arp: [] },
    (d) => state.drones.set(d.droneId, d));
  assert.deepEqual([...state.drones.keys()], ['real-1']);
  assert.equal(state.selected, null);
});
