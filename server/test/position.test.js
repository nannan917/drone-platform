import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePayload, encodeV2Frame, parseFrame, feed, crcExtra } from '../src/mavlink.js';
import { resolvePosition, POSITION_MAX_AGE_MS } from '../src/position.js';
import { currentPosition, positionLabel, validMapCoordinates } from '../public/position-ui.js';
import { MavlinkGateway } from '../src/gateway.js';
import { ArpTable } from '../src/arp.js';
import { Aop } from '../src/aop.js';

// Independent wire-layout fixture: GPS field order from the MAVLink common C header.
function gpsBytes({ fix = 3, lat = 31.2304, lon = 121.4737, sat = 12 } = {}) {
  const p = Buffer.alloc(30);
  p.writeBigUInt64LE(1000000n);
  p.writeInt32LE(Math.round(lat * 1e7), 8);
  p.writeInt32LE(Math.round(lon * 1e7), 12);
  p.writeInt32LE(12345, 16);
  p.writeUInt16LE(80, 20); p.writeUInt16LE(120, 22);
  p.writeUInt16LE(250, 24); p.writeUInt16LE(9000, 26);
  p[28] = fix; p[29] = sat;
  return p;
}
test('GPS wire offsets decode precise coordinates, fix and satellites', () => {
  const gps = decodePayload(24, gpsBytes());
  assert.equal(gps.lat, 31.2304); assert.equal(gps.lon, 121.4737);
  assert.equal(gps.alt, 12.345); assert.equal(gps.fixType, 3);
  assert.equal(gps.satellitesVisible, 12); assert.equal(gps.groundSpeed, 2.5);
  assert.equal(gps.courseOverGround, 90); assert.equal(crcExtra(24), 24);
});
test('MAVLink 2 truncated GPS and global position restore omitted zero bytes', () => {
  const gps = gpsBytes({ sat: 0 });
  const parsedGps = parseFrame(encodeV2Frame({ sysid: 1, compid: 1, msgid: 24, payload: gps.subarray(0, 29) }));
  assert.equal(parsedGps.decoded.satellitesVisible, 0);
  assert.equal(parsedGps.decoded.fixType, 3);
  const global = Buffer.alloc(28);
  global.writeInt32LE(312304000, 4); global.writeInt32LE(1214737000, 8);
  const parsedGlobal = parseFrame(encodeV2Frame({ sysid: 1, compid: 1, msgid: 33, payload: global.subarray(0, 12) }));
  assert.equal(parsedGlobal.decoded.heading, 0);
  assert.equal(parsedGlobal.decoded.lon, 121.4737);
});
test('unknown GPS values are not shown as impossible speed or satellites', () => {
  const p = gpsBytes({ sat: 255 }); p.writeUInt16LE(65535, 24); p.writeUInt16LE(65535, 26);
  const gps = decodePayload(24, p);
  assert.equal(gps.groundSpeed, null); assert.equal(gps.courseOverGround, null);
  assert.equal(gps.satellitesVisible, null);
});
test('corrupted GPS cannot place a vehicle; diagnostics distinguish absent and rejected packets', () => {
  const packet = encodeV2Frame({ sysid: 1, compid: 1, msgid: 24, payload: gpsBytes() }); packet[18] ^= 1;
  const stats = { received: {}, decoded: {}, rejected: {} };
  assert.deepEqual(feed(packet, { buffer: Buffer.alloc(0) }, stats), []);
  assert.equal(stats.received[24], 1); assert.equal(stats.rejected[24], 1);
  assert.equal(stats.received[33], undefined);
});
test('missing or no-fix GPS never creates a geographic marker', () => {
  assert.equal(resolvePosition({}).positionStatus, 'no_gps_data');
  const resolved = resolvePosition({ gps: { ...decodePayload(24, gpsBytes({ fix: 1 })), at: 100 } }, 100);
  assert.equal(resolved.position, null); assert.equal(resolved.positionStatus, 'waiting_gps');
});
test('coordinates must be valid and fresh; 2D fix does not claim valid altitude', () => {
  const gps = { ...decodePayload(24, gpsBytes({ fix: 2 })), at: 100 };
  assert.equal(resolvePosition({ gps }, 100).position.alt, null);
  assert.equal(resolvePosition({ gps }, POSITION_MAX_AGE_MS + 101).positionStatus, 'stale');
  for (const coords of [{ lat: 0, lon: 0 }, { lat: 100, lon: 10 }, { lat: NaN, lon: 10 }]) {
    assert.equal(resolvePosition({ gps: { ...gps, ...coords } }, 100).position, null);
  }
});
test('fresh estimator position works independently of absent GPS', () => {
  const result = resolvePosition({ globalPosition: { lat: 0, lon: 10, alt: 5, relativeAlt: 3, at: 100 } }, 100);
  assert.equal(result.position.source, 'global');
  assert.equal(result.position.relAlt, 3);
});
test('browser removes stale locations and distinguishes waiting states', () => {
  const d = { position: { lat: 31, lon: 121, at: 100, source: 'gps' } };
  assert.ok(currentPosition(d, 100)); assert.equal(currentPosition(d, 10200), null);
  assert.match(positionLabel(d, 10200), /过期/);
  assert.match(positionLabel({ position: null, positionStatus: 'waiting_gps' }), /搜星/);
  assert.equal(validMapCoordinates(0, 10), true); assert.equal(validMapCoordinates(1, 190), false);
});
test('gateway exposes no fix, valid fix and received position counters', async (t) => {
  const arp = new ArpTable(); const gateway = new MavlinkGateway(arp, new Aop());
  t.after(() => { gateway.dispose(); arp.dispose(); });
  const meta = { transport: 'udp' };
  const send = (msgid, payload) => gateway.receive(encodeV2Frame({ sysid: 1, compid: 1, msgid, payload }), meta);
  await send(0, Buffer.from('00000000020c510303', 'hex'));
  await send(24, gpsBytes({ fix: 1 }));
  assert.equal(gateway.getState('real-1').positionStatus, 'waiting_gps');
  await send(24, gpsBytes());
  assert.equal(gateway.getState('real-1').position.lat, 31.2304);
  assert.equal(gateway.positionDiagnostics.decoded[24], 2);
});
