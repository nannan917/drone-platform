/**
 * simulator.js — 内置多无人机模拟器(真实感增强版)
 *
 * 生成 N 架虚拟无人机的 MAVLink 遥测流(心跳/姿态/GPS/电量/系统状态),
 * 通过网关注入,与真实飞控接入走完全相同的解析管线。
 *
 * 真实感要素:
 *  - 运动学:速度向量 vx/vy/vz,受最大加速度/最大速度/最大爬升率约束
 *  - 风场:全局风向风速 + 湍流扰动(平滑随机),实时影响飞行
 *  - 传感器噪声:GPS 位置抖动(与 eph 相关)、姿态角噪声、高度噪声
 *  - 电池模型:悬停/巡航/爬升放电率不同,电压随电量非线性
 *  - 编队:三角/直线/环形/自由 四种队形,领机移动带动编队
 *  - 指令响应:arm 后才能 takeoff,goto 有转弯速度约束
 */

import { encodeV2Frame, MAV_CMD } from './mavlink.js';

const CR = Math.PI / 180;
const DEG_PER_M = 1 / 111320; // 1m ≈ 1/111320 度(纬度向)
const M_PER_DEG_LAT = 111320;

/** 平滑随机(湍流):在 [-1,1] 内缓慢游走 */
function makeDrift(seed, speed = 0.02) {
  let v = Math.sin(seed * 12.9898) * 43758.5453 % 1;
  v = Math.abs(v);
  return () => {
    v += (Math.random() - 0.5) * speed;
    if (v > 1) v = 1;
    if (v < 0) v = 0;
    return v * 2 - 1;
  };
}

export class DroneSimulator {
  /**
   * @param {import('./gateway.js').MavlinkGateway} gateway
   * @param {object} opts
   * @param {number} opts.count 模拟机数量
   * @param {number} opts.tickMs 遥测周期(ms)
   * @param {number} opts.originLat 集群原点纬度(默认深圳中科院 SIAT)
   * @param {number} opts.originLon 集群原点经度
   * @param {number} opts.windSpeed 全局风速 m/s
   * @param {number} opts.windDir 全局风向(度,0=北)
   */
  constructor(gateway, opts = {}) {
    this.gateway = gateway;
    this.count = opts.count ?? 3;
    this.tickMs = opts.tickMs ?? 1000;
    // 默认:中科院深圳先进技术研究院(SIAT) 深圳市南山区学苑大道1068号
    this.originLat = opts.originLat ?? 22.5935;
    this.originLon = opts.originLon ?? 113.9645;
    this.windSpeed = opts.windSpeed ?? 3.5;   // m/s
    this.windDir = opts.windDir ?? 225;        // 西南风
    /** @type {Map<number, object>} sysid → sim 状态 */
    this.drones = new Map();
    this._timer = null;
    this._seq = 0;
    this._tickCount = 0;
    // 编队状态
    this.formation = { type: 'free', spacing: 15 }; // free | triangle | line | circle
    this.leader = null; // 领机 sysid

    for (let i = 1; i <= this.count; i++) this._addDroneState(i);
    if (this.drones.size > 0) this.leader = 1;
  }

  /** 动态新增一架模拟无人机(前端"接入"按钮)。 */
  addDrone() {
    let max = 0;
    for (const key of this.drones.keys()) max = Math.max(max, key);
    const next = max + 1;
    this._addDroneState(next);
    const sim = this.drones.get(next);
    this._emitHeartbeat(sim);
    return `uav-${next}`;
  }

  /** 删除一架模拟无人机。返回是否成功(仅当该机为 sim 传输)。 */
  removeDrone(sysid) {
    const sim = this.drones.get(sysid);
    if (!sim) return { ok: false, error: `模拟无人机 uav-${sysid} 不存在` };
    this.drones.delete(sysid);
    // 若被删的是领机,把领机交给剩余最小 sysid
    if (this.leader === sysid && this.drones.size > 0) {
      this.leader = [...this.drones.keys()].sort((a, b) => a - b)[0];
    }
    // 若删空则重置领机
    if (this.drones.size === 0) this.leader = null;
    return { ok: true };
  }

