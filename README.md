# 🛸 无人机集群管理平台

一个可接纳多架无人机的集群管理平台:后端(Node.js)以 **AOP** 架构组织横切关注点、以 **ARP 表驱动寻址**管理无人机注册与发现,通过 **MAVLink** 协议接入无人机(真实飞控或内置模拟器),前端网页提供集群总览、地图、实时遥测与指令下发。

## 功能特性

| 模块 | 说明 |
|------|------|
| 多机接入 | 内置模拟器(默认 3 架,可任意扩容),或通过 UDP 接入真实飞控(MAVLink) |
| ARP 注册表 | 无人机逻辑 ID ↔ 通信端点映射;学习/解析/探测/老化/离线,TTL 超时自动剔除 |
| AOP 架构 | 日志、鉴权、遥测采集作为横切切面织入业务方法(before/after/around) |
| MAVLink 网关 | v1/v2 帧编解码,HEARTBEAT/SYS_STATUS/GPS/ATTITUDE/BATTERY/GLOBAL_POSITION 解析,COMMAND_LONG 指令下发 |
| 实时推送 | WebSocket 推送状态/上线/指令事件,前端实时渲染 |
| 前端界面 | 集群统计、地图(墨卡托投影)、无人机列表、选中详情、遥测曲线、事件流 |
| 指令控制 | 解锁/上锁/起飞/降落/返航/飞往指定经纬度 |
| 空域 AOP(运营) | 低空走廊(名称/上限高度/路径/颜色)与限制区·禁飞区管理,地图叠加层可视化,JSON 持久化 |
| 航路 ARP(规划) | 为指定无人机生成推荐走廊/高度层/时隙/风险评级/真实经纬度航路点 |
| 任务编排 | 创建任务、指派无人机、状态流转(规划中→执行中→完成/失败)、进度推进,可绑定 ARP 航路 |
| 操作审计 | 记录近 300 条操作(命令/ARP/AOP/任务/遥测),`/api/audit` 查询 |

## 快速开始

```bash
cd C:\Users\NAN\drone-platform
npm install            # 安装依赖(ws)
npm start              # 启动(默认 5 架模拟无人机,端口 4000)
```

打开浏览器访问 **http://127.0.0.1:4000**

> 默认集群原点:中科院深圳先进技术研究院(SIAT) 22.5935°N, 113.9645°E

## 业务运营模块(AOP 空域 / ARP 航路 / 任务 / 审计)

- **本平台技术层**:AOP = 面向切面编程架构、ARP = 表驱动寻址注册表(见下文架构)
- **融合业务层(Codex 概念)**:AOP = 空域运营计划、ARP = 航路与时隙规划

页面顶部导航提供四个视图:**运行**(原单页看板)、**空域·航路**、**任务**、**审计**;地图上以叠加层实时显示 AOP 走廊与禁飞区,与无人机真实位置同屏。数据存于 `server/data/operations.json`,重启保留。

### 启动参数

```bash
node server/src/index.js                  # 仅 API,等待真实飞控
node server/src/index.js --sim 5          # 5 架模拟无人机
node server/src/index.js --sim 0 --udp 14550   # 监听 UDP 14550 接真实飞控
node server/src/index.js --port 8080      # 改端口
node server/src/index.js --token mytoken  # 改 API Token
node server/src/index.js --origin 22.5935,113.9645  # 覆盖集群原点(经纬度)
```

## 接入真实无人机(完整操作)

平台通过 **MAVLink 协议**接入真实飞控(Pixhawk/ArduPilot/PX4 等),自动发现并注册。

### 方式一:UDP 接入(推荐,飞控与平台同一局域网)

1. **启动平台并监听 UDP 14550**:
   ```bash
   node server/src/index.js --sim 0 --udp 14550
   ```

2. **在飞控地面站配置遥测输出**:
   - 使用 QGroundControl / Mission Planner 连接飞控
   - 配置一个 **UDP 输出(遥测)** 指向平台的 IP 和端口 `14550`
   - 例如 ArduPilot:参数 `SR2_*` 或通过 GCS 的"MAVLink 转发"添加 `UDP:平台IP:14550`
   - PX4:QGC 里添加 UDP 遥测链接

3. **飞控上电后**,平台即收到 HEARTBEAT/GPS/姿态等消息,ARP 表自动注册,前端列表出现链路为 `udp` 的真实无人机。

