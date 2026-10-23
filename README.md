# dsh-maid-lane-fix

DSH 小困插件 · **免费车道中间层 + 上游补丁器**：修 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 的两类毛病——出网指纹被 `opencode.ai` 拦（中间层负责，**不动上游一个字节**），以及 EAC 通道测不出首字延迟（补丁器负责，**可重放、可回滚**）。

## 一、中间层：五道指纹门

`opencode.ai` 的免密车道会给第三方客户端上**五道指纹门**，五道都过才放行。上游 2.1.0 一道都不满足；`v2.2.0` 标签同样一道都不满足（实测该标签下 `src/upstream.js` 仍打 `/zen/v1`、无 `x-opencode-session-id`，`src/http.js` 也没有剥 UA 的处理——修复只活在 `main`），于是整条车道（探测 + 真实对话）全部 `403 FreeTierError`。

> **上游已正式修好**（2026-10-15 更新）：`v2.3.0` 标签（commit `ac4c55e`）已带上全部修法——`src/upstream.js` 里 `/inference/v1` 出现 7 处、`x-opencode-session-id` 3 处，`src/http.js:374` 有 `UA_REFUSED = /deepseek[-_]harness/gi`。它由 PR #330 合入 `main` 后随版本发布，**本层对 2.3.0 的请求是空操作**。下面这张表仍是判据真值（2.2.0 及以前适用），也是本层存在的理由：装了旧版的机器、以及上游将来再动判据时。

| 门 | 判据 | 上游为什么踩中 |
| --- | --- | --- |
| 端点地址 | 必须走 `/inference/v1/*`；`/zen/v1/*` 即使其余四道全对也 403（两套地址返回**同一份** 85 个模型清单） | 2.2.0 及以前都在打 `/zen/v1` |
| `x-opencode-session-id` | 必须**存在**且与 `x-opencode-session` 同值；缺了即 403 | 2.2.0 及以前只发 `x-opencode-session` |
| 会话/请求 id | `x-opencode-session` / `x-opencode-request` 去掉前缀后 12 位 hex 的**低 12 位**是客户端自己的序号位（会话头取反） | 插件用 sha256 摘要冒充，序号位是随机的 → 撞不进那一族 |
| User-Agent | 出现 `deepseek-harness/<版本号>` 这个**词+斜杠+版本**的组合即拒；大写、下划线、词嵌在别处同样拒。裸词 `deepseek-harness` + `opencode/` 反而放行 | harness 要求归属 UA 必须在场，而插件的回退值恰好是 `deepseek-harness/0.1.7 (…)` —— 正好被点名 |
| body.tools | `bash` 与 `read` 必须**同时**声明，且各自 schema 至少一个 property（只其一 → 403，`properties: {}` → 403） | 上游 `applyFingerprint` 处理了工具名，但**没有**保证 `read` 在场、也没保证 schema 非空 |

本插件在启动时包一层 `globalThis.fetch`，只对发往车道的请求把前四道（地址、session-id、两个 id 的形状、UA 写法）规范化；第五道在 body 里，本层也顺手兜住（补工具、补 schema property、必要时把 `tool_choice` 锁成 `'none'`），其余原样透传。

**判据怎么定的**：前两道与 UA 那道是 2026-10-14 用真 OpenCode CLI 走本机 MITM 中继逐字节转发拿到 200 基线，再**单变量回退**定出来的——只换 UA → 403，只换 session → 403，换 body／删 `x-opencode-session-id`／改 `x-opencode-client` → 200。后三道由上游 PR #330（2026-10-15 合并）用同一套 MITM + 逐字节重放公布，本层据此补齐；`x-opencode-client` 与 `x-opencode-project` 实测可省，本层不碰。头变体硬试之所以全都 403，是因为这些门是 AND，少一道就分不清是哪道在拒。