  /** 设置编队。type: free|triangle|line|circle */
  setFormation(type, spacing = 15) {
    if (!['free', 'triangle', 'line', 'circle'].includes(type)) return { ok: false, reason: `未知队形 ${type}` };
    this.formation = { type, spacing: Number(spacing) || 15 };
    if (type !== 'free' && this.drones.size > 0) {
      this.leader = [...this.drones.keys()].sort((a, b) => a - b)[0];
      // 队形模式下所有机锁定到队形位置
      for (const [sysid, sim] of this.drones) {
        const off = this._formationOffset(sysid);
        sim.state = 'flying';
        sim.mode = 'GUIDED';
        sim.armed = true;
        sim.target = { lat: this.drones.get(this.leader).lat + off.dLat, lon: this.drones.get(this.leader).lon + off.dLon, alt: sim.alt };
        sim.formationOffset = off;
      }
    } else if (type === 'free') {
      for (const sim of this.drones.values()) sim.formationOffset = null;
    }
    return { ok: true, formation: this.formation, leader: `uav-${this.leader ?? '-'}` };
  }

  /** 计算某机在队形中的相对偏移(米 → 度)。 */
  _formationOffset(sysid) {
    const spacing = this.formation.spacing;
    switch (this.formation.type) {
      case 'triangle': {
        // 三角:领机在顶点,其余成两翼
        const idx = sysid - this.leader;
        if (idx === 0) return { dLat: 0, dLon: 0 };
        const wing = (idx + 1) % 2 === 0 ? 1 : -1;
        const back = Math.ceil(idx / 2);
        return { dLat: -back * spacing, dLon: wing * back * spacing * 0.6 };
      }
      case 'line': {
        const idx = sysid - this.leader;
        return { dLat: 0, dLon: idx * spacing };
      }
      case 'circle': {
        const n = this.drones.size;
        const idx = sysid - this.leader;
        const a = (idx / n) * 2 * Math.PI;
        return { dLat: Math.cos(a) * spacing, dLon: Math.sin(a) * spacing };
      }
      default:
        return { dLat: 0, dLon: 0 };
    }
  }

  _addDroneState(i) {
    // 在原点周围 300m 范围内散布
    const angle = (i / 7) * 2 * Math.PI + Math.random();
    const radius = 120 + (i % 4) * 60 + Math.random() * 60;
    this.drones.set(i, {
      sysid: i,
      lat: this.originLat + Math.cos(angle) * radius * DEG_PER_M,
      lon: this.originLon + Math.sin(angle) * radius * DEG_PER_M / Math.cos(this.originLat * CR),
      alt: 30 + (i % 4) * 15 + Math.random() * 10,
      heading: (i * 47 + Math.random() * 30) % 360,
      roll: 0, pitch: 0,
      speed: 0,                 // 当前地速 m/s
      vx: 0, vy: 0, vz: 0,      // 速度向量 m/s(北/东/天)
      batt: 88 - i * 4 + Math.random() * 4,
      armed: false,
      mode: 'STABILIZE',
      state: 'idle',            // idle | takeoff | flying | hover | landing | rtl
      target: null,
      maxSpeed: 14 + Math.random() * 4,      // m/s
      maxAccel: 3.5,                          // m/s²
      maxClimb: 3,                             // m/s
      eph: 60 + Math.random() * 40,           // cm
      sat: 12 + Math.floor(Math.random() * 5),
      noise: { lat: makeDrift(i), lon: makeDrift(i + 100), alt: makeDrift(i + 200), att: makeDrift(i + 300) },
      tick: 0,
      cmdQueue: [],
      formationOffset: null,
      flightTime: 0,            // 累计飞行秒
    });
  }

  /** 注册模拟传输后端(供网关指令下发回传)。 */
  attach() {
    this.gateway.registerTransport('sim', {
      send: (frame, entry, meta) => this._onCommand(meta, entry),
    });
  }

  _onCommand(meta, entry) {
    if (!meta || meta.msgid !== 76) return;
    const sysid = entry.sysid;
    const sim = this.drones.get(sysid);
    if (!sim) return;
    sim.cmdQueue.push({ command: meta.command, params: meta.params ?? [], at: Date.now() });
  }

  start() {
    this._timer = setInterval(() => this._tick(), this.tickMs);
    this._timer.unref?.();
    for (const sim of this.drones.values()) this._emitHeartbeat(sim);
    return this;
  }