### 方式二:串口/USB 直连(飞控用 USB 接平台所在电脑)

1. 把飞控通过 USB 连接到电脑,记下串口号(如 `COM5`,设备管理器查看)
2. 使用 UDP↔串口转发工具(如 `mavlink-router` / `mavproxy`):
   ```bash
   mavproxy.py --master=COM5 --out=udp:127.0.0.1:14550
   ```
3. 平台端:`node server/src/index.js --sim 0 --udp 14550`

### 方式三:与 SITL 仿真器对接(无硬件验证)

```bash
# ArduPilot SITL 或 PX4 SITL 起一架虚拟飞机,把 MAVLink 转发到平台
sim_vehicle.py -v ArduCopter --out=udp:127.0.0.1:14550
```

### 接入后的操作

- 无人机出现在列表后,点击选中 → 解锁(ARM)→ 起飞(TAKEOFF)→ 前往指定经纬度(GOTO)→ 降落/返航
- 指令以 `COMMAND_LONG` 经 UDP 回发给飞控(平台端也会打印 ARP 指令事件)
- 飞控的 HEARTBEAT 断流超过 15s,ARP 表自动标记 offline;30s 移除

### 说明

- 平台作为 **GCS 侧 system id=255**,与飞控的 sysid 不同即可,ARP 按飞控 sysid 区分多机
- 若飞控只发不接收指令,检查 UDP 回发端口是否与飞控遥测端口一致(平台按数据来源地址回发)

> 真实飞控接入:将 Pixhawk/ArduPilot 等飞控通过 UDP 遥测输出指向本机 14550 端口,平台即自动发现并注册该无人机(ARP 学习)。

## 架构设计