**没有第六道**（2026-10-15 更正）：五道全对就是能过——本机出口（`54.169.8.63`）用上游 `main` 的代码发请求**实测 200 出流**，真链路 UA `dsh/0.1.7 opencode/1.18.31` 同样 200。

> 更正说明：本 README 早先写过「本机出口过不去，上游还看出口/TLS 维度」——**那个结论是错的**。真因是当时的探针模型 `ling-3.1-flash-free` 已被上游下架，请求拿到的是 `400 {"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}`，被误读成了闸门拒签。教训：**探针模型必须从当轮 `/inference/v1/models` 清单里取**，用下架模型量出来的矩阵是废的。

## 二、补丁器：EAC 通道的首字延迟

EAC（共付车道）面板上「测不了首字延迟」是三层叠出来的，三处都在上游：

| 现象 | 根因 |
| --- | --- |
| 卡片上从来没有延迟数 | 探测轮显式跳过 EAC 条目，`buildSummary` 又对它们硬编码 `ttftMs: undefined` / `probedAt: 0` —— 设计如此，不是故障 |
| 「测一次」按钮卡死 | 前端 bench 超时 240s、后端空闲预算 300s，**差 60s**；而网关每 ~15s 一个 `: keepalive` 注释帧，把「空闲超时」无限续命 → 后端永不放弃、前端先报失败 |
| 偶尔「测出来了」其实是假的 | 网关会把错误 JSON **裸写**进 SSE（没有 `data:` 前缀），解析器只认 `data:` 行 → 静默丢弃成「0 帧、正常结束」，延迟记成总耗时 |

补丁集（v5：8 处，跨 `client.js` / `src/http.js` / `src/eac.js`；2.5.7 起 index.js 不再补丁——见下）：

- `bench-deadline` —— 前端超时压过后端，别先于它放弃（2.5.7 起上游自己就写 `330_000`，marker 恰好命中，条目保留只为 2.5.3 基线重放）
- `idle-clock-witness` / `idle-clock-dispatch` / `idle-clock-rawjson` / `idle-clock-wind` —— **只有真帧能给空闲超时上弦**，`: keepalive` 注释帧不算（见证位 `progressed` 声明、两处置位、循环尾部消费）
- `eac-body-limit-constant` / `eac-body-limit-before-send` / `eac-413-restated` —— 网关 8 MiB 请求体上限：写成常量、出网前本地拦截说人话、上游 413 再补一句上限
- ~~`bench-records-a-verdict` / `bench-ttft-from-measured` / `verdict-outlives-the-round`~~ —— **v4 作废：2.5.7 已原生化**（上游把 bench 重构进 `src/core/runtime.js` + `src/model-test.js`，测速自己写 `manualResults` 账本、零帧抛 `CODE.empty`、summary 原生读记录；原文注释备查在 `lib/ofm-patch.js`）

> **v5（2026-10-23，对齐 2.5.9）**：auto-update 把包从 2.5.7 顶到 2.5.9，整包覆盖把 v4 的七处落盘**全冲掉**（`--verify` 报 7 处「待应用」）。复核结论是**零重锚**：2.5.9 的 `src/http.js` / `src/eac.js` 与 2.5.7 基线**逐字节相同**（sha256 一致），锚点逐字仍在；上游这一版只动了 `client.js`（前端「视觉特效」开关）与 `index.js`（渠道精简），都不落在锚点上。所以 v5 = 补 `baseline/ofm-2.5.9/` + 重放落盘，补丁内容一字未改。


### 用法

```bash
node scripts/patch-ofm.mjs --dry-run    # 体检：哪些待应用、哪些已应用
node scripts/patch-ofm.mjs              # 落盘（首次自动备份原文件到 .lane-fix-orig/）
node scripts/patch-ofm.mjs --verify     # 逐字节核对落盘结果与补丁集一致
node scripts/patch-ofm.mjs --restore    # 从 .lane-fix-orig/ 回滚
node scripts/patch-ofm.mjs --help       # 只看用法（v0.3.2 起：不认的参数一律报错退出，绝不写盘）
```

