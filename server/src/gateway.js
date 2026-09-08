/**
 * gateway.js — MAVLink 网关
 *
 * 职责:
 *  - 从各传输通道(UDP/TCP/内置模拟器)接收 MAVLink 字节流
 *  - 用 feed() 拆帧,按 sysid 学习到 ARP 表
 *  - 维护每架无人机的实时状态(遥测合并,含 AOP 遥测采集切面)
 *  - 向指定无人机下发 MAVLink 指令
 *  - 将状态变化推送给订阅者(WebSocket 层)
 */

import { feed, encodeV2Frame, MAV_CMD, isVehicleHeartbeat } from './mavlink.js';
import { resolvePosition } from './position.js';

export class MavlinkGateway {
  /**
   * @param {import('./arp.js').ArpTable} arp
   * @param {import('./aop.js').Aop} aop
   */
  constructor(arp, aop, opts = {}) {
    this.arp = arp;
    this.aop = aop;
    this.logger = opts.logger ?? console;
    /** @type {Map<string, object>} droneId → 实时状态 */
    this.states = new Map();
    // Explicitly deleted external vehicles stay hidden until the service restarts.
    this._removedExternalIds = new Set();
    this.positionDiagnostics = { received: {}, decoded: {}, rejected: {} };
    /** 序列号(指令帧用) */
    this._seq = 0;
    /** 传输后端:transportName → { send(frameBuffer, entry) } */
    this.transports = new Map();
    /** 状态变更订阅者 */
    this._subscribers = new Set();

    // 给 ARP 表接上探测回调(网关向对应传输发探测帧)
    this.arp.probeHandler = (entry) => {
      this.logger.info(`[ARP] 探测 ${entry.droneId} @ ${entry.host}:${entry.port}`);
    };

    // 用 AOP 织入"遥测采集"横切:任何 ingest 调用后自动把状态写库
    this.ingest = this.aop.proxy({ ingest: (frame, meta) => this._ingest(frame, meta) }).ingest;
  }

  /** 注册传输后端。 */
  registerTransport(name, transport) {
    this.transports.set(name, transport);
  }

  /** 订阅状态事件:on(event, fn),event ∈ 'state'|'presence'|'command' */
  subscribe(fn) {
    this._subscribers.add(fn);
    return () => this._subscribers.delete(fn);
  }

  _emit(evt, payload) {
    for (const fn of this._subscribers) {
      try {
        fn(evt, payload);
      } catch {
        /* 订阅者异常不影响网关 */
      }
    }
  }

  /**
   * 接收原始字节流(来自任何传输)。
   * @param {Buffer} chunk
   * @param {{transport:string, host?:string, port?:number, streamState?:object}} meta
   */
  receive(chunk, meta = {}) {
    const state = meta.streamState ?? (this._streamState ??= { buffer: Buffer.alloc(0) });
    const frames = feed(chunk, state, this.positionDiagnostics);
    return Promise.all(frames.map((frame) => this.ingest(frame, meta)));
  }

  _ingest(frame, meta) {
    // 无人机 ID 按传输来源区分前缀:模拟机 uav-N,外部链路(udp/tcp 真实飞控)real-N,
    // 避免真实飞控 sysid 与模拟机冲突(如都是 1)。
    const t = meta.transport ?? 'unknown';
    const prefix = t === 'sim' ? 'uav' : 'real';
    const droneId = `${prefix}-${frame.sysid}`;
    if (this._removedExternalIds.has(droneId)) return null;
    const existing = this.states.get(droneId);
    if (frame.msgid === 0) {
      if (!isVehicleHeartbeat(frame)) {
        // Remove a legacy misclassification only for its own component.
        if (existing?.entry.compid === frame.compid) this.removeDrone(droneId, { suppress: false });
        return null;
      }
    } else if (!existing) {
      // Telemetry, GCS traffic and companion messages cannot register a vehicle.
      return null;
    }
    if (existing && existing.entry.compid !== frame.compid) return null;
    const entry = this.arp.learn(droneId, {
      transport: t,
      host: meta.host ?? null,
      port: meta.port ?? null,
      sysid: frame.sysid,
      compid: frame.compid,
      mac: `${t}:${frame.sysid}`,
      heartbeat: frame.msgid === 0,
    });

    if (frame.msgid === 0) this._emit('presence', { droneId, entry: { ...entry }, at: Date.now() });

    // 合并遥测到实时状态
    const st = this.states.get(droneId) ?? this._initState(droneId, entry);
    st.lastSeen = Date.now();
    st.packets++;
    if (frame.msgid === 0) {
      st.heartbeat = { ...frame.decoded, at: Date.now() };
      st.online = true;
      st.vehicleType = frame.decoded.typeName;
      st.autopilot = frame.decoded.autopilotName;
      st.mode = frame.decoded.modeName;
    } else {
      st.telemetryCount++;
    }
    switch (frame.msgid) {
      case 1: st.sysStatus = { ...frame.decoded, at: Date.now() }; break;
      case 24: st.gps = { ...frame.decoded, at: Date.now() }; break;
      case 30: st.attitude = { ...frame.decoded, at: Date.now() }; break;
      case 33: st.globalPosition = { ...frame.decoded, at: Date.now() }; break;
      case 147: st.battery = { ...frame.decoded, at: Date.now() }; break;
    }
    st.entry = { ...entry };
    this.states.set(droneId, st);
    this.arp.noteTelemetry(droneId);

    // 遥测事件(限频:每 500ms 每机最多推一次,前端做节流)
    const now = Date.now();
    if (!st._lastEmit || now - st._lastEmit > 500) {
      st._lastEmit = now;
      this._emit('state', this._publicState(droneId));
    }
    return droneId;
  }

