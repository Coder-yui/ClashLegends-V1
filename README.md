# ClashLegends V1

第一阶段实现网页大厅、AI 备战与双人邀请房。最后一名真人准备时，Rust 服务在 PostgreSQL 事务中冻结双方配置，两个客户端进入同一比赛的开局确认页。内容快照包括经典模式、晴昼峡谷、100 张可选卡和 106 个技能选项。

## 独立 2D 内核

[内核结构与运行说明](docs/battle/README.md) · [交互矩阵](docs/battle/机制矩阵.md) · [旧版主动技能索引](docs/battle/旧版主动技能索引.md)。运行 `cargo run --locked --release -p clash-battle-core --example classic` 可让两个机器人使用手牌和主动技能打完一局。运行 `cargo run --locked -p clash-lobby --example battle_view` 后，多个浏览器可在[本地对局观察页](http://127.0.0.1:4318/)观看同一局。正式大厅仍停在开局确认页。代表性卡组、逐卡移植和正式宿主接入的边界见内核说明。

## 本地运行

使用 Rust、Node.js（本项目验证环境为 Node 26）、npm 和 PostgreSQL 16。从本目录执行。首次可通过 Docker 建立专用开发数据库：

```sh
docker run -d --name clashlegends-v1-lobby-db \
  -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=clash_lobby -e POSTGRES_PASSWORD=clash_local_dev \
  -e POSTGRES_DB=clash_lobby \
  -v clashlegends_v1_lobby_pgdata:/var/lib/postgresql/data postgres:16-alpine
```

这组凭据仅用于本机开发。如果已有上述容器，使用 `docker start clashlegends-v1-lobby-db`。已有独立数据库时直接指定自己的连接串。服务启动时创建大厅表。

```sh
npm --prefix web ci
npm --prefix web run build
export DATABASE_URL=postgresql://clash_lobby:clash_local_dev@127.0.0.1:55432/clash_lobby
cargo run --locked -p clash-lobby
```

打开 [本地大厅](http://127.0.0.1:4317/play/)。同一个浏览器的标签页共用游客身份。体验好友对战时，一方使用普通窗口，另一方使用无痕窗口或另一款浏览器，通过邀请码加入。测试手机局域网访问时，以 `LOBBY_ADDR=0.0.0.0:4317` 启动服务，在同一网络用电脑的局域网地址打开，数据库仍只绑定回环地址。

前端开发可额外运行 `npm --prefix web run dev`，Vite 将 API 和 WebSocket 代理至本机 Rust 服务。网站整合时，将同一域名的 `/play/`、`/api/` 指向大厅，并为 `/api/live` 转发 WebSocket 升级请求。

## 大厅交互与游戏设置

顶部的“设置”可以调整总音量、音效音量和预留的背景音量，修改后立即生效，可用“试听音效”确认。大厅使用 Web Audio 播放短交互音，背景音轨后续接入。默认对局键位为四张手牌 Q/W/E/R、两个主动槽技能 D/F，支持重新绑定、冲突提示和恢复默认。偏好保存在当前设备的浏览器中，同源标签页共享。战斗客户端后续可用 [preferences.ts](web/src/preferences.ts) 中的动作映射读取玩家键位。

大厅下拉选项、离房和删除确认都由网页绘制。站内离开未保存的备战编辑器时可以取消或明确放弃；直接刷新或使用浏览器前进、后退，会在当前标签页保留草稿。

## 代码入口

- [网页入口](web/src/main.tsx) 管理游客会话、页面与连接恢复。大厅、房间、编辑器和锁定结果使用独立页面组件。
- [内容目录](content/catalog.json) 是这一版公开卡牌、技能和地图的共同输入。[导入工具](tools/import_catalog.py) 使用相邻的旧项目网站快照及既有美术资产生成卡池与缩略图，日常启动只依赖 V1 自身文件。
- [领域规则](server/src/model.rs) 校验卡组、模式与地图，生成 AI 卡组、私有视图和冻结配置。[房间服务](server/src/room.rs) 负责入席、准备、锁定与撤销。每次修改在事务中锁定房间；每轮有唯一比赛记录。
- [身份与预设](server/src/session.rs) 管理游客 cookie、私人预设以及 WebSocket 心跳。服务端推送更新通知后，浏览器读取按席位裁剪的最新快照。准备中的玩家失联约 20 秒后清除准备，席位默认保留 120 秒；可用 `LOBBY_GRACE_SECONDS` 设置总保留时长。
- [数据库与交接](server/schema.sql) 保存游客、卡组、房间和比赛。下一阶段宿主可用 `claim_pending_match(match_key)` 原子取得待交接配置。已撤销或已认领的比赛再次认领时返回零行。大厅界面只读取本方卡组；服务端冻结记录保存双方完整配置和版本。

## 验证

```sh
cargo test --locked
npm --prefix web run build
npm --prefix web run test:lobby
npm --prefix web run test:settings
```

浏览器用例要求本地已安装 Chrome 且大厅正在运行，默认访问 4317 端口，可用 `LOBBY_URL` 覆盖。用例建立独立游客并写入开发库，覆盖移动视口 AI 备战、卡组及技能保存、好友邀请、满房、不同席位卡组、重复与同时准备、重连和重新组局。

[新版架构](浏览器版架构方案.md) · [大厅与备战设计](第一阶段网页大厅与备战.md)
