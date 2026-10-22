# local/

## Responsibility
Node 宿主（ADR 0007）：启动器、静态文件 + 回环 WebSocket 服务、`/api/profile`、档案文件读写。对局与协议委托给 `mock/server.js`，档案规则、经济补给和修改器操作委托给 `mockjs/profile_host.mjs`（与网页版共用）。

## Key files
- `launcher.mjs` — `npm start` / `start-game.bat` 入口；fork `server.mjs`，等端口就绪后打开 Edge/Chrome，默认端口 8765（保持浏览器偏好来源），仅转发 `--players/--length` 为 URL 参数；语言由国际版设置记忆。
- `server.mjs` — HTTP（MIME、Range、路径穿越防护；`.unityweb` 不加 `Content-Encoding`，由 loader 解压）+ `/ws` 单活动连接租约；`/host-mode.js` 返回 `node`；`POST /api/profile`（仅同源 JSON）转给档案宿主。启动时依次 import `mock/proto.js`、`mock/data.js`、`mock/userdata.js`、`mockjs/browser_entry.mjs`、`mock/server.js`，再用 `globalThis.__mj.server` 处理消息。
- `profile.mjs` — `userdata/profile.json` 的读取、损坏备份和原子写入；默认值、规范化、段位、战绩从 `mockjs/profile.mjs` 转出。

## Flow
浏览器 → `/ws` → `mock.FakeWebSocket` 派发 → `profile_host` 挂在会话上的回调 → `persistSoon()`（50 ms 合并）把档案与 `lobbyData` 串行写盘；修改器请求走 `saveNow()`，写盘完成后才应答。

## Integration
- Depends on: `mock/*.js`（经 `globalThis.__mj`）、`mockjs/profile_host.mjs`、`mockjs/profile.mjs`
- Used by: `start-game.bat`、`package.json` 的 `start`、`test/local-*.test.mjs`

## Gotchas
- 存档写入必须走临时文件 + 原子替换，Windows 上 EPERM/EACCES/EBUSY 最多重试 3 次；损坏文件备份为 `profile.corrupt-<时间>.json`。
- `MJ_USERDATA_DIR` 隔离存档；测试必须用临时目录，不要写项目的 `userdata/`。
- WebSocket 只允许一个活动连接，残留的浏览器实例会让新连接收到 409，客户端显示“网络不稳定”。
- 断线时调用 `detachMatch()` 让 AI 接管真人席，不销毁牌局；同进程内可重连。
- 经济初始化只执行一次，重启不补满已花掉的货币。
