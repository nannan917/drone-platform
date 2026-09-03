/**
 * mavlink.js — MAVLink v1/v2 帧编解码器(最小实现)
 *
 * 支持:
 *  - 解析 v1(0xFE)/v2(0xFD)帧
 *  - 常见遥测消息:HEARTBEAT(0), SYS_STATUS(1), GPS_RAW_INT(24),
 *    ATTITUDE(30), BATTERY_STATUS(147), GLOBAL_POSITION_INT(33)
 *  - 编码指令:COMMAND_LONG(76), HEARTBEAT(0)
 *
 * 说明:真实飞控校验使用 CRC-16/MCRF4XX(MAVLink 附加 CRC)。本实现内置
 * 常见消息的 CRC_EXTRA,未收录的消息会以"未解码"原样透传。
 */

const STX_V1 = 0xfe;
const STX_V2 = 0xfd;
const MAVLINK_HEADER_V1 = 6; // stx len seq sys comp msg
const MAVLINK_HEADER_V2 = 10; // stx len incompat compat seq sys comp msg
const MAVLINK_CHECKSUM_LEN = 2;

// 消息 CRC_EXTRA(常用子集)
const CRC_EXTRA = {
  0: 50,      // HEARTBEAT
  1: 124,     // SYS_STATUS
  24: 23,     // GPS_RAW_INT
  30: 39,     // ATTITUDE
  33: 104,    // GLOBAL_POSITION_INT
  76: 152,    // COMMAND_LONG
  147: 154,   // BATTERY_STATUS
  253: 137,   // STATUSTEXT
};

/** CRC-16/MCRF4XX */
export function crc16(data, seed = 0xffff) {
  let crc = seed;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      const tmp = crc & 0x0001;
      crc >>= 1;
      if (tmp) crc ^= 0x8408;
    }
  }
  return crc;
}

export function crcExtra(msgid) {
  return CRC_EXTRA[msgid] ?? 0;
}

function readU16(buf, o) { return buf.readUInt16LE(o); }
function readU32(buf, o) { return buf.readUInt32LE(o); }
function readI32(buf, o) { return buf.readInt32LE(o); }
function readF32(buf, o) { return buf.readFloatLE(o); }

/** 解码遥测 payload 为友好对象。未知消息返回 raw 数组。 */
export function decodePayload(msgid, payload) {
  switch (msgid) {
    case 0: { // HEARTBEAT: type@0 autopilot@1 base_mode@2 custom_mode(u32)@3 system_status@7 mavlink_version@8
      const type = payload[0];
      const autopilot = payload[1];
      const baseMode = payload[2];
      const customMode = readU32(payload, 3);
      const systemStatus = payload[7];
      return {
        type, autopilot, baseMode, customMode, systemStatus,
        typeName: typeNameOf(type), autopilotName: autopilotNameOf(autopilot),
        modeName: modeNameOf(baseMode, customMode),
      };
    }
    case 1: { // SYS_STATUS: present(u32)@0 enabled(u32)@4 health(u32)@8 load(u16)@12 voltage(u16 mV)@14 current(i16 cA)@16 remaining(i8)@18
      const onboardControlSensorsPresent = readU32(payload, 0);
      const onboardControlSensorsEnabled = readU32(payload, 4);
      const onboardControlSensorsHealth = readU32(payload, 8);
      const load = readU16(payload, 12);
      const voltageBattery = readU16(payload, 14);
      const currentBattery = readI16(payload, 16);
      const batteryRemaining = payload.readInt8(18);
      return {
        sensorsPresent: onboardControlSensorsPresent,
        sensorsEnabled: onboardControlSensorsEnabled,
        sensorsHealth: onboardControlSensorsHealth,
        load, voltageBattery: voltageBattery / 1000,
        currentBattery: currentBattery === -1 ? null : currentBattery / 100,
        batteryRemaining: batteryRemaining === -1 ? null : batteryRemaining,
      };
    }
    case 24: { // GPS_RAW_INT: time(u64)@0 fix_type@8 lat(i32)@9 lon(i32)@13 alt(i32)@17 eph(u16)@21 epv(u16)@23 vel(u16)@25 cog(u16)@27 sat@29
      const fixType = payload[8];
      const lat = readI32(payload, 9) / 1e7;
      const lon = readI32(payload, 13) / 1e7;
      const alt = readI32(payload, 17) / 1000;
      const eph = readU16(payload, 21);
      const epv = readU16(payload, 23);
      const vel = readU16(payload, 25);
      const cog = readU16(payload, 27);
      const satellitesVisible = payload[29];
      return {
        fixType, lat, lon, alt, eph, epv,
        groundSpeed: vel / 100, courseOverGround: cog / 100, satellitesVisible,
      };
    }
    case 30: { // ATTITUDE
      const roll = readF32(payload, 4);
      const pitch = readF32(payload, 8);
      const yaw = readF32(payload, 12);
      const rollSpeed = readF32(payload, 16);
      const pitchSpeed = readF32(payload, 20);
      const yawSpeed = readF32(payload, 24);
      return {
        roll: rad2deg(roll), pitch: rad2deg(pitch), yaw: rad2deg(yaw),
        rollSpeed: rad2deg(rollSpeed), pitchSpeed: rad2deg(pitchSpeed), yawSpeed: rad2deg(yawSpeed),
      };
    }
    case 33: { // GLOBAL_POSITION_INT
      const lat = readI32(payload, 4) / 1e7;
      const lon = readI32(payload, 8) / 1e7;
      const alt = readI32(payload, 12) / 1000;         // MSL
      const relativeAlt = readI32(payload, 16) / 1000; // 相对起飞点
      const vx = readI16(payload, 20) / 100;
      const vy = readI16(payload, 22) / 100;
      const vz = readI16(payload, 24) / 100;
      const hdg = readU16(payload, 26) / 100;
      return { lat, lon, alt, relativeAlt, vx, vy, vz, heading: hdg };
    }
    case 147: { // BATTERY_STATUS: id@0 function@1 type@2 temperature(i16)@3 voltages[10](u16)@5 current(i16)@25 consumed(i32)@27 energy(i32)@31 remaining(i8)@35 time(i8)@36 charge@37
      const id = payload[0];
      const batteryFunction = payload[1];
      const type = payload[2];
      const temperature = readI16(payload, 3);
      const voltages = [];
      for (let i = 0; i < 10; i++) {
        const v = readU16(payload, 5 + i * 2);
        if (v !== 0xffff) voltages.push(v / 1000);
      }
      const currentBattery = readI16(payload, 25);
      const batteryRemaining = payload.readInt8(35);
      const chargeState = payload[37];
      return {
        id, batteryFunction, type,
        temperature: temperature === -32768 ? null : temperature / 100,
        voltages,
        currentBattery: currentBattery === -1 ? null : currentBattery / 100,
        batteryRemaining: batteryRemaining === -1 ? null : batteryRemaining,
        chargeState,
      };
    }
    case 76: { // COMMAND_LONG(收到的 ack 场景仅透传)
      return { command: readU16(payload, 0), confirmation: payload[2], param1: readF32(payload, 3), param2: readF32(payload, 7), param3: readF32(payload, 11), param4: readF32(payload, 15), param5: readF32(payload, 19), param6: readF32(payload, 23), param7: readF32(payload, 27) };
    }
    default:
      return { raw: [...payload] };
  }
}

