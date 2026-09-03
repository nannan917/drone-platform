/**
 * index.js — 无人机集群管理平台入口
 *
 * 启动参数:
 *   node server/src/index.js               仅 API(等待真实 MAVLink 接入)
 *   node server/src/index.js --sim 5       启动 5 架模拟无人机(默认 3)
 *   node server/src/index.js --udp 14550   额外监听 UDP 14550 端口接真实飞控
 *   node server/src/index.js --port 4000   覆盖 API 端口
 *   node server/src/index.js --token xxx   覆盖 API Token
 *   node server/src/index.js --origin 22.5935,113.9645  覆盖集群原点(默认深圳中科院 SIAT)
 */

import { createRequire } from 'node:module';
import { createSocket } from 'node:dgram';
import { ApiServer } from './api.js';
import { DroneSimulator } from './simulator.js';

// CJS 打包(SEA/pkg)下 import.meta.url 为空,提供 __filename 回退
const _thisUrl = (typeof import.meta !== 'undefined' && import.meta.url)
  ? import.meta.url
  : 'file:///' + String(typeof __filename !== 'undefined' ? __filename : '/index.js').split(/[\\/]/).join('/');
const require = createRequire(_thisUrl);
let pkg = { version: '1.0.0' };
try { pkg = require('../../package.json'); } catch { /* SEA 下 package.json 已内嵌 */ }

function parseArgs(argv) {
  const opts = { sim: 0, udp: null, port: 4000, token: null, origin: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sim') opts.sim = Number(argv[i + 1]) || 3;
    if (argv[i] === '--udp') opts.udp = Number(argv[i + 1]) || 14550;
    if (argv[i] === '--port') opts.port = Number(argv[i + 1]) || 4000;
    if (argv[i] === '--token') opts.token = argv[i + 1];
    if (argv[i] === '--origin') opts.origin = argv[i + 1];
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const logger = console;

logger.info('==============================================');
logger.info(` 无人机集群管理平台 v${pkg.version}`);
logger.info('  架构: AOP 横切 + ARP 表驱动寻址 + MAVLink');
logger.info('==============================================');

async function main() {
const api = new ApiServer({
  port: opts.port,
  apiToken: opts.token,
  logger,
});

await api.start();
api.udpPort = null;
api.udpListening = false;

// —— UDP 传输:接入真实飞控/MAVLink 设备 ——
if (opts.udp) {
  const udp = createSocket('udp4');
  const streams = new Map(); // 远端地址 → 流状态
  udp.on('message', (msg, rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}`;
    const streamState = streams.get(key) ?? { buffer: Buffer.alloc(0) };
    streams.set(key, streamState);
    api.gateway.receive(msg, {
      transport: 'udp',
      host: rinfo.address,
      port: rinfo.port,
      streamState,
    });
  });
  api.gateway.registerTransport('udp', {
    send: (frame, entry) => {
      // 仅向已知条目回发(避免广播风暴)
      if (entry.host && entry.port) {
        udp.send(frame, entry.port, entry.host, () => {});
      }
    },
  });
  udp.bind(opts.udp);
  logger.info(`[MAVLink] UDP ${opts.udp} 已监听,等待真实飞控接入…`);
  api.udpPort = opts.udp;
  api.udpListening = true;
}

// —— 内置模拟器 ——
let sim = null;
if (opts.sim > 0) {
  const simOpts = { count: opts.sim, tickMs: 800 };
  if (opts.origin) {
    const [lat, lon] = opts.origin.split(',').map(Number);
    if (!isNaN(lat) && !isNaN(lon)) {
      simOpts.originLat = lat;
      simOpts.originLon = lon;
    }
  }
  sim = new DroneSimulator(api.gateway, simOpts);
  sim.attach();
  sim.start();
  logger.info(`[SIM] 已启动 ${opts.sim} 架模拟无人机 @ ${sim.originLat},${sim.originLon}`);
  logger.info(`[SIM] 环境: 风 ${sim.windSpeed}m/s @${sim.windDir}°  队形 ${sim.formation.type}`);
}
api.simulator = sim;
// 用实际模拟器原点同步业务模块(AOP 走廊基于真实集群原点)
if (sim) {
  api.operations.originLat = sim.originLat;
  api.operations.originLon = sim.originLon;
  // 若尚无持久化空域数据,基于真实原点重建默认 AOP 走廊
  if (api.operations.airspace?.corridors?.length === 0) api.operations._initDefaults();
  logger.info(`[OPS] 业务模块就绪 @ ${sim.originLat},${sim.originLon}`);
}

  // —— 优雅退出 ——
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('正在关闭…');
    try { api.stop(); } catch { /* ignore */ }
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} // end main

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