> **不带参数 = 落盘**，所以参数写错很危险。v0.3.2 起脚本先做参数白名单校验：只认上面这几个旗标（加 `-h`），任何不认识的参数（`--dryrun` 这种打错的）直接报 `未知参数：xxx` 并 `exit 2`，**绝不落到默认动作**。此前 `--help` 会被静默忽略、一路把补丁真打进运行包——想查用法反而改了文件，这个失败模式已从根上掐掉。

自动定位包：先 `~/.dsh/profiles/desktop/node_modules/dsh-our-free-model`（解 junction），再 `web` profile；都没有就用 `--dir <包目录>` 指。

**为什么补丁器不自动跑**：它改的是**别人包里的文件**，而宿主插件在启动时静默改第三方文件是不该做的事（上游一升级、补丁就得重打，静默重打更糟）。所以它是显式 CLI：**你叫它，它才动**。锚点失配时整批中止、不写一半——上游改过这几行，它宁可报错也不猜。

### 还原基线：`baseline/ofm-<版本>/`

`--restore` 靠的是**包目录里的** `.lane-fix-orig/`，而那份备份有两个弱点：只在第一次落盘时生成，且随时可能被清掉（`node_modules` 重装、上游升级覆盖、清理脚本扫过——本机 2026-10-15 实测被 sweep 连带清掉一次，`--restore` 当场 `exit 1`）。

所以仓库里另存一份**上游原文**当还原依据，跟代码一起走版本控制。每升一版存一份，目录名带版本号：

| 目录 | 对应上游 | 基线 gzip 合计 |
| --- | --- | --- |
| `baseline/ofm-2.3.0/` | v2.3.0 | 179208 字节 |
| `baseline/ofm-2.5.0/` | v2.5.0 | 188606 字节 |
| `baseline/ofm-2.5.1/` | v2.5.1 | 191721 字节 |
| `baseline/ofm-2.5.3/` | v2.5.3（4 份） | 196652 字节 |
| `baseline/ofm-2.5.7/` | v2.5.7（4 份） | 208047 字节 |
| `baseline/ofm-2.5.9/` | v2.5.9（现行，4 份） | 200590 字节 |

每个目录里四份 `*.gz`（`client.js` / `index.js` / `src__http.js` / `src__eac.js`；2.5.3 起含 `index.js`，v4 起它只为「上游回退 bench 重构时重锚」归档）+ 一份 `SHA256SUMS`（全值见该文件），`src__http.js` 的 `__` 是补丁器备份文件的命名法，解出来要放回 `src/http.js`。冒烟脚本按目录扫，**新存一份基线不用改冒烟**，但清单必须与 `PATCHED_FILES` 完全对齐（历史版本的清单契约钉在 `scripts/smoke.mjs` 的 `BASELINE_CONTRACT` 里）、sha256 必须对得上。

```bash
# 换成你要的那一版目录
PKG=~/.dsh/profiles/desktop/node_modules/dsh-our-free-model
gunzip -c baseline/ofm-2.5.9/client.js.gz    > "$PKG/client.js"
gunzip -c baseline/ofm-2.5.9/index.js.gz     > "$PKG/index.js"
gunzip -c baseline/ofm-2.5.9/src__http.js.gz > "$PKG/src/http.js"
gunzip -c baseline/ofm-2.5.9/src__eac.js.gz  > "$PKG/src/eac.js"
node scripts/patch-ofm.mjs --dry-run         # 应报「7 处待应用」（+1 处已应用=上游自带 330_000）= 干净的原文
```

**先确认包版本与基线目录一致**——往别的版本上盖等于换文件。上游发新版后锚点可能已变，要按同法重新导一份（`git archive vX.Y.Z <files> | tar -x`，再 `gzip -9c` 那三个文件），并补上 `SHA256SUMS`。