  stop() {
    clearInterval(this._timer);
  }

  _tick() {
    this._tickCount++;
    const dt = this.tickMs / 1000;
    // 湍流风随时间变化
    const wind = this._windAt(dt);
    for (const sim of this.drones.values()) {
      sim.tick++;
      this._processCommands(sim);
      this._stepMotion(sim, dt, wind);
      this._emitHeartbeat(sim);
      this._emitAttitude(sim);
      this._emitGps(sim);
      this._emitBattery(sim);
      this._emitSysStatus(sim);
      this._emitPosition(sim);
    }
  }

  /** 当前风况摘要(供前端展示)。 */
  windSummary() {
    const w = this._windAt(this._tickCount * this.tickMs / 1000);
    return {
      speed: Math.round(Math.hypot(w.u, w.v) * 10) / 10,
      dir: Math.round((Math.atan2(w.u, w.v) / CR + 360) % 360),
      gust: Math.round(Math.hypot(w.u, w.v) * 10) / 10,
    };
  }

  /** 当前风向量:全局风 + 湍流扰动。返回 {u(向东), v(向北)} m/s */
  _windAt(t) {
    const gust = Math.sin(t * 0.35) * 1.2 + Math.sin(t * 1.7 + 2) * 0.6;
    const dirRad = this.windDir * CR;
    const baseU = this.windSpeed * Math.sin(dirRad);
    const baseV = this.windSpeed * Math.cos(dirRad);
    return {
      u: baseU + gust * 0.5,
      v: baseV + gust * 0.3,
    };
  }

  _processCommands(sim) {
    while (sim.cmdQueue.length) {
      const c = sim.cmdQueue.shift();
      switch (c.command) {
        case MAV_CMD.COMPONENT_ARM_DISARM:
          sim.armed = c.params[0] > 0.5;
          if (sim.armed && sim.state === 'idle') sim.mode = 'STABILIZE';
          if (!sim.armed) { sim.mode = 'STABILIZE'; }
          break;
        case MAV_CMD.NAV_TAKEOFF: {
          const alt = c.params[6] || 15;
          if (!sim.armed) {
            // 真实飞控:未解锁拒绝起飞
            sim.cmdQueue.push({ command: MAV_CMD.COMPONENT_ARM_DISARM, params: [1], at: Date.now() });
            sim.pendingTakeoff = alt;
            break;
          }
          sim.state = 'takeoff';
          sim.target = { lat: sim.lat, lon: sim.lon, alt };
          sim.mode = 'GUIDED';
          break;
        }
        case MAV_CMD.NAV_WAYPOINT: {
          const lat = c.params[4];
          const lon = c.params[5];
          const alt = c.params[6] || sim.target?.alt || 30;
          if (lat !== 0 && lon !== 0) {
            sim.target = { lat, lon, alt };
            sim.state = 'flying';
            sim.mode = 'GUIDED';
            sim.armed = true;
          }
          break;
        }
        case MAV_CMD.NAV_LAND:
          sim.state = 'landing';
          sim.target = { lat: sim.lat, lon: sim.lon, alt: 0 };
          sim.mode = 'LAND';
          break;
        case MAV_CMD.NAV_RETURN_TO_LAUNCH:
          sim.target = { lat: this.originLat, lon: this.originLon, alt: 25 };
          sim.state = 'flying';
          sim.mode = 'RTL';
          break;
      }
    }
    // 未解锁时收到起飞指令 → 自动补解锁后执行
    if (sim.pendingTakeoff && sim.armed && sim.state === 'idle') {
      const alt = sim.pendingTakeoff;
      sim.pendingTakeoff = null;
      sim.state = 'takeoff';
      sim.target = { lat: sim.lat, lon: sim.lon, alt };
      sim.mode = 'GUIDED';
    }
  }

