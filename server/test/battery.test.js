import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrame, encodeV2Frame } from '../src/mavlink.js';
const frame=(msgid,payload)=>encodeV2Frame({sysid:1,compid:1,msgid,payload});
test('SYS_STATUS battery remaining is the final base byte, load is decipercent and absent voltage stays unknown',()=>{
 const p=Buffer.alloc(31);p.writeUInt16LE(457,12);p.writeUInt16LE(65535,14);p.writeInt16LE(-1,16);p.writeUInt16LE(123,18);p.writeInt8(-1,30);
 let d=parseFrame(frame(1,p)).decoded;assert.equal(d.load,45.7);assert.equal(d.voltageBattery,null);assert.equal(d.batteryRemaining,null);
 p[30]=82;p.writeUInt16LE(12600,14);d=parseFrame(frame(1,p)).decoded;assert.equal(d.voltageBattery,12.6);assert.equal(d.batteryRemaining,82);
});
test('BATTERY_STATUS decodes cell voltages, current, temperature and identifier from standard offsets',()=>{
 const p=Buffer.alloc(41);p.writeInt32LE(321,0);p.writeInt16LE(2850,8);for(let i=0;i<10;i++)p.writeUInt16LE(i<3?4100:65535,10+i*2);p.writeInt16LE(1234,30);p[32]=2;p[34]=3;p[35]=75;p.writeInt32LE(900,36);p[40]=1;
 const d=parseFrame(frame(147,p)).decoded;assert.equal(d.id,2);assert.equal(d.temperature,28.5);assert.equal(d.currentBattery,12.34);assert.ok(Math.abs(d.voltage-12.3)<1e-8);assert.equal(d.batteryRemaining,75);assert.equal(d.chargeState,1);
});
test('battery packets reject bad checksums and restore MAVLink 2 zero tails',()=>{
 const p=Buffer.alloc(36);for(let i=0;i<10;i++)p.writeUInt16LE(65535,10+i*2);p.writeInt16LE(32767,8);p.writeInt16LE(-1,30);
 const d=parseFrame(frame(147,p.subarray(0,32))).decoded;assert.equal(d.batteryRemaining,0);assert.equal(d.temperature,null);assert.equal(d.voltage,null);
 const packet=frame(147,p);packet[12]^=1;assert.throws(()=>parseFrame(packet),/checksum/);
});