`baseline/` 与 `docs/` 一样**故意不在 `files` 白名单**：`git clone` 看得到、`pnpm add` 装不到——它是档案，不是运行时要用的东西。

### 三类拒签事故的现场记录

WorkBuddy `request illegal`、CodeArts `401→429`、trae/lobsterai 502 限流伪装——症状、根因、修法与验证判据都归档在 [`docs/ofm-lane-fingerprint-incidents.md`](docs/ofm-lane-fingerprint-incidents.md)。**上游升级后先看那份**再决定打哪几处补丁：2.5.1 已自行补上会话三头（我方那处降级为冗余），但 CodeArts 签名两处仍必需。

### 宿主与插件运行时事故的当日记录

上游拒签之外，还有一类事故来自**宿主自身配置、内容指纹与插件运行时**的交界，归档在 [`docs/incidents-2026-10-20.md`](docs/incidents-2026-10-20.md)。其中第 8 条（buddy 全线 `unapproved channel`）最值得先看：**报错文案说「渠道未审批」，真因却是 system prompt 首句的内容指纹**——四个由文案推导出的假说全部被单变量实测推翻。另附 `code 11128` 一个码四种含义的对照表，以及「配置已改 ≠ 已生效」「zstd 多帧静默截断」「jsdom 量不出布局」等可复用纪律。


## 三、为什么是「中间层」而不是改上游

这是 `dsh-maid-scenery` 那套**融合层**思路在网络层的同一种做法——隔离在自家包里，与上游配合，不接管它的实现：

- **改上游文件字节**：升级即丢（Windows 上 `file:` 安装还要维护 tgz／解包目录／部署目录**三处副本**，漏一处就复发；`pnpm` 重装还会从 tgz 重新解包，把改好的部署目录原地冲回旧版）。
- **本中间层**：补丁在自家包里，上游怎么升级都冲不掉；上游**哪天自己修好了**，对已经合规的头本层是**空操作**（自动让路、零冲突），也不需要撤。
- **实测佐证**（2026-10-15）：上游 `main` 已自带全部五道门的修法，本层对它的请求全部返回 `null`（零改动）——这正是设计意图。

## 四、装

```bash
dsh plugin --profile desktop add "github:Valorine97417/dsh-maid-lane-fix"
```

装完**重启 DSH**（宿主侧插件，没有免重启路径）。补丁器改完上游文件**同样要重启**。

## 五、边界与安全

- **只碰一个主机**：白名单写死 `opencode.ai`，其它任何请求（包括别的提供方、你自己的 API）**逐字节透传**，连 `init` 对象都不换。
- **只在该动手时动手**：请求里必须有车道标记头（`x-opencode-session`）；已经合规的请求一律原样放行（地址、头、body 全不动）。实测「干净形态经本层仍是 200」。
- **只在能安全改 body 时改 body**：工具指纹只对 `body` 是 JSON 字符串的请求生效；`ReadableStream`、`FormData`、空体一律跳过，不猜不造。
- **零运行时依赖**：不 import 任何 `@deepseek-ai/*`，`inject` 空数组，不注册路由、不带客户端半边——宿主缺服务时它也照常工作。
- **可卸载**：走 `ctx.effect` 登记，插件卸载即恢复原 `fetch`；重复装配只复用已有那一层，不会叠 wrapper。
- **不扣住用户**：任何一步出错只 warn，规范化失败就原样放行（车道宁可 403，也不该因为我们抛错而让整轮失败）。
- **补丁可回滚**：落盘前原文件进 `.lane-fix-orig/`，`--restore` 一键还原；那份备份丢了也不要紧——仓库里 `baseline/ofm-<版本>/` 存着上游原文当还原依据（现行 `baseline/ofm-2.5.9/`）。

## 六、冒烟