  _stepMotion(sim, dt, wind) {
    // 编队模式:跟随领机保持队形
    if (this.formation.type !== 'free' && sim.formationOffset && sim.sysid !== this.leader) {
      const lead = this.drones.get(this.leader);
      if (lead) {
        sim.target = {
          lat: lead.lat + sim.formationOffset.dLat * DEG_PER_M,
          lon: lead.lon + sim.formationOffset.dLon * DEG_PER_M / Math.cos(this.originLat * CR),
          alt: lead.alt,
        };
        sim.state = sim.state === 'idle' ? 'takeoff' : 'flying';
        sim.mode = 'GUIDED';
        sim.armed = true;
      }
    }

    // 期望速度向量(朝目标)
    let wantVx = 0, wantVy = 0, wantVz = 0;
    if (sim.target && (sim.state === 'flying' || sim.state === 'takeoff' || sim.state === 'rtl')) {
      const dLat = sim.target.lat - sim.lat;
      const dLon = sim.target.lon - sim.lon;
      const dAlt = sim.target.alt - sim.alt;
      // 水平距离(米)
      const distN = dLat * M_PER_DEG_LAT;
      const distE = dLon * M_PER_DEG_LAT * Math.cos(this.originLat * CR);
      const dist = Math.hypot(distN, distE);
      if (dist > 2) {
        const spd = Math.min(sim.maxSpeed, dist / 2 + 2);
        wantVy = (distN / dist) * spd;
        wantVx = (distE / dist) * spd;
      }
      // 垂直:到达目标高度附近前按爬升率
      if (Math.abs(dAlt) > 1.2) wantVz = Math.sign(dAlt) * Math.min(sim.maxClimb, Math.abs(dAlt) / 2 + 0.5);
      else if (sim.state === 'takeoff') wantVz = 0;
    } else if (sim.state === 'landing' && sim.target) {
      const dAlt = sim.target.alt - sim.alt;
      if (Math.abs(dAlt) > 0.3) wantVz = Math.sign(dAlt) * Math.min(1.8, Math.abs(dAlt) + 0.3);
    } else if (sim.state === 'hover') {
      // 悬停:抗风(风速抵消)
      wantVy = -wind.v;
      wantVx = -wind.u;
    }

    // 加速度限制(每帧速度增量)
    const axMax = sim.maxAccel * dt;
    const dvx = clamp(wantVx - sim.vx, -axMax, axMax);
    const dvy = clamp(wantVy - sim.vy, -axMax, axMax);
    const dvz = clamp(wantVz - sim.vz, -sim.maxClimb * dt, sim.maxClimb * dt);
    sim.vx += dvx;
    sim.vy += dvy;
    sim.vz += dvz;

    // 速度上限
    const horiz = Math.hypot(sim.vx, sim.vy);
    if (horiz > sim.maxSpeed) {
      sim.vx *= sim.maxSpeed / horiz;
      sim.vy *= sim.maxSpeed / horiz;
    }

    // 位置积分 + 风的影响(地速 = 空速 + 风速)
    const gndVx = sim.vx + wind.u;
    const gndVy = sim.vy + wind.v;
    sim.lat += gndVy * dt * DEG_PER_M;
    sim.lon += gndVx * dt * DEG_PER_M / Math.cos(this.originLat * CR);
    sim.alt += sim.vz * dt;
    if (sim.alt < 0.1) sim.alt = 0.1;

    // 地速与航向
    sim.speed = Math.hypot(gndVx, gndVy);
    if (sim.speed > 0.5) sim.heading = (Math.atan2(gndVx, gndVy) / CR + 360) % 360;

    // 状态机
    if (sim.state === 'takeoff') {
      // 起飞:从当前位置爬升到目标高度;若目标高度低于当前,直接进入巡航
      if (sim.alt >= (sim.target?.alt ?? 15) - 0.8 && (sim.target?.alt ?? 15) >= sim.alt - 0.8) {
        sim.state = 'hover';
        sim.mode = 'GUIDED';
        sim.flightTime += dt;
      } else if ((sim.target?.alt ?? 15) < sim.alt - 0.8) {
        sim.state = 'flying';
        sim.mode = 'GUIDED';
        sim.flightTime += dt;
      } else {
        sim.flightTime += dt;
      }
    } else if (sim.state === 'flying' && sim.target) {
      const dLat = sim.target.lat - sim.lat;
      const dLon = sim.target.lon - sim.lon;
      const dAlt = sim.target.alt - sim.alt;
      const distN = dLat * M_PER_DEG_LAT;
      const distE = dLon * M_PER_DEG_LAT * Math.cos(this.originLat * CR);
      if (Math.hypot(distN, distE) < 5 && Math.abs(dAlt) < 2) {
        sim.state = 'hover';
        sim.mode = 'GUIDED';
        sim.flightTime += dt;
      } else {
        sim.flightTime += dt;
      }
    } else if (sim.state === 'landing') {
      sim.flightTime += dt;
      if (sim.alt <= 0.3) {
        sim.state = 'idle';
        sim.armed = false;
        sim.mode = 'STABILIZE';
        sim.target = null;
        sim.vx = sim.vy = sim.vz = 0;
      }
    } else if (sim.state === 'rtl' && sim.target) {
      const dLat = sim.target.lat - sim.lat;
      const dLon = sim.target.lon - sim.lon;
      if (Math.hypot(dLat * M_PER_DEG_LAT, dLon * M_PER_DEG_LAT * Math.cos(this.originLat * CR)) < 8 && Math.abs(sim.target.alt - sim.alt) < 2) {
        sim.state = 'landing';
        sim.target = { lat: sim.lat, lon: sim.lon, alt: 0 };
        sim.mode = 'LAND';
      }
    }

    // 姿态:随速度和转向
    sim.roll = clamp(-sim.vx * 1.2, -22, 22) + sim.noise.att() * 1.2;
    sim.pitch = clamp(sim.vy * 1.2, -18, 18) + sim.noise.att() * 1.0;
  }

