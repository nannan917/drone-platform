/**
 * arp.js — ARP 表驱动寻址的无人机注册表
 *
 * 参考 ARP(Address Resolution Protocol)的思想,将"无人机逻辑标识"映射到
 * "物理/网络地址":
 *
 *   droneId (逻辑地址)  ↔  { transport: 'udp'|'tcp'|'sim', host, port, sysid }
 *
 * 核心机制:
 *  - 学习(learn):收到未知来源的心跳/遥测时,自动登记到 ARP 表(类似 ARP 的
 *    免费通告与被动学习)。
 *  - 探测(probe):对已知但久未活跃的条目,周期性探测(模拟 ARP 请求)。
 *  - 老化(aging):条目 TTL 到期后标记 offline,再超时则移除(模拟 ARP 缓存过期)。
 *  - 查询(resolve):通过 droneId 解析出可用的通信端点(模拟 ARP 解析)。
 *
 * 每条 ARP 条目:
 *  {
 *    droneId, transport, host, port, sysid, compid,
 *    mac: 'sim:0' 之类唯一标识,
 *    state: 'learning'|'resolved'|'stale'|'offline'|'removed',
 *    firstSeen, lastSeen, lastHeartbeat,
 *    ttlMs, ageMs, lastProbeAt, stats: { packets, telemetry, commands }
 *  }
 */

const STATE = Object.freeze({
  LEARNING: 'learning',
  RESOLVED: 'resolved',
  STALE: 'stale',
  OFFLINE: 'offline',
  REMOVED: 'removed',
});

export class ArpTable {
  /**
   * @param {object} opts
   * @param {number} opts.ttlMs 条目存活时间(默认 30s)
   * @param {number} opts.staleAfterMs 超过多久未心跳进入 stale(默认 10s)
   * @param {number} opts.offlineAfterMs 超过多久标记离线(默认 20s)
   * @param {number} opts.cleanupIntervalMs 老化清理周期(默认 2s)
   * @param {(entry:object)=>void} [opts.onChange] 条目状态变化回调
   */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.staleAfterMs = opts.staleAfterMs ?? 10_000;
    this.offlineAfterMs = opts.offlineAfterMs ?? 20_000;
    this.cleanupIntervalMs = opts.cleanupIntervalMs ?? 2_000;
    this.onChange = opts.onChange ?? (() => {});
    /** @type {Map<string, object>} key: droneId */
    this.entries = new Map();
    this._timer = setInterval(() => this.age(), this.cleanupIntervalMs);
    this._timer.unref?.();
  }

  /** 广播探测回调(可被网关设置为向网络发送探测帧)。 */
  probeHandler = null;

  /**
   * 学习/刷新一个无人机条目。若不存在则新建(learning 态),已存在则更新
   * 地址信息与心跳时间。
   * @returns 条目
   */
  learn(droneId, info) {
    let e = this.entries.get(droneId);
    const isNew = !e;
    if (isNew) {
      e = {
        droneId,
        transport: info.transport ?? 'unknown',
        host: info.host ?? null,
        port: info.port ?? null,
        sysid: info.sysid ?? 1,
        compid: info.compid ?? 1,
        mac: info.mac ?? `${info.transport ?? 'x'}:${droneId}`,
        state: STATE.LEARNING,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        lastHeartbeat: null,
        ttlMs: this.ttlMs,
        ageMs: 0,
        lastProbeAt: 0,
        stats: { packets: 0, telemetry: 0, commands: 0 },
        extra: info.extra ?? {},
      };
      this.entries.set(droneId, e);
    } else {
      e.host = info.host ?? e.host;
      e.port = info.port ?? e.port;
      e.sysid = info.sysid ?? e.sysid;
      e.compid = info.compid ?? e.compid;
      e.transport = info.transport ?? e.transport;
      e.lastSeen = Date.now();
      if (e.state === STATE.OFFLINE || e.state === STATE.REMOVED) {
        e.state = STATE.LEARNING;
        this.onChange(e, 'relearn');
      }
    }
    e.stats.packets++;
    if (info.heartbeat) {
      e.lastHeartbeat = Date.now();
      if (e.state === STATE.LEARNING) {
        e.state = STATE.RESOLVED;
        this.onChange(e, 'resolve');
      }
    }
    return e;
  }

  /**
   * 通过 droneId 解析通信端点(ARP 解析)。
   * 命中且状态可用 → 返回条目;命中但 stale → 触发探测后返回;未命中 → null。
   */
  resolve(droneId) {
    const e = this.entries.get(droneId);
    if (!e) return null;
    if (e.state === STATE.OFFLINE || e.state === STATE.REMOVED) return null;
    if (e.state === STATE.STALE) this.probe(e);
    return e;
  }

  /** 向网络发送 ARP 探测(若网关注册了 probeHandler)。 */
  probe(e) {
    e.lastProbeAt = Date.now();
    if (this.probeHandler) {
      try {
        this.probeHandler(e);
      } catch {
        /* 探测失败不影响表 */
      }
    }
  }

  /** 删除条目(主动移除,如用户注销无人机)。 */
  remove(droneId) {
    const e = this.entries.get(droneId);
    if (!e) return false;
    e.state = STATE.REMOVED;
    this.entries.delete(droneId);
    this.onChange(e, 'remove');
    return true;
  }

  /** 记录一次遥测包计数。 */
  noteTelemetry(droneId) {
    const e = this.entries.get(droneId);
    if (e) e.stats.telemetry++;
  }

  /** 记录一次指令下发计数。 */
  noteCommand(droneId) {
    const e = this.entries.get(droneId);
    if (e) e.stats.commands++;
  }

  /** 老化扫描:按心跳时间推进状态机。 */
  age() {
    const now = Date.now();
    for (const e of this.entries.values()) {
      if (e.state === STATE.REMOVED) continue;
      const idle = now - (e.lastHeartbeat ?? e.lastSeen);
      e.ageMs = idle;
      if (idle > this.offlineAfterMs && e.state !== STATE.OFFLINE) {
        e.state = STATE.OFFLINE;
        this.onChange(e, 'offline');
      } else if (idle > this.staleAfterMs && e.state === STATE.RESOLVED) {
        e.state = STATE.STALE;
        this.onChange(e, 'stale');
      } else if (idle > this.ttlMs && e.state === STATE.OFFLINE) {
        this.entries.delete(e.droneId);
        this.onChange(e, 'expire');
      } else if (e.state === STATE.LEARNING && idle > this.ttlMs) {
        // learning 状态但从未心跳成功 → 移除
        this.entries.delete(e.droneId);
        this.onChange(e, 'expire');
      }
    }
  }

  /** 全表快照(按 state 排序,offline 放最后)。 */
  snapshot() {
    const rank = { resolved: 0, learning: 1, stale: 2, offline: 3 };
    const arr = [...this.entries.values()].sort(
      (a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || a.droneId.localeCompare(b.droneId)
    );
    return arr.map((e) => ({ ...e }));
  }

  get size() {
    return this.entries.size;
  }

  dispose() {
    clearInterval(this._timer);
  }
}