function readI16(buf, o) { return buf.readInt16LE(o); }
function rad2deg(r) { return (r * 180) / Math.PI; }

const TYPE_NAMES = {
  0: 'GENERIC', 1: 'FIXED_WING', 2: 'QUADROTOR', 3: 'COAXIAL', 4: 'HELICOPTER',
  5: 'ANTENNA_TRACKER', 6: 'GCS', 7: 'AIRSHIP', 8: 'FREE_BALLOON', 9: 'ROCKET',
  10: 'GROUND_ROVER', 11: 'SURFACE_BOAT', 12: 'SUBMARINE', 13: 'HEXAROTOR',
  14: 'OCTOROTOR', 15: 'TRICOPTER', 16: 'FLAPPING_WING', 17: 'KITE',
  18: 'ONBOARD_CONTROLLER', 19: 'VTOL_TAILSITTER_DUOROTOR', 20: 'VTOL_TAILSITTER_QUADROTOR',
  21: 'VTOL_TILTROTOR', 22: 'VTOL_FIXEDROTOR', 23: 'VTOL_TAILSITTER', 24: 'VTOL_TILTWING',
  25: 'VTOL_RESERVED5', 26: 'GIMBAL', 27: 'ADSB', 28: 'PARAFOIL', 29: 'DODECAROTOR',
  30: 'CAMERA', 31: 'CHARGING_STATION', 32: 'FLARM', 33: 'SERVO', 34: 'ODID', 35: 'DECAROTOR',
  36: 'BATTERY', 37: 'PARACHUTE', 38: 'LOG', 39: 'OSD', 40: 'IMU', 41: 'GPS', 42: 'WIND',
};
const AUTOPILOT_NAMES = { 0: 'GENERIC', 1: 'RESERVED', 2: 'SLUGS', 3: 'ARDUPILOTMEGA', 4: 'OPENPILOT', 5: 'GENERIC_WAYPOINTS', 6: 'SMARTAP', 7: 'AEROB', 8: 'ASLUAV', 9: 'QURT', 10: 'PX4', 11: 'INDI', 12: 'COBOLD', 13: 'CRAZYFLIE', 14: 'FLONE', 15: 'INTEL_AERO', 16: 'AUTOPILOTOS', 17: 'VECTOR', 18: 'ARDRONIS', 19: 'AVIIL', 20: 'ICAROUS' };

function typeNameOf(t) { return TYPE_NAMES[t] ?? `TYPE_${t}`; }
function autopilotNameOf(a) { return AUTOPILOT_NAMES[a] ?? `AP_${a}`; }