```bash
node scripts/smoke.mjs                          # 152 条：编码形状、端点改写、工具指纹（含 tools 缺席）、幂等、UA 剥法、越界保护、挂载/卸载、补丁集锚点、还原基线校验
OFM_DIR=<上游包目录> node scripts/smoke.mjs     # 追加真实上游分支（153 条）：落盘字节必须"全部已应用"
node scripts/eac-body-limit-test.mjs            # 32 条：8 MiB 边界逐字节用例 + 上游 413 文案 + 零真实出网
```

补丁器的**重放验证**（决定性）：`--verify` 拿 `baseline/ofm-<版本>/` 的原文在内存里重放同一补丁集，与真实落盘结果**逐字节比对**，不一致就报错保留现场。手工核对的老办法仍然有效：解压基线搭一个干净包 → 跑补丁器 → 与真实落盘 `cmp` 结果逐字节一致；再跑一次是「8 处已应用，0 个文件待改」。**手改过的注释也算补丁**，否则重放对不上——第一次就栽在这。

**还原基线也在冒烟里**：`baseline/ofm-*/*.gz` 按目录逐个解压核 sha256，对的是同目录 `SHA256SUMS`（改基线就得连清单一起改，对不上立刻红）；清单覆盖的文件还必须与 `PATCHED_FILES` 完全对齐。

**端到端验证**（2026-10-14，本机）：
- 中间层——取上游**未修版** `upstream.js`/`http.js`/`probe.js` 装上本层，带被点名的归属 UA 跑 `probeModel()` → 车道恢复；装前 `❌ UpstreamError`、装后 `✅ 200`，卸载立刻复现 403。
- 补丁器——真打网关：`kimi-k2.6` 从「0 帧 / ok:true / 假 ttft」变成 `✗ SERVER` 并带出上游原话（`Function '…': Not found for account '…'`）；`glm-5.3`、`gpt-oss-20b` 不受影响。

**上游现场复测**（2026-10-15，本机）：把上游 `main`（2.2.0 + PR #330）的 `src/upstream.js` 直接 import 当活体探针——`endpointFor()` 已返回 `/inference/v1/chat/completions`、`gatewayHeaders()` 已含 `x-opencode-session-id`、`mintSessionId()` 铸的头形状合规——用它自己铸的头、自己组的头去打，**200 出流**。上游 `main` 这版已经能自己过门；本层对它的请求是空操作（`normalizedRequest` 返回 `null`）。

**五道门的真判据**（本机逐格单变量实测，比 PR #330 的描述更细）：
- UA 那道只拒「`deepseek-harness/` **+ 斜杠版本号**」这个组合：`deepseek-harness/2.2.0` → 403、`DEEPSEEK-HARNESS/2.2.0` → 403；而 `deepseek-harness`（无版本）、`deepseek_harness/2.2.0`（下划线）、`dsh/2.2.0` 全放行。
- 另有一道 PR #330 没写：**UA 必须含 `opencode/<版本>` token**——`myapp/1.0`、`node`、空 UA 一律 403，加 `opencode/1.19.0` 即 200。
- **`tools` 字段整个缺席也 403**（`tools: []` 同），纯文本轮次必踩——0.3.1 补的就是这个缺口。

## 七、已知边界

- 判据是「低 12 位能否还原出一个小序号」：sha256 摘要头撞进合法区间的概率约 `16/4096 ≈ 0.39%`，那一小撮请求仍会 403（下游探针会把它记成 `unknown`，等下一轮）。
- 车道**只认流式**：`stream:false` 即使全合规也被拒——那不是本层的职责，是车道本身的约束。
- 上游若把判据换成别的形状（例如校验完整时间戳的可解性），本层需要跟着更新一次。
- 补丁集锚点是**字节级**的：上游改过那 7 处附近的行，补丁器会报 `anchor-lost` 而不是硬套。届时按新原文更新 `lib/ofm-patch.js`。
- EAC 那两个 flash 模型（`glm-5.3-flash`、`deepseek-v4.1-flash`）实测 300s 内零数据帧，网关侧就是慢——补丁让它们**如实失败**，不会让它们变快。