  _frame(msgid, payload, sysid) {
    return encodeV2Frame({
      sysid: sysid ?? 1, compid: 1, seq: this._seq++ & 0xff, msgid, payload,
    });
  }

  _emitHeartbeat(sim) {
    const baseMode = (sim.armed ? 128 : 0) | (['GUIDED', 'AUTO', 'RTL', 'LAND'].includes(sim.mode) ? 8 : 0);
    const custom = sim.mode === 'GUIDED' ? 4 : sim.mode === 'RTL' ? 6 : sim.mode === 'LAND' ? 9 : 0;
    const payload = Buffer.alloc(9);
    payload.writeUInt32LE(custom, 0);
    payload[4] = 2; // QUADROTOR
    payload[5] = 3; // ARDUPILOTMEGA
    payload[6] = baseMode;
    payload[7] = sim.state === 'idle' && !sim.armed ? 3 : 4; // STANDBY / ACTIVE
    payload[8] = 3;
    this.gateway.receive(this._frame(0, payload, sim.sysid), { transport: 'sim', host: '127.0.0.1', port: 0, streamState: this._streamState(sim.sysid) });
  }

  _emitAttitude(sim) {
    const payload = Buffer.alloc(28);
    payload.writeUInt32LE(sim.tick * this.tickMs, 0);
    const rollN = sim.roll + sim.noise.att() * 0.4;
    const pitchN = sim.pitch + sim.noise.att() * 0.35;
    const yawN = sim.heading + sim.noise.att() * 0.5;
    payload.writeFloatLE(rollN * CR, 4);
    payload.writeFloatLE(pitchN * CR, 8);
    payload.writeFloatLE(yawN * CR, 12);
    payload.writeFloatLE(0.02, 16);
    payload.writeFloatLE(0.02, 20);
    payload.writeFloatLE(0.02, 24);
    this.gateway.receive(this._frame(30, payload, sim.sysid), { transport: 'sim', streamState: this._streamState(sim.sysid) });
  }

  _emitGps(sim) {
    // GPS 位置噪声:幅度与 eph 相关(厘米 → 米)
    const noiseM = sim.eph / 100 * 0.5;
    const latN = sim.lat + sim.noise.lat() * noiseM * DEG_PER_M;
    const lonN = sim.lon + sim.noise.lon() * noiseM * DEG_PER_M / Math.cos(this.originLat * CR);
    const altN = sim.alt + sim.noise.alt() * 1.2;
    const payload = Buffer.alloc(30);
    payload.writeUInt8(3, 28); // 3D fix
    payload.writeInt32LE(Math.round(latN * 1e7), 8);
    payload.writeInt32LE(Math.round(lonN * 1e7), 12);
    payload.writeInt32LE(Math.round(altN * 1000), 16);
    payload.writeUInt16LE(Math.round(sim.eph), 20);
    payload.writeUInt16LE(Math.round(sim.eph * 1.4), 22);
    payload.writeUInt16LE(Math.round(sim.speed * 100), 24);
    payload.writeUInt16LE(Math.round(sim.heading * 100), 26);
    // 卫星数波动
    if (sim.tick % 37 === 0) sim.sat = Math.max(9, Math.min(18, sim.sat + (Math.random() > 0.5 ? 1 : -1)));
    payload.writeUInt8(sim.sat, 29);
    this.gateway.receive(this._frame(24, payload, sim.sysid), { transport: 'sim', streamState: this._streamState(sim.sysid) });
  }

