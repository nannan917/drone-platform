/**
 * operations.js — 业务运营模块(融合自 Codex 平台)
 *
 * 将 Codex 平台的高价值业务概念移植到本平台(真实 MAVLink/坐标/地图底座之上):
 *
 *  - AOP(空域运营计划):管理低空走廊(名称/高度层/经纬度路径)与限制区/禁飞区
 *  - ARP(航路与时隙规划):为指定无人机生成推荐走廊/高度层/时隙/风险评级/航路点
 *  - 任务编排(Mission):创建任务、指派无人机、状态流转、进度
 *  - 审计(Audit):记录近 300 条操作
 *
 * 均以 JSON 持久化到 data/operations.json,重启保留。
 *
 * 设计:originLat/originLon 提供走廊的生成基准;getDronePosition(droneId) 注入
 * 网关的实时位置,使 ARP 规划的航路点基于无人机真实经纬度。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// CJS 打包(SEA/pkg)下 import.meta.url 为空,用 __filename 回退
const _metaUrl = (typeof import.meta !== 'undefined' && import.meta.url)
  ? import.meta.url
  : 'file:///' + String(typeof __filename !== 'undefined' ? __filename : 'server/src/operations.js').split(/[\\/]/).join('/');
const __dirname = dirname(fileURLToPath(_metaUrl));
// SEA 单文件模式下源码目录不可写,数据落到可写位置(可用 DRONE_DATA_DIR 覆盖)
const _dataDir = process.env.DRONE_DATA_DIR || join(__dirname, '..', 'data');
const DATA_FILE = join(_dataDir, 'operations.json');

const M_PER_DEG_LAT = 111320;

function degOffsetM(lat0, offsetMeters, directionDeg) {
  // 从 lat0 出发,向 directionDeg(0=北) 偏移 offsetMeters 米,返回 {lat, lon}
  const r = (directionDeg * Math.PI) / 180;
  const dLat = (Math.cos(r) * offsetMeters) / M_PER_DEG_LAT;
  const dLon = (Math.sin(r) * offsetMeters) / (M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180));
  return { dLat, dLon };
}

function metersBetween(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * M_PER_DEG_LAT;
  const dLon = (lon2 - lon1) * M_PER_DEG_LAT * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

export class Operations {
  /**
   * @param {object} opts
   * @param {number} opts.originLat 集群原点纬度(走廊生成基准)
   * @param {number} opts.originLon
   * @param {Function} [opts.getDronePosition] (droneId) => {lat, lon, alt} | null
   * @param {(evt,data)=>void} [opts.onChange] 业务状态变化回调(供广播/事件流)
   */
  constructor(opts = {}) {
    this.originLat = opts.originLat ?? 22.5935;
    this.originLon = opts.originLon ?? 113.9645;
    this.getDronePosition = opts.getDronePosition ?? (() => null);
    this.onChange = opts.onChange ?? (() => {});
    this.audit = [];
    this._load();
    this._initDefaults();
  }

  _load() {
    if (existsSync(DATA_FILE)) {
      try {
        const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
        this.airspace = raw.airspace ?? { corridors: [], restricted: [], revision: 0 };
        this.missions = raw.missions ?? [];
        this.audit = raw.audit ?? [];
        return;
      } catch {
        /* 损坏则重建 */
      }
    }
    this.airspace = { corridors: [], restricted: [], revision: 0 };
    this.missions = [];
  }

  _initDefaults() {
    // 仅在空数据时注入演示走廊/限制区(基于 origin,真实经纬度)
    if (this.airspace.corridors.length === 0) {
      const L = this.originLat, O = this.originLon;
      this.airspace.corridors = [
        {
          id: 'AOP-01', name: '南向巡检走廊', ceiling: 120,
          color: '#38bdf8', status: '运行中',
          path: corridorPath(L, O, 400, 1500, -160),   // 向西南
        },
        {
          id: 'AOP-02', name: '东侧物流走廊', ceiling: 90,
          color: '#34d399', status: '运行中',
          path: corridorPath(L, O, 350, 1300, -40),
        },
      ];
      this.airspace.revision = 1;
    }
    if (this.airspace.restricted.length === 0) {
      const o = this._offset(-300, 200);
      this.airspace.restricted = [
        { id: 'R-01', name: '临时禁飞区', lat: o.lat, lon: o.lon, radius: 180, reason: '临时施工吊装', active: true },
      ];
    }
    if (this.missions.length === 0) {
      this.missions = [];
    }
    this._persist();
  }

  _offset(dNorthM, dEastM) {
    const dLat = dNorthM / M_PER_DEG_LAT;
    const dLon = dEastM / (M_PER_DEG_LAT * Math.cos((this.originLat * Math.PI) / 180));
    return { lat: this.originLat + dLat, lon: this.originLon + dLon };
  }

  // ============ AOP 空域 ============

  listAirspace() {
    return {
      corridors: this.airspace.corridors,
      restricted: this.airspace.restricted,
      revision: this.airspace.revision,
      origin: { lat: this.originLat, lon: this.originLon },
    };
  }

  addCorridor({ name, ceiling, color, path }) {
    if (!name || !Number.isFinite(Number(ceiling)) || Number(ceiling) < 20 || Number(ceiling) > 1000) {
      return { ok: false, error: '请填写有效走廊名称与 20–1000m 高度' };
    }
    const id = `AOP-${String(this.airspace.corridors.length + 1).padStart(2, '0')}`;
    const corridor = {
      id,
      name,
      ceiling: Number(ceiling),
      color: color || '#38bdf8',
      status: '运行中',
      path: Array.isArray(path) && path.length >= 2 ? path : corridorPath(this.originLat, this.originLon, 300, 1200, -100),
    };
    this.airspace.corridors.push(corridor);
    this.airspace.revision++;
    this._touch('aop.add', { corridorId: id, name });
    return { ok: true, corridor };
  }

  updateCorridor(id, patch) {
    const c = this.airspace.corridors.find((x) => x.id === id);
    if (!c) return { ok: false, error: 'AOP 不存在' };
    if (patch.name) c.name = patch.name;
    if (patch.ceiling !== undefined && Number.isFinite(Number(patch.ceiling))) c.ceiling = Number(patch.ceiling);
    if (patch.color) c.color = patch.color;
    if (Array.isArray(patch.path) && patch.path.length >= 2) c.path = patch.path;
    this.airspace.revision++;
    this._touch('aop.update', { corridorId: id });
    return { ok: true, corridor: c };
  }

  removeCorridor(id) {
    const before = this.airspace.corridors.length;
    this.airspace.corridors = this.airspace.corridors.filter((x) => x.id !== id);
    if (this.airspace.corridors.length === before) return { ok: false, error: 'AOP 不存在' };
    this.airspace.revision++;
    this._touch('aop.remove', { corridorId: id });
    return { ok: true };
  }

  addRestricted({ name, lat, lon, radius, reason }) {
    const id = `R-${String(this.airspace.restricted.length + 1).padStart(2, '0')}`;
    const p = Number.isFinite(Number(lat)) ? { lat: Number(lat), lon: Number(lon) } : this._offset(-300, 200);
    const r = {
      id, name: name || `限制区-${id}`,
      lat: p.lat, lon: p.lon,
      radius: Number(radius) || 150,
      reason: reason || '',
      active: true,
    };
    this.airspace.restricted.push(r);
    this.airspace.revision++;
    this._touch('restricted.add', { id });
    return { ok: true, restricted: r };
  }

  toggleRestricted(id) {
    const r = this.airspace.restricted.find((x) => x.id === id);
    if (!r) return { ok: false, error: '限制区不存在' };
    r.active = !r.active;
    this.airspace.revision++;
    this._touch('restricted.toggle', { id, active: r.active });
    return { ok: true, restricted: r };
  }

  removeRestricted(id) {
    const before = this.airspace.restricted.length;
    this.airspace.restricted = this.airspace.restricted.filter((x) => x.id !== id);
    if (this.airspace.restricted.length === before) return { ok: false, error: '限制区不存在' };
    this.airspace.revision++;
    this._touch('restricted.remove', { id });
    return { ok: true };
  }

  // ============ ARP 航路规划 ============

  planRoute(droneId) {
    const pos = this.getDronePosition(droneId);
    if (!pos) return { ok: false, error: `无人机 ${droneId} 无实时位置(离线)` };
    // 依据是否接近限制区判断风险,选取合适走廊
    let recommendedCorridor = null;
    let bestDist = Infinity;
    for (const c of this.airspace.corridors) {
      if (c.status !== '运行中') continue;
      // 到走廊首点距离作为"就近"度量
      const d = metersBetween(pos.lat, pos.lon, c.path[0].lat, c.path[0].lon);
      if (d < bestDist) { bestDist = d; recommendedCorridor = c; }
    }
    const altitude = Math.min(recommendedCorridor?.ceiling ?? 100, (pos.alt ?? 60) + 20 || 80);
    // 风险评级:考虑电量与是否接近限制区
    let risk = '低';
    if (pos.battery !== undefined && pos.battery < 25) risk = '中(低电量需返航)';
    for (const r of this.airspace.restricted) {
      if (!r.active) continue;
      const d = metersBetween(pos.lat, pos.lon, r.lat, r.lon);
      if (d < r.radius * 2) { risk = '中(临近限制区)'; break; }
    }
    const route = {
      id: `ARP-${Date.now().toString().slice(-6)}`,
      droneId,
      createdAt: Date.now(),
      recommendedAop: recommendedCorridor?.id ?? null,
      corridorName: recommendedCorridor?.name ?? null,
      altitude: Math.round(altitude),
      slot: '待调度确认',
      risk,
      waypoints: [],
      mode: 'SIMULATION',
    };
    // 航路点:从当前位置出发,取走廊的中段与末端两个点(避免与起点重复)
    const base = recommendedCorridor?.path ?? corridorPath(this.originLat, this.originLon, 300, 1200, -90);
    const alt = Math.round(altitude);
    const routeWps = [{ lat: round6(pos.lat), lon: round6(pos.lon), alt }];
    const farPts = base.filter((p) => metersBetween(pos.lat, pos.lon, p.lat, p.lon) > 80);
    if (farPts.length >= 2) {
      const mid = farPts[Math.floor(farPts.length / 2)];
      routeWps.push({ lat: round6(mid.lat), lon: round6(mid.lon), alt });
      routeWps.push({ lat: round6(farPts[farPts.length - 1].lat), lon: round6(farPts[farPts.length - 1].lon), alt });
    } else if (farPts.length === 1) {
      routeWps.push({ lat: round6(farPts[0].lat), lon: round6(farPts[0].lon), alt });
    } else {
      // 走廊太近,直接沿当前航向延伸生成远端航路点
      const off = degOffsetM(pos.lat, 600, pos.heading ?? 0);
      routeWps.push({ lat: round6(pos.lat + off.dLat), lon: round6(pos.lon + off.dLon), alt });
    }
    route.waypoints = routeWps;
    this._touch('arp.plan', { droneId, routeId: route.id, corridor: route.recommendedAop });
    return { ok: true, route };
  }

  // ============ 任务编排 ============

  listMissions() {
    return this.missions;
  }

  createMission({ name, droneId, priority }) {
    if (!name || !droneId) return { ok: false, error: '任务名称与执行无人机为必填项' };
    const mission = {
      id: `M-${new Date().getFullYear()}-${String(this.missions.length + 1).padStart(3, '0')}`,
      name,
      droneId,
      priority: priority || '中',
      status: '规划中',      // 规划中 → 执行中 → 完成 | 失败
      progress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      route: null,
    };
    this.missions.unshift(mission);
    this._touch('mission.create', { missionId: mission.id, droneId, name });
    return { ok: true, mission };
  }

  startMission(id, route) {
    const m = this.missions.find((x) => x.id === id);
    if (!m) return { ok: false, error: '任务不存在' };
    m.status = '执行中';
    m.updatedAt = Date.now();
    if (route) m.route = route;
    this._touch('mission.start', { missionId: id, droneId: m.droneId });
    return { ok: true, mission: m };
  }

  advanceMission(id, delta = 5) {
    const m = this.missions.find((x) => x.id === id);
    if (!m) return { ok: false, error: '任务不存在' };
    if (m.status !== '执行中') return { ok: false, error: '任务未在执行中', mission: m };
    m.progress = Math.min(100, (m.progress || 0) + delta);
    m.updatedAt = Date.now();
    if (m.progress >= 100) {
      m.status = '完成';
      this._touch('mission.complete', { missionId: id });
    } else {
      this._touch('mission.progress', { missionId: id, progress: m.progress });
    }
    return { ok: true, mission: m };
  }

  failMission(id, reason) {
    const m = this.missions.find((x) => x.id === id);
    if (!m) return { ok: false, error: '任务不存在' };
    m.status = '失败';
    m.updatedAt = Date.now();
    this._touch('mission.fail', { missionId: id, reason: reason || '未知' });
    return { ok: true, mission: m };
  }

  removeMission(id) {
    const idx = this.missions.findIndex((x) => x.id === id);
    if (idx === -1) return { ok: false, error: '任务不存在' };
    this.missions.splice(idx, 1);
    this._touch('mission.remove', { missionId: id });
    return { ok: true };
  }

  // ============ 审计 ============

  listAudit(limit = 100) {
    return this.audit.slice(0, limit);
  }

  clearAudit() {
    this.audit = [];
    this._persist();
    return { ok: true };
  }

  _touch(action, details) {
    this.audit.unshift({ id: Date.now(), at: new Date().toISOString(), action, ...details });
    if (this.audit.length > 300) this.audit.pop();
    this._persist();
    this.onChange(action, details);
  }

  _persist() {
    try {
      mkdirSync(dirname(DATA_FILE), { recursive: true });
      writeFileSync(DATA_FILE, JSON.stringify({
        airspace: this.airspace,
        missions: this.missions,
        audit: this.audit,
      }, null, 2));
    } catch (e) {
      /* 持久化失败不影响运行 */
    }
  }
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function corridorPath(lat0, lon0, startM, lenM, dirDeg) {
  // 生成 5 个点的走廊路径:从起点向 directionDeg 延伸
  const pts = [];
  for (let i = 0; i < 5; i++) {
    const off = degOffsetM(lat0, startM + (lenM / 4) * i, dirDeg + (i % 2 === 1 ? 8 : 0));
    pts.push({ lat: round6(lat0 + off.dLat), lon: round6(lon0 + off.dLon) });
  }
  return pts;
}