  _initState(droneId, entry) {
    return {
      droneId,
      online: false,
      packets: 0,
      telemetryCount: 0,
      lastSeen: Date.now(),
      heartbeat: null,
      sysStatus: null,
      gps: null,
      attitude: null,
      globalPosition: null,
      battery: null,
      entry,
    };
  }

  _publicState(droneId) {
    const st = this.states.get(droneId);
    if (!st) return null;
    return {
      droneId: st.droneId,
      online: st.online,
      armed: !!(st.heartbeat?.baseMode & 128),
      mode: st.mode ?? 'N/A',
      vehicleType: st.vehicleType ?? 'unknown',
      autopilot: st.autopilot ?? 'unknown',
      ...resolvePosition(st),
      attitude: st.attitude ? { roll: st.attitude.roll, pitch: st.attitude.pitch, yaw: st.attitude.yaw } : null,
      battery: st.battery
        ? { voltage: st.battery.voltage ?? null, remaining: st.battery.batteryRemaining, current: st.battery.currentBattery }
        : (st.sysStatus ? { voltage: st.sysStatus.voltageBattery, remaining: st.sysStatus.batteryRemaining, current: st.sysStatus.currentBattery } : null),
      sysStatus: st.sysStatus ? { load: st.sysStatus.load, voltageBattery: st.sysStatus.voltageBattery, batteryRemaining: st.sysStatus.batteryRemaining } : null,
      gps: st.gps ? { fixType: st.gps.fixType, satellitesVisible: st.gps.satellitesVisible, groundSpeed: st.gps.groundSpeed, at: st.gps.at } : null,
      gpsSensor: st.sysStatus ? {
        present: !!(st.sysStatus.sensorsPresent & 32),
        enabled: !!(st.sysStatus.sensorsEnabled & 32),
        healthy: !!(st.sysStatus.sensorsHealth & 32),
      } : null,
      packets: st.packets,
      telemetryCount: st.telemetryCount,
      lastSeen: st.lastSeen,
      transport: st.entry.transport,
    };
  }

  /** 查询单机状态(供 REST 用)。 */
  getState(droneId) {
    return this._publicState(droneId);
  }

  /** 全部状态快照。 */
  allStates() {
    const out = [];
    for (const id of this.states.keys()) out.push(this._publicState(id));
    return out;
  }

  /**
   * 从网关移除一架无人机的全部状态(实时状态、ARP 条目),并广播下线事件。
   * 注意:不负责停止模拟器遥测——模拟机需由 ApiServer 先调用 simulator.removeDrone。
   */
  removeDrone(droneId, { suppress = true } = {}) {
    if (suppress && droneId.startsWith('real-')) this._removedExternalIds.add(droneId);
    const removed = this.states.delete(droneId);
    let arpRemoved = false;
    if (this.arp.remove) arpRemoved = this.arp.remove(droneId);
    this._emit('presence', { droneId, reason: 'remove', at: Date.now() });
    return removed || arpRemoved;
  }

  /**
   * 向无人机下发指令。
   * @param {string} droneId
   * @param {object} cmd { command:number, params:[p1..p7] }
   * @returns {{ok:boolean, result?:string, reason?:string}}
   */
  command(droneId, cmd) {
    const entry = this.arp.resolve(droneId);
    if (!entry) return { ok: false, reason: `ARP 未解析到无人机 ${droneId}(离线或未注册)` };
    const payload = Buffer.alloc(33);
    payload.writeUInt16LE(cmd.command ?? MAV_CMD.NAV_WAYPOINT, 0);
    payload[2] = cmd.confirmation ?? 0;
    const params = cmd.params ?? [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 7; i++) payload.writeFloatLE(params[i] ?? 0, 3 + i * 4);
    const frame = encodeV2Frame({
      sysid: 255, compid: 190, seq: this._seq++ & 0xff, msgid: 76, payload,
    });
    const transport = this.transports.get(entry.transport);
    if (!transport) return { ok: false, reason: `传输 ${entry.transport} 未注册` };
    try {
      // 传输层需要指令语义信息(帧是原始 Buffer),随 meta 一并传递
      transport.send(frame, entry, {
        msgid: 76,
        command: cmd.command ?? MAV_CMD.NAV_WAYPOINT,
        params,
        confirmation: cmd.confirmation ?? 0,
      });
      this.arp.noteCommand(droneId);
      this._emit('command', { droneId, command: cmd.command, params, at: Date.now() });
      return { ok: true, result: '已下发' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /** 便捷指令封装。 */
  arm(droneId) {
    return this.command(droneId, { command: MAV_CMD.COMPONENT_ARM_DISARM, params: [1, 0, 0, 0, 0, 0, 0] });
  }
  disarm(droneId) {
    return this.command(droneId, { command: MAV_CMD.COMPONENT_ARM_DISARM, params: [0, 0, 0, 0, 0, 0, 0] });
  }
  takeoff(droneId, alt = 10) {
    return this.command(droneId, { command: MAV_CMD.NAV_TAKEOFF, params: [0, 0, 0, 0, 0, 0, alt] });
  }
  land(droneId) {
    return this.command(droneId, { command: MAV_CMD.NAV_LAND, params: [0, 0, 0, 0, 0, 0, 0] });
  }
  goto(droneId, lat, lon, alt = 20) {
    return this.command(droneId, { command: MAV_CMD.NAV_WAYPOINT, params: [0, 0, 0, 0, lat, lon, alt] });
  }
  rtl(droneId) {
    return this.command(droneId, { command: MAV_CMD.NAV_RETURN_TO_LAUNCH, params: [0, 0, 0, 0, 0, 0, 0] });
  }

  dispose() {
    this._subscribers.clear();
  }
}