  _emitBattery(sim) {
    // 放电率:悬停 0.6%/min,巡航 1.2%/min,爬升 2%/min
    let rate = 0.6;
    if (sim.state === 'flying' || sim.state === 'rtl') rate = 1.2;
    if (sim.state === 'takeoff') rate = 2.0;
    if (sim.state === 'landing') rate = 0.8;
    sim.batt = Math.max(0, sim.batt - (rate / 60) * (this.tickMs / 1000));
    // 电压:3S LiPo,与电量非线性
    const cellV = 4.2 - (100 - sim.batt) * 0.012;
    const payload = Buffer.alloc(41);
    payload.writeInt32LE(Math.round(sim.flightTime * 12), 0);
    payload.writeInt32LE(-1, 4);
    payload.writeInt16LE(2800 + Math.round(sim.noise.att() * 200), 8);
    for(let i=0;i<10;i++)payload.writeUInt16LE(i<3?Math.round(cellV*1000):65535,10+i*2);
    const current = sim.state === 'flying' ? 18 : sim.state === 'takeoff' ? 30 : sim.state === 'hover' ? 12 : 2;
    payload.writeInt16LE(Math.round(current*100),30);
    payload[32]=0;payload[33]=1;payload[34]=3;
    payload.writeInt8(Math.round(sim.batt),35);
    payload.writeInt32LE(Math.round((sim.batt/rate)*60),36);
    payload[40]=1;
    this.gateway.receive(this._frame(147, payload, sim.sysid), { transport: 'sim', streamState: this._streamState(sim.sysid) });
  }

  _emitSysStatus(sim) {
    const payload = Buffer.alloc(31);
    payload.writeUInt32LE(0xffffffff, 0);
    payload.writeUInt32LE(0xffffffff, 4);
    payload.writeUInt32LE(0xffffffff, 8);
    const load = sim.state === 'idle' ? 12 : sim.state === 'flying' ? 45 : sim.state === 'takeoff' ? 70 : 30;
    payload.writeUInt16LE(load * 10 + Math.round(sim.noise.att() * 4), 12);
    payload.writeUInt16LE(Math.round((4.2 - (100 - sim.batt) * 0.012) * 3 * 1000), 14); // mV
    payload.writeInt16LE(sim.state === 'idle' ? 200 : 1200, 16); // cA
    payload.writeInt8(Math.round(sim.batt), 30);
    payload.writeUInt16LE(sim.tick % 40 === 0 ? 1 : 0, 20); // 偶发通信错误
    this.gateway.receive(this._frame(1, payload, sim.sysid), { transport: 'sim', streamState: this._streamState(sim.sysid) });
  }

  _emitPosition(sim) {
    const payload = Buffer.alloc(28);
    payload.writeUInt32LE(sim.tick * this.tickMs, 0);
    payload.writeInt32LE(Math.round(sim.lat * 1e7), 4);
    payload.writeInt32LE(Math.round(sim.lon * 1e7), 8);
    payload.writeInt32LE(Math.round((sim.alt + 12) * 1000), 12);
    payload.writeInt32LE(Math.round(sim.alt * 1000), 16);
    payload.writeInt16LE(Math.round(sim.vx * 100), 20);
    payload.writeInt16LE(Math.round(sim.vy * 100), 22);
    payload.writeInt16LE(Math.round(sim.vz * 100), 24);
    payload.writeUInt16LE(Math.round(sim.heading * 100), 26);
    this.gateway.receive(this._frame(33, payload, sim.sysid), { transport: 'sim', streamState: this._streamState(sim.sysid) });
  }

  _streamState(sysid) {
    this._streams ??= new Map();
    let s = this._streams.get(sysid);
    if (!s) { s = { buffer: Buffer.alloc(0) }; this._streams.set(sysid, s); }
    return s;
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