const MAV_MODE_FLAG = {
  CUSTOM_MODE_ENABLED: 1, TEST_ENABLED: 2, AUTO_ENABLED: 4, GUIDED_ENABLED: 8,
  STABILIZE_ENABLED: 16, HIL_ENABLED: 32, MANUAL_INPUT_ENABLED: 64, SAFETY_ARMED: 128,
};

function modeNameOf(baseMode, customMode) {
  const parts = [];
  if (baseMode & MAV_MODE_FLAG.SAFETY_ARMED) parts.push('ARMED');
  if (baseMode & MAV_MODE_FLAG.GUIDED_ENABLED) parts.push('GUIDED');
  if (baseMode & MAV_MODE_FLAG.AUTO_ENABLED) parts.push('AUTO');
  if (baseMode & MAV_MODE_FLAG.STABILIZE_ENABLED) parts.push('STABILIZE');
  if (baseMode & MAV_MODE_FLAG.MANUAL_INPUT_ENABLED) parts.push('MANUAL');
  if (parts.length === 0) parts.push(`custom=${customMode}`);
  return parts.join('|');
}

/**
 * 解析一个完整 MAVLink 帧。
 * @param {Buffer} buf 帧缓冲区(含 stx)
 * @returns {{version:1|2, seq, sysid, compid, msgid, payload, decoded, len, sigLen}}
 */
export function parseFrame(buf) {
  const stx = buf[0];
  if (stx !== STX_V1 && stx !== STX_V2) throw new Error(`bad stx 0x${stx.toString(16)}`);
  const v2 = stx === STX_V2;
  const len = buf[1];
  const payloadStart = v2 ? MAVLINK_HEADER_V2 : MAVLINK_HEADER_V1;
  let seq, sysid, compid, msgid;
  if (v2) {
    seq = buf[4];
    sysid = buf[5];
    compid = buf[6];
    msgid = buf[7] | (buf[8] << 8) | (buf[9] << 16);
  } else {
    seq = buf[2];
    sysid = buf[3];
    compid = buf[4];
    msgid = buf[5];
  }
  const payload = buf.subarray(payloadStart, payloadStart + len);
  const decoded = decodePayload(msgid, payload);
  return { version: v2 ? 2 : 1, seq, sysid, compid, msgid, payload, decoded, len, v2 };
}

/**
 * 从字节流中提取完整帧(处理半包与粘包)。
 * @param {Buffer} chunk 新到达的数据
 * @param {{buffer:Buffer}} state 持久的流状态
 * @returns {Array<object>} 解析出的帧数组
 */
export function feed(chunk, state) {
  state.buffer = state.buffer ? Buffer.concat([state.buffer, chunk]) : chunk;
  const frames = [];
  let buf = state.buffer;
  while (buf.length > 0) {
    const stx = buf[0];
    if (stx !== STX_V1 && stx !== STX_V2) { buf = buf.subarray(1); continue; }
    const v2 = stx === STX_V2;
    const headerLen = v2 ? MAVLINK_HEADER_V2 : MAVLINK_HEADER_V1;
    const len = buf[1];
    const frameLen = headerLen + len + MAVLINK_CHECKSUM_LEN;
    if (buf.length < frameLen) break; // 等待更多数据
    try {
      frames.push(parseFrame(buf.subarray(0, frameLen)));
    } catch {
      /* 坏帧跳过 */
    }
    buf = buf.subarray(frameLen);
  }
  state.buffer = buf;
  return frames;
}

/**
 * 编码一个 MAVLink v2 帧(用于指令下发)。
 * @param {object} p { sysid, compid, seq, msgid, payload:Buffer }
 */
export function encodeV2Frame({ sysid, compid, seq = 0, msgid, payload }) {
  const header = Buffer.from([
    STX_V2,
    payload.length,
    0, // incompat
    0, // compat
    seq & 0xff,
    sysid & 0xff,
    compid & 0xff,
    msgid & 0xff,
    (msgid >> 8) & 0xff,
    (msgid >> 16) & 0xff,
  ]);
  const crc = crc16(header.subarray(1));
  const crc2 = crc16(payload, crc);
  const crc3 = crc16(Buffer.from([crcExtra(msgid)]), crc2);
  const checksum = Buffer.alloc(2);
  checksum.writeUInt16LE(crc3, 0);
  return Buffer.concat([header, payload, checksum]);
}

/** 常用指令常量 */
export const MAV_CMD = Object.freeze({
  COMPONENT_ARM_DISARM: 400,
  NAV_TAKEOFF: 22,
  NAV_LAND: 21,
  NAV_WAYPOINT: 16,
  NAV_RETURN_TO_LAUNCH: 20,
  DO_CHANGE_SPEED: 178,
  SET_MODE: 176,
});

export const MAV_RESULT = Object.freeze({
  ACCEPTED: 0, TEMPORARILY_REJECTED: 1, DENIED: 2, UNSUPPORTED: 3, FAILED: 4, IN_PROGRESS: 5,
});
