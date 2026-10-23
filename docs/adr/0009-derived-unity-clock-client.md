# ADR 0009：用哈希固定的派生 WASM 让原客户端显示权威剩余时间

状态：已采纳（2026-10-23）

## 背景

引擎的单窗口真人时钟（`GameEngine._humanClock`）已统一公告、超时、备用扣费和重连快照。原 Unity 客户端在 `InitCountDown` 里按收到的 `defaultMinTimeout` / `leftTimer` 算出三个绝对截止点；协议里没有暂停、续时或重设时钟的消息，JS 也没有可调用的计时接口。抢杠/抢北等切点生成不了局面快照，只能退回整手重放，客户端会按历史公告重新从“5+20 秒”起算，比服务端晚超时。

## 决策

- 不修改原件 `Build_intl/mj-h5.wasm.unityweb`（SHA-256 `730effb3…cab9`）。`npm run build:clock`（`tools/build_clock_client.mjs`）校验原件哈希后反汇编，在 `InitCountDown`（func 39470）和 `UpdateTimeText`（func 14666）读到当前时间后插入 `mj.clock`，用宿主投影覆盖 352/360/368 三个截止点；v2 另以 `mj.sync` 观察通知分发（35847）、渲染队列（21653）、Reload 分发（35819）与状态切换（4571），导出与原件完全一致。产物 `Build_intl/mj-h5.clock-<wasm 哈希前 16 位>.wasm.unityweb` 和清单 `mj-h5.clock.json` 随仓库提交，运行时不需要构建工具。
- `clock-bridge.js` 经 Unity loader 已有的 `Module.instantiateWasm` 钩子加载派生文件，先校验清单和 WASM 哈希。清单声明的来源哈希或派生文件对不上时直接中止启动（原件本身由派生构建和回归测试校验），**不静默回退**到会显示错误时间的原客户端。不覆写全局 `WebAssembly`。
- 时钟投影 `{id, baseMs, extraMs, running}` 只来自 `GameEngine.humanClockState()`：静态宿主直接读页内引擎；Node 宿主在同一条游戏 WebSocket 上发 JSON 文本帧，`offline-patch.js` 在交给 Unity 前吞掉。三次读取共用同一份毫秒样本、向上取整，服务端 3 秒宽限不进入客户端显示。
- 恢复使用 `{mjSync: …}` / `{mjSyncAck: …}` JSON 侧带，不改变原 protobuf 消息。服务端为当前 socket 分配同步批次 UUID，实际投递末帧后发送其 `f27` 计数。派生客户端须已消费该帧、渲染队列空闲；快照另须对应状态机离开 Reload(9) 返回 Gameplay(4)，再经历两次绘制机会才回 ACK。服务端核对连接、可见性、批次及计数，期间若有新增牌局帧则另开追帧批次；没有确认只保持冻结并在超时后重连，不用固定延时解冻。控制侧带不送进 Unity 的 protobuf 解码器。
- Reload 实际经 HybridCLR 运行，不能挂在未执行的 AOT 异步状态机副本；钩子观察 Reload 分发期间进入状态 9 的那个状态机，只有同一对象成功回到状态 4 才能完成。
- Node 服务给派生文件加 `Content-Encoding: br`、`Content-Type: application/wasm`，Cloudflare `_headers` 的 `*.wasm.unityweb` 规则同样覆盖它；没有编码头的静态托管则由文件内嵌的 Unity Brotli 标记交给 loader 解压。

## 理由

- 不重写 C# 状态机：计时只覆盖三个截止点，同步钩子只观察现有客户端真实执行，不替代重放、超时动作和按钮逻辑。
- 哈希固定让 Unity 升级后立即失败而不是带病运行；派生过程可重复，原件始终可回溯。

## 代价与边界

- 派生文件与当前国际版强绑定。升级 Unity 构建时必须重新核对计时、通知、渲染、Reload 与状态机钩子和内存偏移，再跑 `npm run build:clock` 和测试。
- 构建工具需要开发机临时使用 npm 的 `wabt@1.0.39`，以及 Python `wasmtime==50.0.1`、`brotlicffi==1.2.0.0`；它们不是项目依赖。
- 中文归档客户端（`archive/zh-client/`）没有接入桥接。
- 独立审查发现的“投递前即解冻”已由 v2 消费确认门禁修复。单测故意推迟末帧消费、渲染完成与 Reload 退出；旧连接、错批次/计数、后台及超时均不能开门。受控 Edge 验证了 Node 四麻快照恢复和静态三麻强制整手重放，ACK 发出前冻结、服务端验收后才续走。两次绘制机会只保证客户端完成处理后有绘制机会，不证明操作系统已把画面显示到物理屏幕。当前派生 SHA-256 为 `42f4d01559f16d7a564ec82632d4be9dc3a85b51d42841e787cf08fd0625cd90`；已重复构建验证一致。
- 2026-10-23 已在隔离 Edge 中从正式 `game.html` 验收两种宿主（静态三麻、Node 四麻）：冻结后强制整手重放保留余量，续时后原客户端自己在 33 秒左右发出超时，下一窗口仍是 5 秒基础段，用掉约 2 秒后再重放仍显示 3 秒。整手重放是通过禁用快照强制触发的；没有自然触发抢杠/抢北，也没有验收真实的系统级后台切换或移动端。
