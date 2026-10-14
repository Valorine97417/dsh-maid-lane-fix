# dsh-maid-lane-fix

DSH 小困插件 · **免费车道中间层 + 上游补丁器**：修 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 的两类毛病——出网指纹被 `opencode.ai` 拦（中间层负责，**不动上游一个字节**），以及 EAC 通道测不出首字延迟（补丁器负责，**可重放、可回滚**）。

## 一、中间层：三道指纹门

`opencode.ai` 的免密车道会给第三方客户端上**三道指纹门**，三道都过才放行。上游 2.1.0／2.2.0 前两道都不满足，于是整条车道（探测 + 真实对话）全部 `403 FreeTierError`：

| 门 | 判据 | 上游为什么踩中 |
| --- | --- | --- |
| 会话/请求 id | `x-opencode-session` / `x-opencode-request` 去掉前缀后 12 位 hex 的**低 12 位**是客户端自己的序号位（会话头取反） | 插件用 sha256 摘要冒充，序号位是随机的 → 撞不进那一族 |
| User-Agent | 出现 `deepseek-harness/<版本号>` 这个**词+斜杠+版本**的组合即拒；大写、下划线、词嵌在别处同样拒。裸词 `deepseek-harness` + `opencode/` 反而放行 | harness 要求归属 UA 必须在场，而插件的回退值恰好是 `deepseek-harness/0.1.7 (…)` —— 正好被点名 |
| body.tools | 必须含 `bash`/`glob`/`grep`/`read` **且带 `tool_choice`** | **上游自己处理**（`src/upstream.js` 的 `applyFingerprint`），本层不插手 |

本插件在启动时包一层 `globalThis.fetch`，只对发往车道的请求把前两项规范化，其余原样透传。

**判据怎么定的**：先用真 OpenCode CLI 走本机 MITM 中继逐字节转发拿到 200 基线，再**单变量回退**——只换 UA → 403，只换 session → 403，换 body／删 `x-opencode-session-id`／改 `x-opencode-client` → 200。头变体硬试之所以全都 403，是因为三门是 AND，少一道就分不清是哪道在拒。

## 二、补丁器：EAC 通道的首字延迟

EAC（共付车道）面板上「测不了首字延迟」是三层叠出来的，三处都在上游：

| 现象 | 根因 |
| --- | --- |
| 卡片上从来没有延迟数 | 探测轮显式跳过 EAC 条目，`buildSummary` 又对它们硬编码 `ttftMs: undefined` / `probedAt: 0` —— 设计如此，不是故障 |
| 「测一次」按钮卡死 | 前端 bench 超时 240s、后端空闲预算 300s，**差 60s**；而网关每 ~15s 一个 `: keepalive` 注释帧，把「空闲超时」无限续命 → 后端永不放弃、前端先报失败 |
| 偶尔"测出来了"其实是假的 | 网关会把错误 JSON **裸写**进 SSE（没有 `data:` 前缀），解析器只认 `data:` 行 → 静默丢弃成「0 帧、正常结束」，延迟记成总耗时 |

补丁集（7 处，跨 `client.js` / `src/http.js` / `index.js`）：

- `bench-deadline` —— 前端超时压过后端，别先于它放弃
- `idle-clock-comment` / `idle-clock-progress` —— **只有真帧能给空闲超时上弦**，注释帧不算
- `bare-json-is-a-failure` —— 裸 JSON 是失败，不是空流正常结束（下游 `stream.js` 自己会分类，只要让它看见）
- `bench-records-a-verdict` / `bench-ttft-from-measured` / `verdict-outlives-the-round` —— 测速就是一次探测：零帧算失败、ttft 用校验过的那份、结果写进账本且**有记录的行不再被"跳过"规则吃掉**

### 用法

```bash
node scripts/patch-ofm.mjs --dry-run    # 体检：哪些待应用、哪些已应用
node scripts/patch-ofm.mjs              # 落盘（首次自动备份原文件到 .lane-fix-orig/）
node scripts/patch-ofm.mjs --verify     # 逐字节核对落盘结果与补丁集一致
node scripts/patch-ofm.mjs --restore    # 从 .lane-fix-orig/ 回滚
```

自动定位包：先 `~/.dsh/profiles/desktop/node_modules/dsh-our-free-model`（解 junction），再 `web` profile；都没有就用 `--dir <包目录>` 指。

