# ADR 0007：网页版与 Node 版共用后端，存档按宿主分开

## 决策

同一套 `mock/` + `mockjs/` 后端支持两种宿主，由 `host-mode.js` 决定：

- **浏览器宿主**（默认，静态托管如 GitHub Pages）：`web-host.js` 在页面内加载后端，`FakeWebSocket` 派发协议，档案存在该站点的 `localStorage['mahjong-dream/profile']`。
- **Node 宿主**（`start-game.bat` / `npm start`）：`local/server.mjs` 运行后端并改写 `host-mode.js` 为 `node`；档案仍按 ADR 0001 存在 `userdata/profile.json`。

档案规则、一次性经济补给、结算记账和存档修改器操作都放在共享的 `mockjs/profile_host.mjs`，两种宿主只负责“怎么持久化”。网页默认入口为国际版英文（中文客户端已归档到 `archive/zh-client/`）。

存档修改器（`modifier.js`）面向单人离线游玩：可直接改昵称、段位、钱包，重置战绩，导入/导出、新建账号。导出 JSON 是两种宿主之间迁移存档的方式。

## 理由

- 游戏已关服且只做单机，网页版免安装即可游玩；Node 版保留给离线包、日后打包其他平台和 Release。
- 共享宿主逻辑避免两边的补给、记账和修改器行为分叉。
- `localStorage` 足够容纳约 20 KB 的档案，同步读取使后端能在 Unity 启动前就绪。github.io 下同一用户的项目页共享来源，所以键名带项目名。

## 代价与边界

- 网页存档跟随浏览器与站点：清除站点数据、无痕窗口、换浏览器或设备都会得到另一份档案；README 提示定期导出。ADR 0001 关于“浏览器存储易丢档”的顾虑对网页版依然成立，靠导出缓解。
- 修改器不做防作弊；写操作只在没有进行中对局时允许，避免改动与牌局结算交错。
- 静态托管不能设置 `Content-Encoding`，`.unityweb` 由 Unity loader 在浏览器里解压；Node 服务也不再为它加该头，两边行为一致。
- 网页版刷新会重建页面内后端；进行中的对局靠档案里的对局记录重演恢复（ADR 0008），两种宿主行为一致。
