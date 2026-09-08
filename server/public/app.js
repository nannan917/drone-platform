/* app.js — 无人机集群管理平台前端 */
import { forgetDrone, replaceSnapshot, applyPresence } from './device-state.js';
import { currentPosition, positionLabel, gpsFixLabel, validMapCoordinates } from './position-ui.js';
(() => {
  'use strict';

  const API_TOKEN = ''; // Account cookie authenticates all requests.
  const API = (path, opts = {}) => {
    const headers = { 'X-API-Token': API_TOKEN, ...(opts.headers || {}) };
    return fetch(`/api${path}`, { ...opts, headers }).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      return body;
    });
  };

  // ————— 状态 —————
  const state = {
    drones: new Map(),   // droneId → 状态对象
    arp: new Map(),      // droneId → ARP 条目
    selected: null,
    connected: false,
    events: [],
  };
  // 遥测历史:droneId → [{t, alt, batt, speed, hdg}]
  const history = new Map();
  const HIST_LEN = 120;

  // ————— DOM —————
  const $ = (id) => document.getElementById(id);
  const el = {
    total: $('stat-total'), online: $('stat-online'), flying: $('stat-flying'), offline: $('stat-offline'),
    connDot: $('conn-dot'), connText: $('conn-text'),
    droneList: $('drone-list'), detailBody: $('detail-body'), selId: $('sel-id'),
    chartCanvas: $('chart-canvas'), chartDrone: $('chart-drone'),
    eventList: $('event-list'),
    toast: $('toast'),
    mapCenterLon: $('map-center-lon'), mapCenterLat: $('map-center-lat'), mapZoom: $('map-zoom'),
    modalRoot: $('modal-root'),
  };
  // 业务数据缓存
  const biz = {
    airspace: { corridors: [], restricted: [], revision: 0 },
    missions: [],
    audit: [],
    arpDrone: null,
  };
  // 当前视图
  let currentView = 'run';
  // 地图叠加层组
  let corridorLayer = null, restrictedLayer = null;

  // ————— WebSocket —————
  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      state.connected = true;
      el.connDot.className = 'dot ok';
      el.connText.textContent = '已连接';
      addEvent('system', 'WebSocket 已连接');
    };
    ws.onclose = () => {
      state.connected = false;
      el.connDot.className = 'dot bad';
      el.connText.textContent = '已断开,重连中…';
      setTimeout(connectWs, 2000);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') {
        replaceSnapshot(state, history, msg.data, upsertDrone);
        renderAll();
      } else if (msg.type === 'state') {
        upsertDrone(msg.data);
        renderAll();
      } else if (msg.type === 'presence') {
        handlePresence(msg.data);
      } else if (msg.type === 'command') {
        addEvent('command', `指令 → ${msg.data.droneId} (cmd=${msg.data.command})`);
      } else if (msg.type === 'command_result') {
        const r = msg.data;
        addEvent(r.ok ? 'command' : 'warn', `指令结果 ${r.droneId}: ${r.ok ? '成功' : r.reason}`);
      }
    };
    window._ws = ws;
    return ws;
  }

  function handlePresence(p) {
    const map = {
      resolve: ['presence', `${p.droneId} 上线 (ARP 解析成功)`],
      learn: ['presence', `${p.droneId} 被发现 (ARP 学习中)`],
      stale: ['warn', `${p.droneId} 信号变弱 (ARP stale)`],
      offline: ['warn', `${p.droneId} 离线 (ARP 老化)`],
      expire: ['warn', `${p.droneId} ARP 条目已过期移除`],
      remove: ['presence', `${p.droneId} 已注销`],
      relearn: ['presence', `${p.droneId} 重新上线`],
    };
    const [cls, text] = map[p.reason] || ['presence', `${p.droneId} ${p.reason}`];
    addEvent(cls, text);
    applyPresence(state, history, p);
    renderAll();
  }

  function upsertDrone(d) {
    const prev = state.drones.get(d.droneId);
    state.drones.set(d.droneId, { ...(prev || {}), ...d });
    if (!state.selected) state.selected = d.droneId;
    // 遥测历史采样(含经纬度,供轨迹绘制)
    if (d.position || d.battery || d.gps) {
      const h = history.get(d.droneId) || [];
      h.push({
        t: Date.now(),
        lat: d.position ? d.position.lat : null,
        lon: d.position ? d.position.lon : null,
        alt: d.position ? Math.round((d.position.relAlt ?? d.position.alt) * 10) / 10 : null,
        batt: d.battery ? Math.round(d.battery.remaining ?? 0) : null,
        speed: d.gps ? Math.round(d.gps.groundSpeed * 10) / 10 : null,
        hdg: d.position ? Math.round(d.position.heading ?? 0) : null,
      });
      if (h.length > HIST_LEN) h.splice(0, h.length - HIST_LEN);
      history.set(d.droneId, h);
    }
  }

  // ————— 渲染 —————
  function renderAll() {
    renderStats();
    renderDroneList();
    renderDetail();
    renderMap();
    renderChart();
  }

  function renderStats() {
    let online = 0, flying = 0;
    for (const d of state.drones.values()) {
      if (d.online) online++;
      if (d.online && d.mode && /GUIDED|AUTO|RTL|LAND/.test(d.mode)) flying++;
    }
    el.total.textContent = state.drones.size;
    el.online.textContent = online;
    el.flying.textContent = flying;
    el.offline.textContent = Math.max(0, state.drones.size - online);
  }

  function droneClass(d) {
    if (!d.online) return 'offline';
    // 用 ARP 状态判断弱信号
    const arp = state.arp.get(d.droneId);
    if (arp && (arp.state === 'stale' || arp.state === 'learning')) return 'stale';
    if (d.mode && /GUIDED|AUTO|RTL|LAND/.test(d.mode)) return 'flying';
    return 'online';
  }

  function renderDroneList() {
    const list = [...state.drones.values()].sort((a, b) => a.droneId.localeCompare(b.droneId));
    if (list.length === 0) {
      el.droneList.innerHTML = '<div class="placeholder" style="color:var(--muted);text-align:center;margin-top:20px">暂无无人机<br>点击右上角"接入"</div>';
      return;
    }
    el.droneList.innerHTML = list.map((d) => {
      const cls = droneClass(d);
      const pos = currentPosition(d);
      const batt = d.battery;
      return `
      <div class="drone-card ${cls} ${d.droneId === state.selected ? 'selected' : ''}" data-id="${d.droneId}">
        <div class="row1">
          <span class="name">${d.droneId}</span>
          <span class="badge ${cls}">${d.online ? (d.mode || 'ONLINE') : 'OFFLINE'}</span>
          <button class="del-drone" data-id="${d.droneId}" title="删除无人机">✕</button>
        </div>
        <div class="row2">
          <span>${d.vehicleType || '-'} · ${d.autopilot || '-'}</span>
          <span>${d.transport || '-'}</span>
        </div>
        <div class="row3">
          <span><span class="k">位置</span> <span class="v">${pos ? pos.lat.toFixed(5) + ', ' + pos.lon.toFixed(5) : '—'}</span></span>
          <span><span class="k">高</span> <span class="v">${pos && (pos.relAlt ?? pos.alt) != null ? (pos.relAlt ?? pos.alt).toFixed(1) + 'm' : '—'}</span></span>
          <span><span class="k">电</span> <span class="v">${batt?.remaining != null ? batt.remaining + '%' : '—'}</span></span>
        </div>
      </div>`;
    }).join('');
    el.droneList.querySelectorAll('.drone-card').forEach((card) => {
      card.onclick = () => { state.selected = card.dataset.id; renderAll(); };
    });
    el.droneList.querySelectorAll('.del-drone').forEach((btn) => {
      if(!window.platformUser?.permissions.includes('control')){btn.remove();return;}
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const id = btn.dataset.id;
        openModal(`
          <h3>删除无人机</h3>
          <p style="color:var(--muted);font-size:13px">确定要从集群删除 <b>${id}</b> 吗？模拟机将停止遥测；真实设备将在本次服务运行期间忽略，重启服务后可重新接入。</p>
          <div class="modal-actions"><button class="btn" onclick="window.__closeModal()">取消</button><button class="btn danger" id="del-ok">确认删除</button></div>`);
        $('del-ok').onclick = async () => {
          try {
            await API(`/drones/${encodeURIComponent(id)}`, { method: 'DELETE' });
            forgetDrone(state, history, id);
            window.__closeModal(); toast(`已删除 ${id}`);
            if (state.selected === id) state.selected = null;
            renderAll();
          } catch (e) { toast(e.message, true); }
        };
      };
    });
  }

  function renderDetail() {
    const d = state.drones.get(state.selected);
    if (!d) {
      el.selId.textContent = '未选择';
      el.detailBody.innerHTML = '<div class="placeholder">在地图上点击无人机或从列表选择</div>';
      return;
    }
    el.selId.textContent = d.droneId;
    const pos = currentPosition(d);
    const batt = d.battery;
    const att = d.attitude;
    const gps = d.gps;
    const sys = d.sysStatus;
    const arp = state.arp.get(d.droneId);
    const mode = d.online ? (d.mode || 'N/A') : 'OFFLINE';
    const i = (label, value, cls = '') => `<div class="detail-item"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
    el.detailBody.innerHTML = `
      <div class="detail-grid">
        ${i('状态', mode, d.online ? (droneClass(d) === 'flying' ? 'ok' : '') : 'warn')}
        ${i('机型', d.vehicleType || '—', 'small')}
        ${i('飞控', d.autopilot || '—', 'small')}
        ${i('链路', d.transport || '—', 'small')}
        ${i('定位状态', positionLabel(d), 'small')}
        ${i('GPS 定位', gpsFixLabel(gps), 'small')}
        ${i('GPS 设备', d.gpsSensor ? (d.gpsSensor.present ? (d.gpsSensor.healthy ? '飞控报告正常' : '已检测，尚未就绪') : '飞控未报告 GPS 设备') : '状态未知', 'small')}
        ${i('纬度', pos ? pos.lat.toFixed(6) : '—', 'small')}
        ${i('经度', pos ? pos.lon.toFixed(6) : '—', 'small')}
        ${i(pos?.relAlt != null ? '相对高度' : '海拔高度', pos && (pos.relAlt ?? pos.alt) != null ? (pos.relAlt ?? pos.alt).toFixed(1) + ' m' : '—')}
        ${i('航向', pos?.heading != null ? Math.round(pos.heading) + '°' : '—')}
        ${i('电量', batt ? (batt.remaining == null ? '未知' : batt.remaining + '%') + ' / ' + (batt.voltage == null ? '电压未知' : batt.voltage.toFixed(2) + 'V') : '—', batt?.remaining != null && batt.remaining < 25 ? 'warn' : '')}
        ${i('速度', gps?.groundSpeed != null ? gps.groundSpeed.toFixed(1) + ' m/s' : '—', 'small')}
        ${i('卫星', gps?.satellitesVisible ?? '未知', 'small')}
        ${i('姿态', att ? `R${att.roll.toFixed(0)}° P${att.pitch.toFixed(0)}° Y${att.yaw.toFixed(0)}°` : '—', 'small')}
        ${i('系统负载', sys ? sys.load + '%' : '—', 'small')}
        ${i('收包数', d.packets ?? 0, 'small')}
        ${i('ARP 状态', arp ? arp.state : '—', 'small')}
      </div>
      <div class="actions">
        <button class="btn" data-cmd="arm">🔒 解锁</button>
        <button class="btn" data-cmd="disarm">🔓 上锁</button>
        <button class="btn primary" data-cmd="takeoff">🛫 起飞</button>
        <button class="btn" data-cmd="land">🛬 降落</button>
        <button class="btn" data-cmd="rtl">🏠 返航</button>
      </div>
      <div class="goto-row">
        <input id="goto-lat" placeholder="目标纬度" />
        <input id="goto-lon" placeholder="目标经度" />
        <button class="btn primary" data-cmd="goto">🚀 前往</button>
      </div>
    `;
    if(d.droneId.startsWith('real-')||!window.platformUser?.permissions.includes('control')){
      el.detailBody.querySelector('.actions').innerHTML='<p class="position-status">当前接入为遥测查看；飞行操作请在 QGC 中进行。</p>';
      el.detailBody.querySelector('.goto-row').remove();
    }
    el.detailBody.querySelectorAll('[data-cmd]').forEach((btn) => {
      btn.onclick = () => sendCommand(btn.dataset.cmd);
    });
  }

  function sendCommand(cmd) {
    const id = state.selected;
    if (!id) return;
    let promise;
    if (cmd === 'goto') {
      const lat = parseFloat($('goto-lat').value);
      const lon = parseFloat($('goto-lon').value);
      if (isNaN(lat) || isNaN(lon)) return toast('请输入有效的目标经纬度', true);
      promise = API(`/drones/${id}/goto`, { method: 'POST', body: JSON.stringify({ lat, lon }), headers: { 'content-type': 'application/json' } });
    } else {
      promise = API(`/drones/${id}/${cmd}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    }
    promise.then((r) => {
      toast(`${id} ${cmd}: ${r.ok ? r.result : (r.reason || '失败')}`, !r.ok);
    }).catch((e) => toast(e.message, true));
  }

  // ————— 实时地图(Leaflet)—————
  // Start with a world overview, never a pretend local/aircraft position.
  const MAP = { originLat: 20, originLon: 0, zoom: 2 };
  let map = null;
  /** @type {Map<string, L.Marker>} */
  const markers = new Map();
  /** @type {Map<string, L.Polyline>} 轨迹线 */
  const trails = new Map();
  let followMode = true;
  let centeredOnDrone = false;
  let mapSource = 'overview';
  let computerMarker = null;
  let computerAccuracy = null;

  function setFollow(enabled) {
    followMode = enabled;
    $('btn-map-follow').textContent = enabled ? '跟随飞控：开' : '跟随飞控：关';
    $('btn-map-follow').setAttribute('aria-pressed', String(enabled));
  }

  function initMap() {
    if (map) return;
    map = L.map('map', {
      center: [MAP.originLat, MAP.originLon],
      zoom: MAP.zoom,
      zoomControl: true,
    });
    // 主底图:Esri 卫星影像(本环境实测可达,免费、无需 key)
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
      maxZoom: 19,
    });
    // 备选:CartoDB 深色街道 / OSM 标准街道(网络可达时可用)
    const dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20,
    });
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    });
    sat.addTo(map);
    L.control.layers(
      { '卫星影像 (Esri)': sat, '深色街道 (CARTO)': dark, '标准街道 (OSM)': osm },
      {},
      { position: 'topright' }
    ).addTo(map);
    map.on('click', () => { state.selected = null; renderAll(); });
    map.on('dragstart', () => { setFollow(false); mapSource = 'manual'; });
    map.on('moveend', () => {
      if (mapSource === 'overview') return;
      const center = map.getCenter();
      el.mapCenterLat.value = center.lat.toFixed(6);
      el.mapCenterLon.value = center.lng.toFixed(6);
      el.mapZoom.value = map.getZoom();
    });
    setFollow(true);
    // 缩放控件深色化
    setTimeout(() => {
      document.querySelectorAll('.leaflet-control-zoom a').forEach((a) => {
        a.style.background = '#16223c';
        a.style.color = '#dbe4f5';
        a.style.borderColor = '#22304f';
      });
    }, 100);
  }

  function droneMarkerHtml(d, cls) {
    const hdg = d.position?.heading ?? 0;
    return `
      <div class="drone-marker ${cls} ${d.droneId === state.selected ? 'selected' : ''}" style="color:${colorOf(cls)}">
        <span class="nose" style="transform:rotate(${hdg}deg)"></span>
        <span class="ring"><span class="dot"></span></span>
        <span class="lbl">${d.droneId}${(d.position?.relAlt ?? d.position?.alt) != null ? ' ' + (d.position.relAlt ?? d.position.alt).toFixed(0) + 'm' : ''}</span>
      </div>`;
  }

  function colorOf(cls) {
    return cls === 'flying' ? '#fbbf24' : cls === 'online' ? '#34d399' : cls === 'stale' ? '#f97316' : '#64748b';
  }

  function renderMap() {
    if (!map) return;
    const selected = state.drones.get(state.selected);
    const viewLabel = ({ overview: '世界概览', computer: '地图中心：电脑位置', manual: '手动浏览', vehicle: '地图中心：飞控位置' })[mapSource];
    $('map-position-status').textContent = `${viewLabel} · ${selected ? selected.droneId + '：' : ''}${positionLabel(selected)}`;
    const dpr = window.devicePixelRatio || 1;
    for (const d of state.drones.values()) {
      const cls = droneClass(d);
      let m = markers.get(d.droneId);
      if (!currentPosition(d)) {
        if (m) { map.removeLayer(m); markers.delete(d.droneId); }
        continue;
      }
      const ll = [d.position.lat, d.position.lon];
      if (!m) {
        const icon = L.divIcon({
          className: '', html: droneMarkerHtml(d, cls), iconSize: [34, 34], iconAnchor: [17, 17],
        });
        m = L.marker(ll, { icon });
        m.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          state.selected = d.droneId;
          renderAll();
        });
        m.addTo(map);
        markers.set(d.droneId, m);
      } else {
        m.setLatLng(ll);
        m.setIcon(L.divIcon({ className: '', html: droneMarkerHtml(d, cls), iconSize: [34, 34], iconAnchor: [17, 17] }));
      }
      if (followMode && d.droneId === state.selected) {
        mapSource = 'vehicle';
        if (!centeredOnDrone) {
          map.setView(ll, 16);
          centeredOnDrone = true;
        } else map.panTo(ll, { animate: false });
      }
    }
    // 移除已消失的标记
    for (const id of [...markers.keys()]) {
      if (!state.drones.has(id) || !currentPosition(state.drones.get(id))) {
        map.removeLayer(markers.get(id));
        markers.delete(id);
      }
    }
    // 轨迹线
    for (const [id, d] of state.drones) {
      const h = history.get(id);
      if (!currentPosition(d) || !h || h.length < 2) continue;
      const pts = h.filter((s) => s.lat !== null && s.lon !== null).map((s) => [s.lat, s.lon]);
      if (pts.length < 2) continue;
      let tr = trails.get(id);
      if (!tr) {
        tr = L.polyline(pts, {
          color: colorOf(droneClass(d)),
          weight: 2, opacity: .55, dashArray: '4 6',
        });
        tr.addTo(map);
        trails.set(id, tr);
      } else {
        tr.setLatLngs(pts);
        tr.setStyle({ color: colorOf(droneClass(d)) });
      }
    }
    for (const id of [...trails.keys()]) {
      if (!state.drones.has(id) || !currentPosition(state.drones.get(id))) {
        map.removeLayer(trails.get(id));
        trails.delete(id);
      }
    }
  }

  // ————— 遥测曲线 —————
  let chartMetric = 'alt';
  function renderChart() {
    const cv = el.chartCanvas;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (W === 0 || H === 0) return;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const id = state.selected;
    el.chartDrone.textContent = id || '-';
    if (!id) return;
    const h = history.get(id);
    if (!h || h.length < 2) {
      ctx.fillStyle = '#64748b'; ctx.font = '12px sans-serif';
      ctx.fillText('等待遥测数据…', 16, H / 2);
      return;
    }
    const key = chartMetric;
    const values = h.map((s) => s[key]).filter((v) => v !== null && v !== undefined);
    if (values.length < 2) return;

    const max = Math.max(...values) * 1.15;
    const min = Math.min(...values) * 0.85;
    const range = (max - min) || 1;
    ctx.strokeStyle = '#22304f'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = H - (i / 4) * H;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillStyle = '#64748b'; ctx.font = '10px sans-serif';
      ctx.fillText((min + (i / 4) * range).toFixed(1), 4, y - 3);
    }
    ctx.strokeStyle = chartMetric === 'batt' ? '#34d399' : chartMetric === 'speed' ? '#a78bfa' : chartMetric === 'hdg' ? '#fbbf24' : '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const x = (i / (values.length - 1)) * W;
      const y = H - ((values[i] - min) / range) * H;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // ————— 事件流 —————
  function addEvent(cls, text) {
    state.events.push({ cls, text, t: new Date() });
    if (state.events.length > 200) state.events.shift();
    const line = document.createElement('div');
    line.className = `event-line ${cls}`;
    line.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span><span class="tag">[${cls}]</span>${text}`;
    el.eventList.appendChild(line);
    el.eventList.scrollTop = el.eventList.scrollHeight;
  }

  // ————— 工具 —————
  function toast(msg, isErr = false) {
    el.toast.textContent = msg;
    el.toast.className = `toast ${isErr ? 'err' : ''}`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.toast.className = 'toast hidden'; }, 2600);
  }

  // ————— 环境信息 —————
  function loadEnvironment() {
    API('/sim/environment').then((env) => {
      const w = env.wind;
      if (w) {
        const dirName = windDirName(w.dir);
        $('env-badge').innerHTML = `风 <b>${w.speed}m/s</b> ${dirName}(${w.dir}°) · 队形 <b>${env.formation?.type || 'free'}</b> · 原点 ${env.origin.lat.toFixed(4)},${env.origin.lon.toFixed(4)}`;
      }
    }).catch(() => {});
  }

  function windDirName(deg) {
    const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    return names[Math.round(deg / 45) % 8];
  }

  // ————— 初始化 —————
  function init() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.onclick = () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        chartMetric = tab.dataset.metric;
        renderChart();
      };
    });

    $('btn-add-drone').onclick = () => openAddDroneChoice();
    $('btn-clear-events').onclick = () => { el.eventList.innerHTML = ''; state.events = []; };
    $('btn-token').onclick = () => {
      const t = prompt('设置 API Token(留空恢复默认 dsh-demo-token):', API_TOKEN);
      if (t !== null) { localStorage.setItem('drone_api_token', t || 'dsh-demo-token'); location.reload(); }
    };
    $('btn-map-goto').onclick = () => {
      const lon = parseFloat(el.mapCenterLon.value), lat = parseFloat(el.mapCenterLat.value);
      if (!validMapCoordinates(lat, lon)) return toast('请输入有效经纬度：纬度 -90～90，经度 -180～180', true);
      MAP.originLon = lon;
      MAP.originLat = lat;
      MAP.zoom = Math.min(19, Math.max(2, parseInt(el.mapZoom.value) || 15));
      setFollow(false);
      mapSource = 'manual';
      if (map) map.setView([MAP.originLat, MAP.originLon], MAP.zoom);
    };
    $('btn-map-follow').onclick = () => {
      setFollow(!followMode);
      centeredOnDrone = false;
      renderMap();
      toast(followMode ? '已开启跟随，有效定位后自动移到飞控' : '已关闭跟随');
    };
    $('btn-map-me').onclick = () => {
      if (!navigator.geolocation) return toast('浏览器不支持定位，请手动输入经纬度', true);
      const button = $('btn-map-me');
      button.disabled = true;
      button.textContent = '正在定位…';
      const reset = () => { button.disabled = false; button.textContent = '定位我的电脑'; };
      navigator.geolocation.getCurrentPosition(({ coords }) => {
        reset();
        if (!validMapCoordinates(coords.latitude, coords.longitude)) return toast('浏览器未返回有效坐标', true);
        setFollow(false);
        mapSource = 'computer';
        const ll = [coords.latitude, coords.longitude];
        if (computerMarker) map.removeLayer(computerMarker);
        if (computerAccuracy) map.removeLayer(computerAccuracy);
        computerMarker = L.circleMarker(ll, { radius: 7, color: '#60a5fa', fillOpacity: 1 })
          .bindTooltip('电脑位置（浏览器定位）').addTo(map);
        if (Number.isFinite(coords.accuracy) && coords.accuracy > 0) {
          computerAccuracy = L.circle(ll, { radius: coords.accuracy, color: '#60a5fa', weight: 1, fillOpacity: 0.08 }).addTo(map);
        }
        map.setView(ll, 15);
        renderMap();
        toast('已定位电脑。无人机标记仍以飞控坐标为准。');
      }, (error) => {
        reset();
        toast(error.code === 1 ? '定位权限未开启，可允许浏览器定位或手动输入经纬度' : '电脑定位暂不可用，请手动输入经纬度', true);
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    };
    $('btn-formation').onclick = async () => {
      const type = $('sel-formation').value;
      try {
        const r = await API('/sim/formation', { method: 'POST', body: JSON.stringify({ type, spacing: 20 }), headers: { 'content-type': 'application/json' } });
        toast(`编队: ${r.ok ? (r.formation?.type + ' 领机 ' + r.leader) : (r.reason || '失败')}`, !r.ok);
        addEvent(r.ok ? 'command' : 'warn', `编队切换 ${type}: ${r.ok ? '成功' : r.reason}`);
        loadEnvironment();
      } catch (e) {
        toast(e.message, true);
      }
    };

    // 初始化实时地图
    initMap();
    setTimeout(() => { if (map) map.invalidateSize(); }, 300);

    // 业务模块:视图切换 + 面板绑定 + 数据加载
    initViews();
    bindBizButtons();
    loadBiz();
    window.addEventListener('management-changed',loadManagedMap);
    setInterval(loadManagedMap,15000);
    setInterval(()=>API('/drones').then(data=>{replaceSnapshot(state,history,data,upsertDrone);renderAll();}).catch(()=>{state.drones.clear();state.arp.clear();history.clear();renderAll();}),15000);
    window.addEventListener('resize',()=>{if(map)setTimeout(()=>map.invalidateSize(),50);});
    $('sel-formation').hidden=true;$('btn-formation').hidden=true;
    if(window.platformUser?.orgId!=='hq')$('btn-add-drone').hidden=true;

    // 环境信息
    loadEnvironment();
    setInterval(loadEnvironment, 10000);

    // 初始拉取 + WS
    API('/drones').then((data) => {
        replaceSnapshot(state, history, data, upsertDrone);
      // 若无选中,默认选第一架在线无人机,使实时遥测曲线立即可见
      if (!state.selected) {
        const first = [...state.drones.values()].sort((x, y) => x.droneId.localeCompare(y.droneId))[0];
        if (first) state.selected = first.droneId;
      }
      renderAll();
      addEvent('system', `已加载 ${state.drones.size} 架无人机`);
      populateArpDroneSelect();
    }).catch((e) => addEvent('warn', `REST 加载失败: ${e.message}`));

    connectWs();
    setInterval(renderAll, 1000); // 低频兜底刷新
    setInterval(loadBizSilent, 3000); // 定时刷新业务列表(任务进度等)
  }

  // ————— 通用弹窗 —————
  function openModal(html) {
    el.modalRoot.innerHTML = `<div class="biz-modal-mask"><div class="biz-modal">${html}</div></div>`;
    el.modalRoot.querySelector('.biz-modal-mask').onclick = (e) => {
      if (e.target === e.currentTarget) window.__closeModal();
    };
  }
  window.__closeModal = () => { el.modalRoot.innerHTML = ''; };

  // ————— 接入无人机:选择模拟机 or 真实 —————
  function openAddDroneChoice() {
    openModal(`
      <h3>接入无人机</h3>
      <p style="color:var(--muted);font-size:12px;margin-bottom:12px">选择接入类型:</p>
      <div class="choice-list">
        <div class="choice-item" id="ch-sim">
          <div class="ci-icon">🛸</div>
          <div><b>接入模拟无人机</b><small>即时生成一架虚拟无人机,无需硬件</small></div>
        </div>
        <div class="choice-item" id="ch-real">
          <div class="ci-icon">📡</div>
          <div><b>接入真实无人机</b><small>通过 MAVLink UDP 14550 连接飞控</small></div>
        </div>
      </div>
      <div class="modal-actions"><button class="btn" onclick="window.__closeModal()">取消</button></div>`);
    $('ch-sim').onclick = async () => {
      window.__closeModal();
      try {
        const r = await API('/sim/add', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
        toast(`已接入模拟机: ${r.droneId}`);
      } catch (e) { toast(e.message, true); }
    };
    $('ch-real').onclick = () => {
      window.__closeModal();
      openRealDroneGuide();
    };
  }

  function openRealDroneGuide() {
    API('/system/udp').then((info) => {
      const host = info.host || location.hostname;
      const listening = info.listening;
      openModal(`
        <h3>接入真实无人机</h3>
        ${listening
          ? `<p style="color:var(--online);font-size:12px;margin-bottom:10px">✓ MAVLink UDP ${info.port} 正在监听,可接入真实飞控。</p>`
          : `<p style="color:var(--danger);font-size:12px;margin-bottom:10px">✗ MAVLink UDP ${info.port} 未监听。请用以下命令重启服务:<br><code style="font-size:11px">node server/src/index.js --sim N --udp 14550</code></p>`}
        <div class="guide">
          <b>配置飞控遥测输出指向平台:</b>
          <ol>
            <li>用 QGroundControl / Mission Planner 连接飞控</li>
            <li>配置一个 <b>UDP 遥测输出</b>,目标为:</li>
            <li><code>IP: <b>${host}</b> &nbsp; 端口: <b>${info.port || 14550}</b></code></li>
            <li>飞控上电后,平台会自动发现并注册(ARP 学习)</li>
            <li>若飞控 sysid 与模拟机冲突,真实机会以 <code>real-N</code> 命名区分</li>
          </ol>
        </div>
        <div class="modal-actions"><button class="btn" onclick="window.__closeModal()">完成</button></div>`);
    }).catch(() => {
      openModal(`<h3>接入真实无人机</h3><p style="color:var(--muted)">请参考 README「接入真实无人机」章节。</p><div class="modal-actions"><button class="btn" onclick="window.__closeModal()">关闭</button></div>`);
    });
  }

  // ————— 视图切换 —————
  function initViews() {
    document.querySelectorAll('.mainnav .nav-btn').forEach((btn) => {
      btn.onclick = () => switchView(btn.dataset.view);
    });
    switchView('run');
  }
  function switchView(view) {
    currentView = view;
    document.querySelectorAll('.mainnav .nav-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === view);
    });
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const idMap = { run: 'wrap-run', aop: 'view-aop', mission: 'view-mission', audit: 'view-audit' };
    const target = document.getElementById(idMap[view]);
    if (target) target.classList.add('active');
    if (map) setTimeout(() => map.invalidateSize(), 50);
    // 进入业务视图时刷新对应数据
    if (view === 'aop' || view === 'mission' || view === 'audit') loadBiz();
  }

  // ————— 业务数据加载 —————
  function loadBizSilent() {
    // 静默刷新(不打断用户操作)
    if (currentView === 'mission' || currentView === 'audit' || currentView === 'aop') {
      loadBiz().catch(() => {});
    }
  }
  async function loadBiz() {
    if(window.platformUser)return loadManagedMap();
    try {
      const air = await API('/airspace');
      biz.airspace = air;
      renderAirspace();
      renderMapOverlays();
      const ms = await API('/missions');
      biz.missions = ms.missions;
      renderMissions();
      const au = await API('/audit?limit=80');
      biz.audit = au.audit;
      renderAudit();
      populateArpDroneSelect();
    } catch (e) {
      /* 忽略 */
    }
  }


  let managedLayer=null;
  async function loadManagedMap(){
    if(!map)return;
    try{
      const [assets,fences]=await Promise.all([API('/v2/assets'),API('/v2/fences')]);
      if(managedLayer)map.removeLayer(managedLayer);
      managedLayer=L.layerGroup().addTo(map);
      for(const asset of assets){
        if(asset.kind!=='自动机场'||asset.lat==null||asset.lon==null||!validMapCoordinates(asset.lat,asset.lon))continue;
        const label=document.createElement('span');label.textContent=asset.name+' · '+asset.status+' · 实时状态待机场接口';
        L.marker([asset.lat,asset.lon],{icon:L.divIcon({className:'dock-marker',html:'机场',iconSize:[38,25]})}).bindTooltip(label).addTo(managedLayer);
      }
      for(const fence of fences.filter(f=>f.enabled!==false)){
        const label=document.createElement('span');label.textContent=fence.name+' · '+fence.kind+(fence.kind==='限飞区'?' '+fence.ceiling+'m':'');
        L.geoJSON(fence.geometry,{style:{color:fence.kind==='禁飞区'?'#f87171':'#fbbf24',weight:2,fillOpacity:.12}}).bindTooltip(label).addTo(managedLayer);
      }
    }catch{/* Keep the live telemetry map usable if business data is unavailable. */}
  }

  function populateArpDroneSelect() {
    const sel = $('arp-drone');
    if (!sel) return;
    const cur = sel.value;
    const ids = [...state.drones.values()]
      .filter((d) => d.online)
      .sort((a, b) => a.droneId.localeCompare(b.droneId))
      .map((d) => d.droneId);
    sel.innerHTML = ids.map((id) => `<option value="${id}">${id}</option>`).join('') || '<option value="">(无在线无人机)</option>';
    if (cur && ids.includes(cur)) sel.value = cur;
  }

  // ————— 空域(AOP)渲染 —————
  function statusBadge(cls, txt) {
    return `<span class="tag ${cls}">${txt}</span>`;
  }
  function renderAirspace() {
    const ac = $('aop-list');
    if (ac) {
      if (!biz.airspace.corridors.length) { ac.innerHTML = '<div class="empty-hint">暂无走廊</div>'; }
      else {
        ac.innerHTML = biz.airspace.corridors.map((c) => `
          <div class="corridor-row">
            <div class="info">
              <b><span class="swatch" style="background:${c.color}"></span>${c.id} ${c.name}</b>
              <small>上限 ${c.ceiling}m · ${c.path.length} 航点 · ${c.status}</small>
            </div>
            <div class="row-actions">
              <button class="btn small" data-del="${c.id}">删除</button>
            </div>
          </div>`).join('');
        ac.querySelectorAll('[data-del]').forEach((b) => {
          b.onclick = async () => {
            try {
              await API(`/airspace/corridors/${b.dataset.del}`, { method: 'DELETE' });
              toast('走廊已删除'); loadBiz();
            } catch (e) { toast(e.message, true); }
          };
        });
      }
    }
    const rs = $('restricted-list');
    if (rs) {
      if (!biz.airspace.restricted.length) { rs.innerHTML = '<div class="empty-hint">无限制区</div>'; }
      else {
        rs.innerHTML = biz.airspace.restricted.map((r) => `
          <div class="rs-row">
            <div class="info">
              <b>${r.id} ${r.name}</b>
              <small>${r.lat.toFixed(5)}, ${r.lon.toFixed(5)} · 半径 ${r.radius}m ${r.reason ? '· ' + r.reason : ''}</small>
            </div>
            <div class="row-actions">
              <button class="btn small" data-toggle="${r.id}">${r.active ? '停用' : '启用'}</button>
              <button class="btn small" data-del="${r.id}">删除</button>
            </div>
          </div>`).join('');
        rs.querySelectorAll('[data-del]').forEach((b) => {
          b.onclick = async () => {
            try { await API(`/airspace/restricted/${b.dataset.del}`, { method: 'DELETE' }); toast('已删除'); loadBiz(); }
            catch (e) { toast(e.message, true); }
          };
        });
        rs.querySelectorAll('[data-toggle]').forEach((b) => {
          b.onclick = async () => {
            try { await API(`/airspace/restricted/${b.dataset.toggle}`, { method: 'POST' }); loadBiz(); }
            catch (e) { toast(e.message, true); }
          };
        });
      }
    }
  }

  // ————— 地图叠加层(AOP 走廊 / 禁飞区)—————
  function renderMapOverlays() {
    if (!map) return;
    if (corridorLayer) { map.removeLayer(corridorLayer); corridorLayer = null; }
    if (restrictedLayer) { map.removeLayer(restrictedLayer); restrictedLayer = null; }
    if (!biz.airspace || !biz.airspace.corridors) return;
    const corr = L.layerGroup();
    biz.airspace.corridors.forEach((c) => {
      const pts = (c.path || []).filter((p) => p.lat && p.lon).map((p) => [p.lat, p.lon]);
      if (pts.length >= 2) {
        L.polyline(pts, { color: c.color, weight: 3, opacity: 0.9, dashArray: '8 6' }).addTo(corr);
        L.polygon(pts, { color: c.color, weight: 1, opacity: 0.3, fillOpacity: 0.06, interactive: false }).addTo(corr);
      }
      if (pts[0]) L.marker(pts[0], {
        icon: L.divIcon({ className: 'corridor-label', html: `<b style="color:${c.color}">${c.id}</b>` }),
        interactive: false,
      }).addTo(corr);
    });
    corr.addTo(map);
    corridorLayer = corr;
    const rsLayer = L.layerGroup();
    biz.airspace.restricted.filter((r) => r.active).forEach((r) => {
      L.circle([r.lat, r.lon], { radius: r.radius, color: '#f87171', weight: 2, dashArray: '5 5', fillColor: '#f87171', fillOpacity: 0.15 }).addTo(rsLayer);
      L.marker([r.lat, r.lon], {
        icon: L.divIcon({ className: 'restricted-label', html: `<b style="color:#f87171">⛔ ${r.name}</b>` }),
        interactive: false,
      }).addTo(rsLayer);
    });
    rsLayer.addTo(map);
    restrictedLayer = rsLayer;
  }

  // ————— 任务渲染 —————
  function missionBadge(status) {
    const m = { '规划中': 'badge-gray', '执行中': 'badge-blue', '完成': 'badge-green', '失败': 'badge-red' };
    return statusBadge(m[status] || 'badge-gray', status);
  }
  function renderMissions() {
    const box = $('mission-list');
    if (!box) return;
    if (!biz.missions.length) { box.innerHTML = '<div class="empty-hint">暂无任务,点击右上角新建</div>'; return; }
    box.innerHTML = biz.missions.map((m) => `
      <div class="mission-row">
        <div class="info">
          <b>${m.id} ${m.name}</b> ${missionBadge(m.status)}
          <small>${m.droneId} · 优先级 ${m.priority} · 进度 ${m.progress || 0}%${m.route ? ' · 已绑定ARP航路' : ''}</small>
        </div>
        <div class="row-actions">
          ${m.status === '规划中' ? `<button class="btn small primary" data-start="${m.id}">启动</button>` : ''}
          ${m.status === '执行中' ? `<button class="btn small" data-advance="${m.id}">+进度</button><button class="btn small" data-plan="${m.id}">ARP</button>` : ''}
          <button class="btn small" data-del="${m.id}" title="删除">🗑</button>
        </div>
      </div>`).join('');
    box.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        try { await API(`/missions/${b.dataset.del}`, { method: 'DELETE' }); toast('任务已删除'); loadBiz(); }
        catch (e) { toast(e.message, true); }
      };
    });
    box.querySelectorAll('[data-start]').forEach((b) => {
      b.onclick = async () => {
        try { await API(`/missions/${b.dataset.start}/start`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }); toast('任务已启动'); loadBiz(); }
        catch (e) { toast(e.message, true); }
      };
    });
    box.querySelectorAll('[data-advance]').forEach((b) => {
      b.onclick = async () => {
        try { await API(`/missions/${b.dataset.advance}/advance`, { method: 'POST', body: '{"delta":15}', headers: { 'content-type': 'application/json' } }); loadBiz(); }
        catch (e) { toast(e.message, true); }
      };
    });
    box.querySelectorAll('[data-plan]').forEach((b) => {
      b.onclick = async () => {
        const m = biz.missions.find((x) => x.id === b.dataset.plan);
        if (!m) return;
        try {
          const r = await API('/routes/plan', { method: 'POST', body: JSON.stringify({ droneId: m.droneId }), headers: { 'content-type': 'application/json' } });
          if (r.ok) {
            await API(`/missions/${m.id}/start`, { method: 'POST', body: JSON.stringify({ route: r.route }), headers: { 'content-type': 'application/json' } });
            toast('已生成航路并启动任务'); switchView('mission'); loadBiz();
          } else toast(r.error, true);
        } catch (e) { toast(e.message, true); }
      };
    });
  }

  // ————— 审计渲染 —————
  function renderAudit() {
    const box = $('audit-list');
    if (!box) return;
    if ($('audit-count')) $('audit-count').textContent = `共 ${biz.audit.length} 条`;
    if (!biz.audit.length) { box.innerHTML = '<div class="empty-hint">暂无审计记录</div>'; return; }
    box.innerHTML = biz.audit.map((a) => `
      <div class="audit-row">
        <div class="info">[${a.action}] ${Object.entries(a).filter(([k]) => !['id', 'at', 'action'].includes(k)).map(([k, v]) => `${k}=${v}`).join(' ') || ''}</div>
        <span class="time">${new Date(a.at).toLocaleString('zh-CN', { hour12: false })}</span>
      </div>`).join('');
  }

  // ————— 业务按钮绑定 —————
  function bindBizButtons() {
    // AOP 新增走廊
    $('btn-aop-add') && ($('btn-aop-add').onclick = () => {
      openModal(`
        <h3>新增 AOP 走廊</h3>
        <label>名称<input id="c-name" placeholder="如:北区巡检走廊"></label>
        <label>上限高度(m,20-1000)<input id="c-ceil" type="number" value="120"></label>
        <label>颜色<input id="c-color" type="color" value="#38bdf8"></label>
        <div class="modal-actions"><button class="btn" onclick="window.__closeModal()">取消</button><button class="btn primary" id="c-ok">创建</button></div>`);
      $('c-ok').onclick = async () => {
        const name = $('c-name').value;
        try {
          await API('/airspace/corridors', { method: 'POST', body: JSON.stringify({ name, ceiling: $('c-ceil').value, color: $('c-color').value }), headers: { 'content-type': 'application/json' } });
          window.__closeModal(); toast('走廊已创建'); loadBiz(); switchView('aop');
        } catch (e) { toast(e.message, true); }
      };
    });
    // 限制区新增
    $('btn-rs-add') && ($('btn-rs-add').onclick = () => {
      openModal(`
        <h3>新增限制区</h3>
        <label>名称<input id="r-name" placeholder="如:临时禁飞区"></label>
        <label>半径(m)<input id="r-radius" type="number" value="150"></label>
        <label>原因<input id="r-reason" placeholder="如:施工吊装"></label>
        <div class="modal-actions"><button class="btn" onclick="window.__closeModal()">取消</button><button class="btn primary" id="r-ok">创建</button></div>`);
      $('r-ok').onclick = async () => {
        try {
          await API('/airspace/restricted', { method: 'POST', body: JSON.stringify({ name: $('r-name').value, radius: $('r-radius').value, reason: $('r-reason').value }), headers: { 'content-type': 'application/json' } });
          window.__closeModal(); toast('限制区已创建'); loadBiz(); switchView('aop');
        } catch (e) { toast(e.message, true); }
      };
    });
    // ARP 规划
    $('btn-plan-route') && ($('btn-plan-route').onclick = async () => {
      const droneId = $('arp-drone')?.value;
      if (!droneId) return toast('请选择无人机', true);
      try {
        const r = await API('/routes/plan', { method: 'POST', body: JSON.stringify({ droneId }), headers: { 'content-type': 'application/json' } });
        if (!r.ok) return toast(r.error, true);
        const rt = r.route;
        $('route-result').innerHTML = `
          <b>${rt.id}</b> · 无人机 ${rt.droneId}<br>
          推荐走廊: <b>${rt.corridorName || rt.recommendedAop}</b><br>
          高度层: <b>${rt.altitude}m</b> · 时隙: <b>${rt.slot}</b><br>
          风险: <b style="color:${rt.risk.startsWith('低') ? 'var(--online)' : 'var(--danger)'}">${rt.risk}</b><br>
          航路点(${rt.waypoints.length}):<br>
          ${rt.waypoints.map((w, i) => `${i + 1}. ${w.lat.toFixed(5)}, ${w.lon.toFixed(5)} @${w.alt}m`).join('<br>')}`;
        toast(`ARP 计划已生成: ${rt.id}`);
        addEvent('command', `ARP 计划 ${rt.id} 为 ${droneId} 生成`);
      } catch (e) { toast(e.message, true); }
    });
    // 新建任务
    $('btn-mission-add') && ($('btn-mission-add').onclick = () => {
      const opts = [...state.drones.values()].filter((d) => d.online).sort((a, b) => a.droneId.localeCompare(b.droneId)).map((d) => `<option value="${d.droneId}">${d.droneId}</option>`).join('');
      openModal(`
        <h3>新建任务</h3>
        <label>任务名称<input id="m-name" placeholder="如:西区巡查"></label>
        <label>执行无人机<select id="m-drone">${opts || '<option value="">(无在线无人机)</option>'}</select></label>
        <label>优先级<select id="m-pri"><option>中</option><option>高</option><option>低</option></select></label>
        <div class="modal-actions"><button class="btn" onclick="window.__closeModal()">取消</button><button class="btn primary" id="m-ok">创建</button></div>`);
      $('m-ok').onclick = async () => {
        try {
          await API('/missions', { method: 'POST', body: JSON.stringify({ name: $('m-name').value, droneId: $('m-drone').value, priority: $('m-pri').value }), headers: { 'content-type': 'application/json' } });
          window.__closeModal(); toast('任务已创建'); loadBiz(); switchView('mission');
        } catch (e) { toast(e.message, true); }
      };
    });
    // 清空审计
    $('btn-audit-clear') && ($('btn-audit-clear').onclick = async () => {
      try {
        await API('/audit', { method: 'DELETE' });
        toast('审计已清空'); loadBiz();
      } catch (e) { toast(e.message, true); }
    });
  }

  window.addEventListener('platform-authenticated', init, {once:true});
})();
