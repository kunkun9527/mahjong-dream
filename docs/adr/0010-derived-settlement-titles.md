# ADR 0010：用派生资源包修正英文结算档位贴图

状态：已采纳（2026-10-24）

## 背景

英文版和牌结算的档位标题是烘焙在贴图里的艺术字，不在语言表中：`mjab_jp_ui_ingame` 包里的 `ui_settlement_img_{mg,tm,bm,sbm}_en` 写着 “Full Han / Jump Full Han / Double Full Han / Triple Full Han”，是“满贯/跳满/倍满/三倍满”的字面直译。英文立直麻将通行的是罗马音 Mangan / Haneman / Baiman / Sanbaiman；英文语言表本身已用这些词。役满系列贴图（Yakuman、Double…Sextuple Yakuman、Cumulative Yakuman）可接受，不改。全部 485 个资源包中只有这一个包含英文结算贴图。

## 资源包格式（本快照实测）

- 包文件 = 33 字节头（一个空格 + UnityFS 包体的 MD5 十六进制）+ 标准 UnityFS 包体；文件名中的哈希是整个文件的 MD5。
- `StreamingAssets/Bundles/versions.json` 指向资源清单 `arts_<md5>.json`（标准 UnityFS，含 `bundles[] = {name, hash, size, …}`）；`"encryption": true` 并不代表文件加密，UnityPy 可直接读写。
- 客户端按清单核对下载的包：只替换包而不改清单时，会静默重试 3 次后卡在加载 0%。清单与 `versions.json` 同步更新后能正常加载。

## 决策

- 原件不动。`tools/build_settlement_titles.py` 先校验原包、原清单和 `versions.json` 的固定 MD5，只替换四张贴图（尺寸与 ASTC 4×4 格式不变），再核对包内其余对象的原始数据逐一相同；生成以哈希命名的派生包、派生清单 `arts_<md5>.json`（只改该包条目的 hash/size），以及 `StreamingAssets/Bundles/versions.mj.json`（只改 Arts 的 hash/size）。构建可复现，结果记在 `tools/settlement-titles/manifest.json`。
- `offline-patch.js` 把对 `StreamingAssets/Bundles/versions.json` 的 fetch/XHR 改指向 `versions.mj.json`，两种宿主都经过这里；其他资源路径不变。
- 贴图源文件 `tools/settlement-titles/*.png` 随仓库提交，构建只用它们。重画用 `--render` 加开源字体 Caveat Brush（SIL OFL 1.1，google/fonts），配色取自原图（上红下黄渐变、暗红描边、柔和投影），笔画略加粗贴近原毛笔字。

## 理由

- 档位标题是贴图，只能替换图片；沿用 ADR 0009 的思路：原件可追溯，派生物哈希固定，Unity 快照一变就构建失败而不是带病运行。
- 只重定向一个入口文件，客户端仍按自己的清单校验所有下载，不需要改 Unity 代码。

## 代价与边界

- 构建需要开发机临时安装 UnityPy==1.25.4（自带 ASTC 编码器）和 Pillow，不是项目依赖；运行时不需要 Python。
- 新字体与原图的毛笔字体不完全一致，只是风格接近。
- 若以后还要改别的资源包，在同一脚本里加条目并重新生成派生清单；不要再引入第二份派生 `versions` 文件。
- 隔离无头 Edge 实测（2026-10-24，全新浏览器档案）：静态宿主从仓库原样文件加载 `versions.mj.json`、派生清单与派生包，各只请求一次、无重试；实际和牌结算依次显示 Mangan、Haneman（早期试作版贴图）、Baiman、Sanbaiman，整局走到 Match Result 正常。Node 宿主同样加载派生清单与派生包并正常进入牌桌菜单，未在该宿主打到结算。未验收移动端与中/韩文界面（它们使用各自未改动的贴图）。