**为什么补丁器不自动跑**：它改的是**别人包里的文件**，而宿主插件在启动时静默改第三方文件是不该做的事（上游一升级、补丁就得重打，静默重打更糟）。所以它是显式 CLI：**你叫它，它才动**。锚点失配时整批中止、不写一半——上游改过这几行，它宁可报错也不猜。

## 三、为什么是「中间层」而不是改上游

这是 `dsh-maid-scenery` 那套**融合层**思路在网络层的同一种做法——隔离在自家包里，与上游配合，不接管它的实现：

- **改上游文件字节**：升级即丢（Windows 上 `file:` 安装还要维护 tgz／解包目录／部署目录**三处副本**，漏一处就复发）。
- **本中间层**：补丁在自家包里，上游怎么升级都冲不掉；上游**哪天自己修好了**，对已经合规的头本层是**空操作**（自动让路、零冲突），也不需要撤。

## 四、装

```bash
dsh plugin --profile desktop add "github:Valorine97417/dsh-maid-lane-fix"
```

装完**重启 DSH**（宿主侧插件，没有免重启路径）。补丁器改完上游文件**同样要重启**。

## 五、边界与安全

- **只碰一个主机**：白名单写死 `opencode.ai`，其它任何请求（包括别的提供方、你自己的 API）**逐字节透传**，连 `init` 对象都不换。
- **只在该动手时动手**：请求里必须有车道标记头（`x-opencode-session`）；已经合规的头一律原样放行。实测「干净形态经本层仍是 200」。
- **零运行时依赖**：不 import 任何 `@deepseek-ai/*`，`inject` 空数组，不注册路由、不带客户端半边——宿主缺服务时它也照常工作。
- **可卸载**：走 `ctx.effect` 登记，插件卸载即恢复原 `fetch`；重复装配只复用已有那一层，不会叠 wrapper。
- **不扣住用户**：任何一步出错只 warn，规范化失败就原样放行（车道宁可 403，也不该因为我们抛错而让整轮失败）。
- **补丁可回滚**：落盘前原文件进 `.lane-fix-orig/`，`--restore` 一键还原。

## 六、冒烟

```bash
node scripts/smoke.mjs                          # 81 条：编码形状、幂等、UA 剥法、越界保护、挂载/卸载、补丁集锚点
OFM_DIR=<上游包目录> node scripts/smoke.mjs     # 追加真实上游分支：落盘字节必须"全部已应用"
```

补丁器的**重放验证**（决定性）：拿 `.lane-fix-orig/` 三份原始文件搭一个干净包 → 跑补丁器 → 与真实落盘结果 `cmp` **三个文件逐字节一致**；再跑一次是「7 处已应用，0 个文件待改」。**手改过的注释也算补丁**，否则重放对不上——第一次就栽在这。

**端到端验证**（2026-10-14，本机）：
- 中间层——取上游**未修版** `upstream.js`/`http.js`/`probe.js` 装上本层，带被点名的归属 UA 跑 `probeModel()` → 车道恢复；装前 `❌ UpstreamError`、装后 `✅ 200`，卸载立刻复现 403。
- 补丁器——真打网关：`kimi-k2.6` 从「0 帧 / ok:true / 假 ttft」变成 `✗ SERVER` 并带出上游原话（`Function '…': Not found for account '…'`）；`glm-5.3`、`gpt-oss-20b` 不受影响。

## 七、已知边界

- 判据是「低 12 位能否还原出一个小序号」：sha256 摘要头撞进合法区间的概率约 `16/4096 ≈ 0.39%`，那一小撮请求仍会 403（下游探针会把它记成 `unknown`，等下一轮）。
- 车道**只认流式**：`stream:false` 即使全合规也被拒——那不是本层的职责，是车道本身的约束。
- 上游若把判据换成别的形状（例如校验完整时间戳的可解性），本层需要跟着更新一次。
- 补丁集锚点是**字节级**的：上游改过那 7 处附近的行，补丁器会报 `anchor-lost` 而不是硬套。届时按新原文更新 `lib/ofm-patch.js`。
- EAC 那两个 flash 模型（`glm-5.3-flash`、`deepseek-v4.1-flash`）实测 300s 内零数据帧，网关侧就是慢——补丁让它们**如实失败**，不会让它们变快。