```
┌─────────────────────────── 前端 (server/public) ───────────────────────────┐
│  集群统计 │ 地图 │ 无人机列表 │ 详情+指令 │ 遥测曲线 │ 事件流                  │
└───────────────▲──────────────────────────┬─────────────────────────────────┘
                │ REST(JSON)                │ WebSocket(实时)
┌───────────────┴──────────────────────────▼─────────────────────────────────┐
│                            server/src/api.js                                │
│   HTTP 服务 · 静态资源 · /api/* · /ws 推送 · AOP 鉴权+日志切面               │
├─────────────────────────────────────────────────────────────────────────────┤
│                            server/src/gateway.js                            │
│   MAVLink 网关:receive() 拆帧 → 学习 ARP → 合并遥测 → 广播状态               │
│   command() 编码 COMMAND_LONG → 经传输层下发                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│   server/src/arp.js          server/src/mavlink.js      server/src/aop.js   │
│   ARP 表驱动寻址              MAVLink v1/v2 编解码       轻量 AOP 切面框架    │
├─────────────────────────────────────────────────────────────────────────────┤
│   server/src/simulator.js               UDP 传输 (index.js)                 │
│   内置多机模拟器(编码 MAVLink 帧)        真实飞控接入                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### AOP 横切设计

`server/src/aop.js` 实现轻量 AOP 框架:

- `Aop.aspect(pointcut, advice)` 注册切面,`before/after/around` 三种通知
- 通过 Proxy 织入:方法调用时自动执行 切面链 → 原方法 → 后置通知
- 本项目实际织入的切面:
  - `loggingAspect` — 全局方法调用日志(参数 + 耗时)
  - `authAspect` — REST 接口鉴权(`X-API-Token` 校验)
  - `telemetryCollectAspect`(内联实现)— 遥测采集:每次 `ingest` 后把解码帧写入采样存储,供 `/api/telemetry/:id` 查询

### ARP 表驱动寻址设计

`server/src/arp.js` 参考 ARP 协议思想:

| ARP 概念 | 平台对应 |
|----------|----------|
| 逻辑地址(IP) | `droneId`(如 uav-2) |
| 物理地址(MAC) | `mac`(如 `sim:2`)、sysid |
| ARP 请求/应答 | `probe()` 探测 + 心跳应答 |
| 被动学习 | 收到未知 sysid 的遥测 → `learn()` 自动登记 |
| 缓存老化 | `ttlMs` 到期 → stale → offline → 移除 |
| ARP 缓存表 | `Map<droneId, entry>`,含 `resolve()` 查询 |

状态机:`learning → resolved → stale → offline → (expire 移除)`,状态变化经 WebSocket 推送 `presence` 事件。

### 真实感模拟器(server/src/simulator.js)

内置模拟器按真实多旋翼动力学生成遥测:

| 要素 | 实现 |
|------|------|
| 运动学 | 速度向量 vx/vy/vz,受最大加速度(3.5m/s²)、最大速度(14-18m/s)、爬升率(3m/s)约束 |
| 风场 | 全局风向/风速(默认 3.5m/s 西南风)+ 湍流扰动,实时影响地速与航向 |
| 传感器噪声 | GPS 位置抖动(与 eph 相关)、姿态角噪声、高度噪声、卫星数波动 |
| 电池模型 | 悬停 0.6%/min、巡航 1.2%/min、爬升 2%/min 放电;电压随电量非线性;含电流/温度/剩余时间 |
| 编队 | 自由/三角/一字/环形四种队形,领机移动带动编队(前端工具栏或 API 切换) |
| 指令语义 | 未解锁拒绝起飞(自动补解锁)、GOTO 有加速度约束、降落需高度归零后上锁 |

### 编队 API

```bash
# 切换三角队形(间距 20m)
curl -X POST http://127.0.0.1:4000/api/sim/formation -H "X-API-Token: dsh-demo-token" -H "Content-Type: application/json" -d '{"type":"triangle","spacing":20}'
# 查看环境(风况/队形/原点)
curl http://127.0.0.1:4000/api/sim/environment -H "X-API-Token: dsh-demo-token"
```

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查(免鉴权) |
| GET | `/api/drones` | 全部无人机状态 + ARP 表 |
| GET | `/api/drones/:id` | 单机详情 |
| POST | `/api/drones/:id/command` | 下发任意指令 `{command, params}` |
| POST | `/api/drones/:id/arm` / `disarm` / `takeoff` / `land` / `rtl` | 快捷指令 |
| POST | `/api/drones/:id/goto` | 飞往 `{lat, lon}` |
| GET | `/api/telemetry/:id` | 最近 200 条遥测采样 |
| POST | `/api/sim/add` | 动态接入一架模拟无人机 |
| POST | `/api/sim/formation` | 切换编队 `{type: free\|triangle\|line\|circle, spacing}` |
| GET | `/api/sim/environment` | 风况/队形/原点信息 |
| GET | `/api/airspace` | 空域列表(走廊/限制区/版本/原点) |
| POST | `/api/airspace/corridors` | 新增 AOP 走廊 `{name, ceiling, color, path?}` |
| PUT/DELETE | `/api/airspace/corridors/:id` | 更新/删除走廊 |
| POST | `/api/airspace/restricted` | 新增限制区 `{name, radius, reason}` |
| POST/DELETE | `/api/airspace/restricted/:id` | 启停/删除限制区 |
| POST | `/api/routes/plan` | 生成 ARP 航路 `{droneId}` → 走廊/高度/时隙/风险/航路点 |
| GET/POST | `/api/missions` | 任务列表/创建 |
| POST | `/api/missions/:id/start\|advance\|fail` | 任务状态流转 |
| GET | `/api/audit?limit=N` | 操作审计记录 |

除 `/api/health` 外均需请求头 `X-API-Token`(默认 `dsh-demo-token`)。

## 目录结构

```
drone-platform/
├── package.json
├── server/
│   ├── src/
│   │   ├── index.js       # 入口:组装 API/网关/模拟器/UDP
│   │   ├── api.js         # REST + WebSocket + 静态资源
│   │   ├── gateway.js     # MAVLink 网关
│   │   ├── arp.js         # ARP 表驱动寻址注册表
│   │   ├── mavlink.js     # MAVLink v1/v2 编解码
│   │   ├── aop.js         # 轻量 AOP 框架
│   │   ├── simulator.js   # 多机模拟器
│   │   ├── operations.js  # 业务运营模块(AOP空域/ARP航路/任务/审计 + JSON持久化)
│   └── public/            # 前端
│       ├── index.html
│       ├── style.css
│       └── app.js
└── node_modules/
```

## 说明

- MAVLink CRC_EXTRA 收录常用消息子集;未收录消息以 `raw` 数组透传,不影响解析
- 模拟器每 800ms 上报一轮完整遥测;ARP stale 8s / offline 15s / TTL 30s
- 前端无需构建,纯原生 JS + Canvas
