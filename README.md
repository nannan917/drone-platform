# 深圳总站无人机应用管理平台

本地业务版本：组织与账号、设备台账、两级审批、航线围栏、资料归档、飞手档案、事件处置、匿名客车流汇总、喊话模板及机场巡控预案。外部服务未提供接口，页面明确标记待接入。

## 启动

```powershell
cd C:\Users\NAN\drone-platform
npm start
```

或双击 `start.bat`。默认 HTTP 4000 / MAVLink UDP 14550 / 模拟器 0 架。浏览器访问 http://127.0.0.1:4000/ 。首次启动随机生成管理员密码，保存在 `server/data/bootstrap-admin.txt`；用户名 `admin`，登录后可修改密码。

QGC MAVLink Forwarding 使用 `127.0.0.1:14550`。当前真实链路按单向遥测处理，API 和 WebSocket 不下发真实飞行指令。台账中通过 `droneId`（例如 real-1）关联设备与飞控，序列号填写实物信息。没有有效飞控坐标时不显示无人机位置；机场位置由资产登记提供。

## 模块

- `server/src/management.js`：本地账号、单位范围、授权、审批、业务校验与 JSON 持久化。
- `server/src/management-http.js`：认证、CRUD、流程动作、文件传输及请求限制。
- `server/src/planning.js`：航点、矩形扫描、环绕航线；单环 GeoJSON Polygon 围栏校验。
- `server/public/management-ui.js`、`management.css`：中文业务工作台。
- `server/src/api.js`：统一保护 REST 与 WebSocket；旧 API 保留但须授权。

新数据存在 `server/data/management.json`，旧 `operations.json` 保留；旧演示空域与任务未迁移成正式业务。站级用户可查看本单位数据及获准共享设备，总站查看全局。共享仅允许查看，不能修改或归档外单位资产。总站围栏是共同限制，站级围栏只参与本单位设计校验。归档与更新保留审计；当前采用本地文件，不是防篡改集中存储。

## 操作流程

创建检查站与账号 → 登记设备、飞手及航线 → 飞手创建提交计划 → 同单位审批 → 总站审批 → 登记执行 → 登记完成并归档。提交人不能自审，开始执行前会再次校验围栏。执行登记不触发飞行；遥测记录的是解锁时段，不是精确在空时长。人工评级须填写依据。

支持 PDF/PNG/JPG/TXT/MP4 上传及下载，单文件 10MB；OCR 待接入。视频仅播放浏览器支持的地址或已归档文件。匿名人数、车辆汇总超过设定阈值会生成本地处置事件。喊话支持本机试听，巡控支持保存预案，均不会向外部设备执行。

## 验证

```powershell
npm test
```

测试使用临时数据目录及随机 HTTP 端口，不向实际飞控发指令。环境变量 `DRONE_DATA_DIR` 可调整数据目录；`DRONE_VERBOSE_TELEMETRY=1` 可打开高频协议日志，默认关闭。服务重启后内存会话失效，需要重新登录。

内置模拟环境只用于显式 `npm run sim` 或 `--sim N`，不代表真实设备、气象或真实任务。QGC 连接下的实际飞行操作应在 QGC 中完成。视频厂商协议、云台、天气、OCR、匿名计数、火情检测、通知和机场控制仍待接入；人员身份比对及自动跟踪未实现，保留人工核验记录。
