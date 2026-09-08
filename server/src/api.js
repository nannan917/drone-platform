/**
 * api.js — REST API + WebSocket 实时推送
 *
 * REST 端点(参考 AOP:统一经 authAspect 鉴权,loggingAspect 记日志):
 *   GET  /api/health                健康检查
 *   GET  /api/drones                全部无人机状态(含 ARP 表)
 *   GET  /api/drones/:id            单机详情(状态+ARP 条目)
 *   POST /api/drones/:id/command    指令下发 { command, params }
 *   POST /api/drones/:id/arm|disarm|takeoff|land|rtl
 *   GET  /api/telemetry/:id         最近遥测采样
 *
 * WebSocket 推送(ws://host:port/ws):
 *   server→client: { type:'state'|'presence'|'command'|'snapshot', data }
 *   client→server: { type:'command', droneId, command, params }
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';
import { Aop, authAspect, loggingAspect } from './aop.js';
import { ArpTable } from './arp.js';
import { MavlinkGateway } from './gateway.js';
import { Operations } from './operations.js';
import { Management } from './management.js';
import { managementRoute, sessionToken, sameOrigin } from './management-http.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export class ApiServer {
  /**
   * @param {object} opts { port, webRoot, apiToken, logger, simulator }
   */
  constructor(opts = {}) {
    this.port = opts.port ?? 4000;
    this.webRoot = opts.webRoot ?? join(process.cwd(), 'server', 'public');
    this.apiToken = opts.apiToken ?? process.env.DRONE_API_TOKEN ?? 'dsh-demo-token';
    this.logger = opts.logger ?? console;
    this.simulator = opts.simulator ?? null;
    this.management = new Management({ dataDir: opts.dataDir });
    // Explicit API tokens remain available for controlled integrations/tests; the old public demo token is not an account.
    this.integrationToken = opts.apiToken && opts.apiToken !== 'dsh-demo-token' ? opts.apiToken : null;

    // —— AOP 容器 ——
    this.aop = new Aop();
    this.aop.logger = this.logger;
    if(process.env.DRONE_VERBOSE_TELEMETRY==='1')this.aop.aspect('*', loggingAspect(this.logger));

    // —— ARP 表(带状态变更回调推 WS)——
    this.arp = new ArpTable({
      ttlMs: 30_000,
      staleAfterMs: 8_000,
      offlineAfterMs: 15_000,
      onChange: (entry, reason) => this._broadcast({ type: 'presence', data: { droneId: entry.droneId, reason, state: entry.state, at: Date.now() } }),
    });

    // —— 网关 ——
    this.gateway = new MavlinkGateway(this.arp, this.aop, { logger: this.logger });
    this.gateway.subscribe((evt, payload) => {
      if (evt === 'state') this.management.observeDrone(payload);
      this._broadcast({ type: evt, data: payload });
    });

    // —— 业务运营模块(AOP 空域 / ARP 航路 / 任务 / 审计,融合自 Codex)—— 
    this.operations = new Operations({
      originLat: this.simulator?.originLat ?? 22.5935,
      originLon: this.simulator?.originLon ?? 113.9645,
      getDronePosition: (id) => {
        const st = this.gateway.getState(id);
        if (!st?.position) return null;
        return {
          lat: st.position.lat,
          lon: st.position.lon,
          alt: st.position.alt ?? st.position.relAlt ?? 0,
          heading: st.position.heading,
          battery: st.battery?.remaining,
        };
      },
      onChange: (action, data) => this._broadcast({ type: 'business', data: { action, ...data } }),
    });

    // —— 遥测采样(供 REST 查询,同时演示 AOP 遥测采集切面)——
    this.telemetryStore = new Map(); // droneId → 采样数组
    this.aop.aspect('ingest', {
      after: (ctx) => {
        const frame = ctx.args[0];
        const droneId = ctx.result;
        if (!droneId || !this.gateway.getState(droneId)) return;
        if ([1, 24, 30, 33, 147].includes(frame.msgid)) {
          const list = this.telemetryStore.get(droneId) || [];
          list.push({ msgid: frame.msgid, t: Date.now(), data: frame.decoded });
          if (list.length > 200) list.splice(0, list.length - 200);
          this.telemetryStore.set(droneId, list);
        }
      },
    });

    this.http = createServer((req, res) => this._route(req, res).catch(()=>{if(!res.headersSent)res.writeHead(400,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'请求无效'}));}));
    this.wss = new WebSocketServer({ server: this.http, path: '/ws' });
    this.wss.on('connection', (ws, req) => this._onWs(ws, req));
  }

  // ————— REST 路由 —————

  async _route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = decodeURIComponent(url.pathname);

    if (path.startsWith('/api/')) {
      return this._api(req, res, url, path);
    }
    // 静态资源
    let filePath = normalize(join(this.webRoot, path === '/' ? 'index.html' : path));
    if (filePath !== normalize(this.webRoot) && !filePath.startsWith(normalize(this.webRoot).replace(/[\\/]+$/,'')+sep)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    if (!existsSync(filePath) || (await stat(filePath)).isDirectory()) {
      filePath = join(this.webRoot, 'index.html');
    }
    const ext = extname(filePath);
    try {
      const body = readFileSync(filePath);
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  }

  async _api(req, res, url, path) {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const principal = this._principal(req);
    if (path.startsWith('/api/v2/')) return managementRoute(req, res, path, this.management, principal);
    // All legacy routes and WebSocket feeds share the same organization scope.
    if (path !== '/api/health') {
      if (req.method !== 'GET' && !sameOrigin(req)) return send(403,{error:'跨站请求被拒绝'});
      if (!principal) return send(401, { error: '请先登录' });
      if (!principal.permissions.includes('view')) return send(403, { error: '没有查看权限' });
      if (req.method !== 'GET' && !principal.permissions.includes('control')) return send(403, { error: '没有控制权限' });
      const scopedId = /^\/api\/(?:drones|telemetry)\/([^/]+)/.exec(path)?.[1];
      if (scopedId && !this.management.canSeeDrone(principal, scopedId)) return send(404, { error:'设备不在授权范围' });
      if (scopedId && req.method !== 'GET' && !this.management.canControlDrone(principal, scopedId)) return send(403,{error:'协作授权仅允许查看该设备'});
      if (principal.orgId !== 'hq' && !/^\/api\/(drones|telemetry)(\/|$)/.test(path)) return send(403,{error:'此接口仅对总站开放'});
      if (req.method !== 'GET' && /^\/api\/drones\/real-[^/]+\//.test(path)) return send(409,{error:'当前 QGC 转发链路仅支持遥测，未发送飞行指令。'});
    }

    try {
      if (path === '/api/health') {
        return send(200, { ok: true, time: Date.now(), drones: this.arp.size, wsClients: this.wss.clients.size });
      }
      if (path === '/api/system/udp') {
        return send(200, {
          listening: !!this.udpListening,
          port: this.udpPort ?? null,
          host: this._lanIp(),
          positionMessages: this.gateway.positionDiagnostics,
        });
      }
      if (path === '/api/sim/add' && req.method === 'POST') {
        if (!this.simulator) return send(400, { error: '模拟器未启用(启动时加 --sim N)' });
        const droneId = this.simulator.addDrone();
        this.logger.info(`[SIM] 前端接入新无人机: ${droneId}`);
        return send(200, { ok: true, droneId });
      }
      if (path === '/api/sim/formation' && req.method === 'POST') {
        if (!this.simulator) return send(400, { error: '模拟器未启用' });
        const body = await readJson(req);
        const result = this.simulator.setFormation(body.type, body.spacing);
        this.logger.info(`[SIM] 编队切换: ${JSON.stringify(body)} → ${JSON.stringify(result)}`);
        return send(result.ok ? 200 : 400, { ...result, wind: this.simulator.windSummary?.() });
      }
      if (path === '/api/sim/environment' && req.method === 'GET') {
        if (!this.simulator) return send(400, { error: '模拟器未启用' });
        return send(200, { wind: this.simulator.windSummary?.(), formation: this.simulator.formation, origin: { lat: this.simulator.originLat, lon: this.simulator.originLon } });
      }
      if (path === '/api/drones' && req.method === 'GET') {
        return send(200, {
          drones: this.gateway.allStates().filter(d=>this.management.canSeeDrone(principal,d.droneId)),
          arp: this.arp.snapshot().filter(d=>this.management.canSeeDrone(principal,d.droneId)),
          time: Date.now(),
        });
      }
      const m = path.match(/^\/api\/drones\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const state = this.gateway.getState(m[1]);
        const arpEntry = this.arp.resolve(m[1]);
        if (!state && !arpEntry) return send(404, { error: `unknown drone ${m[1]}` });
        return send(200, { droneId: m[1], state, arp: arpEntry ? { ...arpEntry } : null });
      }
      if (m && req.method === 'DELETE') {
        return this._deleteDrone(m[1], send, principal);
      }
      const cm = path.match(/^\/api\/drones\/([^/]+)\/command$/);
      if (cm && req.method === 'POST') {
        const body = await readJson(req);
        const result = this.gateway.command(cm[1], body);
        return send(result.ok ? 200 : 400, result);
      }
      // 快捷指令
      for (const verb of ['arm', 'disarm', 'takeoff', 'land', 'rtl']) {
        const vm = path.match(new RegExp(`^\\/api\\/drones\\/([^/]+)\\/${verb}$`));
        if (vm && req.method === 'POST') {
          const body = await readJson(req).catch(() => ({}));
          const result = this.gateway[verb](vm[1], body.alt);
          return send(result.ok ? 200 : 400, result);
        }
      }
      const gm = path.match(/^\/api\/drones\/([^/]+)\/goto$/);
      if (gm && req.method === 'POST') {
        const body = await readJson(req);
        const result = this.gateway.goto(gm[1], body.lat, body.lon, body.alt);
        return send(result.ok ? 200 : 400, result);
      }
      const tm = path.match(/^\/api\/telemetry\/([^/]+)$/);
      if (tm && req.method === 'GET') {
        return send(200, { droneId: tm[1], samples: this.telemetryStore.get(tm[1]) ?? [] });
      }

      // ————— 业务运营:空域 AOP / 航路 ARP / 任务 / 审计 —————
      if (path === '/api/airspace' && req.method === 'GET') {
        return send(200, this.operations.listAirspace());
      }
      if (path === '/api/airspace/corridors' && req.method === 'POST') {
        const b = await readJson(req);
        const r = this.operations.addCorridor(b);
        return send(r.ok ? 201 : 400, r);
      }
      const cm2 = path.match(/^\/api\/airspace\/corridors\/([^/]+)$/);
      if (cm2 && req.method === 'PUT') {
        const b = await readJson(req);
        const r = this.operations.updateCorridor(cm2[1], b);
        return send(r.ok ? 200 : 400, r);
      }
      if (cm2 && req.method === 'DELETE') {
        const r = this.operations.removeCorridor(cm2[1]);
        return send(r.ok ? 200 : 404, r);
      }
      if (path === '/api/airspace/restricted' && req.method === 'POST') {
        const b = await readJson(req);
        const r = this.operations.addRestricted(b);
        return send(r.ok ? 201 : 400, r);
      }
      const rm2 = path.match(/^\/api\/airspace\/restricted\/([^/]+)$/);
      if (rm2 && req.method === 'DELETE') {
        const r = this.operations.removeRestricted(rm2[1]);
        return send(r.ok ? 200 : 404, r);
      }
      if (rm2 && req.method === 'POST') {
        const r = this.operations.toggleRestricted(rm2[1]);
        return send(r.ok ? 200 : 400, r);
      }
      // ARP 航路规划
      if (path === '/api/routes/plan' && req.method === 'POST') {
        const b = await readJson(req);
        const r = this.operations.planRoute(b.droneId);
        return send(r.ok ? 200 : 400, r);
      }
      // 任务编排
      if (path === '/api/missions' && req.method === 'GET') {
        return send(200, { missions: this.operations.listMissions() });
      }
      if (path === '/api/missions' && req.method === 'POST') {
        const b = await readJson(req);
        const r = this.operations.createMission(b);
        return send(r.ok ? 201 : 400, r);
      }
      const mm = path.match(/^\/api\/missions\/([^/]+)\/(start|advance|fail)$/);
      if (mm && req.method === 'POST') {
        const b = await readJson(req).catch(() => ({}));
        let r;
        if (mm[2] === 'start') r = this.operations.startMission(mm[1], b.route);
        else if (mm[2] === 'advance') r = this.operations.advanceMission(mm[1], b.delta);
        else r = this.operations.failMission(mm[1], b.reason);
        return send(r.ok ? 200 : 400, r);
      }
      const md = path.match(/^\/api\/missions\/([^/]+)$/);
      if (md && req.method === 'DELETE') {
        const r = this.operations.removeMission(md[1]);
        return send(r.ok ? 200 : 404, r);
      }
      // 审计
      if (path === '/api/audit' && req.method === 'GET') {
        const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 100;
        return send(200, { audit: this.operations.listAudit(limit) });
      }
      if (path === '/api/audit' && req.method === 'DELETE') {
        return send(200, this.operations.clearAudit());
      }

      return send(404, { error: 'not found', path });
    } catch (e) {
      return send(500, { error: e.message });
    }
  }

  // ————— WebSocket —————

  _principal(req) {
    const user=this.management.session(sessionToken(req));
    if(user)return user;
    if(this.integrationToken && req.headers['x-api-token']===this.integrationToken) return {id:'integration',name:'服务接口',orgId:'hq',permissions:['view','control']};
    return null;
  }

  _onWs(ws, req) {
    if(!sameOrigin(req)){ws.close(1008,'跨站请求被拒绝');return;}
    const user=this._principal(req);
    if(!user?.permissions.includes('view')){ws.close(1008,'请先登录');return;}
    ws.platformRequest=req;
    ws.send(JSON.stringify({ type: 'snapshot', data: { drones: this.gateway.allStates().filter(d=>this.management.canSeeDrone(user,d.droneId)), arp: this.arp.snapshot().filter(d=>this.management.canSeeDrone(user,d.droneId)), time: Date.now() } }));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'command') {
          const current=this._principal(ws.platformRequest);
          if(!current?.permissions.includes('control')||!this.management.canControlDrone(current,msg.droneId)||String(msg.droneId).startsWith('real-')) {
            ws.send(JSON.stringify({type:'command_result',data:{ok:false,droneId:msg.droneId,reason:'未授权或当前链路仅支持遥测'}}));return;
          }
          const result = this.gateway.command(msg.droneId, msg.command);
          ws.send(JSON.stringify({ type: 'command_result', data: { ...result, droneId: msg.droneId } }));
        }
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* 忽略坏消息 */
      }
    });
  }

  _broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      const user=client.platformRequest&&this._principal(client.platformRequest);
      if(!user?.permissions.includes('view')){client.close(1008,'会话已失效');continue;}
      if(payload.data?.droneId&&!this.management.canSeeDrone(user,payload.data.droneId))continue;
      if(!payload.data?.droneId&&user.orgId!=='hq')continue;
      if (client.readyState === 1) client.send(text);
    }
  }

  /** 删除一架无人机(停模拟器遥测 + 清网关状态 + 清 ARP + 清遥测缓存)。 */
  async _deleteDrone(droneId, send, principal) {
    const arpEntry = this.arp.entries.get(droneId);
    const state = this.gateway.getState(droneId);
    if (!arpEntry && !state) return send(404, { error: `unknown drone ${droneId}` });
    // 若为模拟机,先停止其遥测循环,避免删后重新注册
    const sm = /^uav-(\d+)$/.exec(droneId);
    if (sm && this.simulator) {
      const r = this.simulator.removeDrone(Number(sm[1]));
      if (!r.ok && this.gateway.getState(droneId)) {
        // 非模拟来源(如曾从 udp 学到),仍继续清理网关状态
        this.logger.info(`[DEL] ${droneId} 非模拟机(${r.error}),仅清理网关状态`);
      }
    }
    const gwRemoved = this.gateway.removeDrone(droneId);
    this.telemetryStore.delete(droneId);
    this.operations?._touch?.('drone.remove', { droneId });
    this.management.audit(principal,'drone.remove','telemetry',droneId);
    this.logger.info(`[DEL] 已删除无人机 ${droneId} (gw=${gwRemoved})`);
    return send(200, { ok: true, droneId, removed: gwRemoved });
  }

  /** 探测本机局域网 IPv4(供飞控配置 UDP 目标)。 */
  _lanIp() {
    const ifaces = networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
    return '127.0.0.1';
  }

  start() {
    return new Promise((resolve) => {
      this.http.listen(this.port, () => {
        this.logger.info(`API + Web 服务已启动: http://127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    this.wss.close();
    this.http.close();
    this.arp.dispose();
    this.gateway.dispose();
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('无效 JSON'));
      }
    });
    req.on('error', reject);
  });
}

import { stat } from 'node:fs/promises';
