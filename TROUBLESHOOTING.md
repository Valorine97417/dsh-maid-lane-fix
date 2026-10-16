# dsh-maid-lane-fix · 问题与解决记录

> 用途：**新设备安装 / 重装 / 上游升级后**的排查手册。分三趟活：装插件（中间层）、跑补丁器（改上游字节）、验完了确认真的生效。
> 每条按「症状 → 原因 → 解法 → 验证」写；症状照抄实际报错或现象，命令都是可复制的具体值。
> 只写有据可查的；没素材的地方写「暂未遇到」，不确定的标「（待核）」。
> 最后更新 2026-10-16（本机实测口径：`dsh-our-free-model` 2.3.0 + lane-fix 0.3.1）。
>
> 三条先记住：**① 补丁器是显式 CLI，装插件不会自动跑；② 插件与补丁改完都得重启 DSH；③ 上游一升级，补丁就得重打，锚点失配宁可报错也不猜。**

## 一、安装与部署

### 1.1 装完插件，车道照旧 403

- **症状**：`dsh plugin --profile desktop add` 成功，重启后探测仍全是 `403 FreeTierError`。
- **原因**：① 宿主侧插件没有免重启路径，不重启等于没装；② 装错了 profile（本机有 `desktop` / `dev` / `web` 三个，车道请求由 `desktop` 这个跑）。
- **解法**：
  ```bash
  dsh plugin --profile desktop add "github:Valorine97417/dsh-maid-lane-fix"
  # 重启 DSH
  ```
  本机（2026-10-16 实测）走的是 link 安装：`"dsh-maid-lane-fix": "link:D:/DeepSeek Harness/Works/dsh-maid-lane-fix"`——改工作副本即生效，但要重启；`web` profile 下没装这个包。
- **验证**：日志里出现 `[lane-fix] 中间层已挂载（目标主机 opencode.ai）`；命中改写时还会打 `已规范化车道请求 #<n>：<改动列表>`。

### 1.2 补丁器找不到上游包

- **症状**：`找不到 dsh-our-free-model，请用 --dir 指定包目录`（exit 1）。
- **原因**：自动定位只有两个候选，够不到别的落点：
  `~/.dsh/profiles/desktop/node_modules/dsh-our-free-model` → 再 `~/.dsh/profiles/web/node_modules/dsh-our-free-model`。
- **解法**：`node scripts/patch-ofm.mjs --dir <包目录>`。本机是 junction，脚本会 `realpath` 解开：`~/.dsh/profiles/desktop/node_modules/dsh-our-free-model` → `D:\Downloads\dsh-our-free-model-2.1.0`。
- **验证**：`--dry-run` 首行打印 `补丁集 v1 → <解开的真实包目录>`；地址不对就说明走错了包。

### 1.3 「补丁器为什么不挂到插件启动流程里？」

- **症状**：装了插件、以为一切自动，结果 EAC 那几处一点没动。
- **原因**：设计如此——补丁器改的是**别人包里的文件**，宿主插件启动时静默改第三方文件不该做（上游一升级补丁就得重打，静默重打比不重打更糟）。它是「你叫它，它才动」。
- **解法**：装完插件后手动跑一次补丁器：
  ```bash
  node scripts/patch-ofm.mjs --dry-run   # 体检：哪些待应用、哪些已应用
  node scripts/patch-ofm.mjs             # 落盘（首次自动备份到 .lane-fix-orig/）
  node scripts/patch-ofm.mjs --verify    # 逐字节核对（改完必跑）
  node scripts/patch-ofm.mjs --restore   # 从 .lane-fix-orig/ 回滚（先看 2.4/2.5 的坑）
  ```
- **验证**：落盘最后一行会提醒 `**改动要重启 DSH 才生效。**`

### 1.4 补丁改完了，面板却毫无变化

- **症状**：`--verify` 通过，去面板点「测一次」，行为跟改之前一模一样。
- **原因**：Node 已经加载的模块在内存里，磁盘上的新字节没被读；重启才会重新加载。
- **解法**：重启 DSH，然后再复测。
- **验证**（别靠感觉，比两个时间戳）：① 宿主进程启动时间——Windows 下
  `(Get-NetTCPConnection -LocalPort 8326 -State Listen).OwningProcess` 取 PID，再 `Get-Process -Id <PID> | Select StartTime`；② 探测结果文件的 `at` 时间戳（`$DSH_HOME/our-free-model/availability.json`）。后者落在前者之后才说明这轮数据出自新进程。2026-10-16 实测：网关 PID 8128 起于 20:35:27，探测 `at` 20:39:39——时间戳一比就排掉了「补丁没写进去」这条错误假设。

### 1.5 装完/重装后 web boot 报 bundle 加载失败

- **症状**：`bundle script … failed to load`，紧跟 `skipped after an earlier failure of this bundle`。
- **原因**：通常是 **rev 失配**而非插件损坏——host 的 `artifactRevision` 只由 `client.js` 的 mtime/ctime/size 派生，`pnpm install` 重写 `node_modules` 后 rev 变了，浏览器还拿旧 rev 请求 combo URL → 404 → script onerror → 同 batch 其余 entry 被 `failedBundleUrls` 跳过。
- **解法**：点弹窗里的「重启」（重启后 manifest 与 host 重新对齐即自愈）。**别点「禁用第三方插件」**——那会顺手砍掉配置。
- **验证**：重启后 boot 无同类报错，插件面板里 `lane-fix` 仍在列表。

### 1.6 目录名 ≠ 版本号（别按路径判版本）

- **症状**：看到包目录叫 `dsh-our-free-model-2.1.0`，以为在 2.1.0 上打补丁。
- **原因**：本机包目录是早期 clone 留下的名字，`package.json` 已经是 `2.3.0`（2026-10-16 实测）。
- **解法**：一律以 `package.json` 的 `version` 为准。
- **验证**：`grep -m1 '"version"' "$PKG/package.json"`。

## 二、补丁打不上 / 打上无效（上游版本变了怎么办）

### 2.1 锚点失配，整批中止（最常见的一种）

- **症状**：
  ```
  ✗ 锚点失配  client.js     bench-deadline   测速按钮的超时要压过后端，不能先于它放弃
  补丁锚点失配，整批中止（上游大概已经改过这些地方，请重新核对）：
    - client.js · bench-deadline（测速按钮的超时要压过后端，不能先于它放弃）
  ```
  exit 1，且**一个字节都没写**。
- **原因**：补丁集锚点是**字节级**的（连缩进和注释一起匹配）。上游改过那 7 处附近的行——这正是「该退休了」的信号，脚本故意不猜。
- **解法**：拿新版原文逐处核对，更新 `lib/ofm-patch.js` 里对应 `from` / `to` / `marker`，并把 `PATCH_SET_VERSION` 加一；若整段结构都变了，按 2.5 的办法重新导一份 `baseline/`。
- **验证**：`--dry-run` 从 `✗ 锚点失配` 变成 `· 待应用`；`--verify` 通过。

### 2.2 文件缺失：`包里缺少文件`

- **症状**：`包里缺少文件：src/http.js`（exit 1），或报告里出现 `✗ 文件缺失`。
- **原因**：包目录被外部删掉了（`rm -rf node_modules/<pkg>`），而 `pnpm install` 会假装成功——回一句 `Already up to date` 直接跳过，`--force`、删 `node_modules/.modules.yaml` 都不管用，账本仍认为已装好。
- **解法**：让 pnpm 重新解析（同版本重装不会改 dependencies，只补回目录）：
  ```bash
  pnpm add dsh-our-free-model@2.3.0
  ```
- **验证**：包目录重新出现三个文件；`--dry-run` 不再报 missing-file。

### 2.3 补丁打上了，又被冲掉

- **症状**：`--verify` 报
  `有 7 处不是"已应用"状态——落盘结果与补丁集不一致。`（exit 1）；
  或 `--dry-run` 报 `体检：0 处已应用，3 个文件待改。`
- **原因**：上游升级覆盖、`node_modules` 重装、清理脚本扫过——都会把三个文件换回原文。`node_modules` 里的东西不是你的。
- **本机实测（2026-10-16）**：包内 `client.js` / `index.js` / `src/http.js` 的 sha256 与 `baseline/ofm-2.3.0/` 原文**逐字节一致**（`21c387c6…` / `8d8a4b54…` / `43b3cb0a…`），即当时是**干净的未打状态**；`--dry-run` 也如实报 7 处待应用。
- **解法**：重跑 `node scripts/patch-ofm.mjs`，重启 DSH。
- **验证**：`--verify` 输出 `全部已应用，且落盘字节与补丁集完全一致。`

### 2.4 `--restore` 报「没有备份，无法回滚」

- **症状**：`没有备份，无法回滚：src/http.js`（exit 1）。
- **原因 A**：`.lane-fix-orig/` 被清掉了。它只在**第一次落盘前**生成，且随时可能被清（`node_modules` 重装、上游升级覆盖、清理脚本扫过）——本机 2026-10-15 实测被 sweep 连带清掉一次，`--restore` 当场 exit 1。
- **原因 B（本机 2026-10-16 实测，注意）**：备份**文件名对不上**。脚本找的是 `name.replace(/\//g, '__')` 的结果，即 `src__http.js`（双下划线）；而目录里实际躺着的是 `src_http.js`（单下划线）：
  ```
  .lane-fix-orig/client.js    → 存在
  .lane-fix-orig/index.js     → 存在
  .lane-fix-orig/src__http.js → 不存在（脚本要这个名字）
  .lane-fix-orig/src_http.js  → 存在（实际名字）
  ```
  缺一份就整批不滚——`--restore` 的缺失检查在动手之前。（单下划线的来路待核：可能是人工放置或旧命名法。）
- **解法**：① 把 `src_http.js` 改名为 `src__http.js` 再 `--restore`；② 或者更稳的——直接拿仓库基线还原（见 2.5，与机器状态无关）。
- **验证**：`--restore` 打印 `已从 .lane-fix-orig/ 回滚 3 个文件。`；随后 `--dry-run` 报「7 处待应用」。

### 2.5 基线还原：`--restore` 可能会把文件换回**旧版本**

- **症状**：`--restore` 成功回滚，但包里的 `client.js` 跟当前版本对不上；`--dry-run` 报的待应用数量、甚至 `anchor-lost` 都跟升级前不一样。
- **原因**：`.lane-fix-orig/` 存的是**第一次落盘那一刻**的原文件——那一刻的包版本未必等于现在的版本。本机 2026-10-16 实测：
  | 备份文件 | 备份 sha256 | 与 v2.3.0 原文对比 |
  | --- | --- | --- |
  | `client.js` | `df7666e5…c125` | **不一致** |
  | `index.js` | `8d8a4b54…c74ff0` | 一致 |
  | `src_http.js` | `2afb523e…b866b83` | **不一致** |
  即：`--restore` 会把 `client.js` / `src/http.js` 退回备份那一刻的内容，**不等于** v2.3.0 原文。
- **解法**：要回「干净的上游原文」，用仓库里的基线，不用 `--restore`：
  ```bash
  PKG=~/.dsh/profiles/desktop/node_modules/dsh-our-free-model
  gunzip -c baseline/ofm-2.3.0/client.js.gz    > "$PKG/client.js"
  gunzip -c baseline/ofm-2.3.0/index.js.gz     > "$PKG/index.js"
  gunzip -c baseline/ofm-2.3.0/src__http.js.gz > "$PKG/src/http.js"
  ```
  注意 `src__http.js` 里的 `__` 是补丁器备份命名法，解出来要放回 `src/http.js`。
- **验证**：解压后 sha256 必须与 `baseline/ofm-2.3.0/SHA256SUMS` 三行一致；`--dry-run` 应报「7 处待应用」而不是「已应用」。
- **前置硬条件**：**先确认包版本就是 v2.3.0**——基线对应这一版，往别的版本上盖等于换文件。上游发新版后要按同法重导：`git archive vX.Y.Z <files> | tar -x`，再 `gzip -9c` 那三个文件，并同步改 `SHA256SUMS`。

### 2.6 报告 7 行，注释却写「四处补丁」

- **症状**：`--dry-run` 列出了 7 行补丁，但 `lib/ofm-patch.js` 与 `scripts/patch-ofm.mjs` 的文件头注释写的是「四处补丁 / 这四处毛病」。
- **原因**：注释是 4 处时代的旧文案，后来补到 7 处（`PATCHES.length === 7`，`PATCH_SET_VERSION = '1'`）没同步改。**以报告行数为准。**
- **影响**：只影响阅读与自查（冒烟里有一条「补丁集非空且每处都有 why」，不校验数量），不影响落盘。
- **验证**：`node -e "import('./lib/ofm-patch.js').then(m=>console.log(m.PATCHES.length))"` → `7`。

### 2.7 补丁集清单（7 处，跨 3 个文件）

补丁针对的上游症状（EAC 共付车道「测不出首字延迟」是三层叠出来的）：

| id | 文件 | 针对的上游症状 | 修法要点 |
| --- | --- | --- | --- |
| `bench-deadline` | `client.js` | 前端 bench 240s 先到时后端还在烧 300s；「测一次」按钮卡死 | 超时 240_000 → 330_000，压过后端的 300s：前端必须最后放弃 |
| `idle-clock-comment` | `src/http.js` | 空闲时钟的语义只剩一行代码，后来人看不懂 | 在 `let deadline` 旁留下判据注释（只有真帧能上弦） |
| `idle-clock-progress` | `src/http.js` | 网关每 ~15s 一个 `: keepalive` 注释帧，把空闲超时无限续命 → 上游永不出字也不放弃 | 只有真帧（`emit` 返回 true）才重置 deadline |
| `bare-json-is-a-failure` | `src/http.js` | 网关把错误 JSON **裸写**进 SSE（无 `data:` 前缀），`emit` 只认 `data:` → 静默丢成「0 帧、正常结束」，延迟记成总耗时 | 裸 `{`/`[` 抛 `UpstreamError`（`CODE.server`）带出上游原话；`emit` 返回布尔 |
| `bench-records-a-verdict` | `index.js` | 卡上从来没有延迟数：探测轮显式跳过 EAC 条目，`buildSummary` 又硬编码 `ttftMs: undefined` / `probedAt: 0` | 零帧抛错；测到的 `ttftMs` 写进 `availability` 并 `flush()` |
| `bench-ttft-from-measured` | `index.js` | 返回值用三元表达式兜底，零帧被记成 `ttftMs === 总耗时` | 直接用上面校验过的 `ttftMs` |
| `verdict-outlives-the-round` | `index.js` | 「从没探测过」被当成整条车道的属性，刚测到的数被「跳过」规则吃掉 | `skipped = unprobed && results[id] === undefined`：有记录的行走记录 |

- **补充**：`bench-deadline` 保的是「前端别先于后端放弃」；`bare-json-is-a-failure` 保的是「别把失败装成结果」；后两笔在 `index.js` 保的是「读到的数别被扔掉」。三处毛病单看都像「模型慢」。
- **验证**：README 记录的端到端复测——`kimi-k2.6` 从「0 帧 / ok:true / 假 ttft」变成 `✗ SERVER` 并带出上游原话（`Function '…': Not found for account '…'`）；`glm-5.3`、`gpt-oss-20b` 不受影响。

### 2.8 补丁器的验收姿势（重放验证，决定性）

- **症状**：`--verify` 绿了，但换台机器重打一遍结果对不上；或者手改过一次注释，怎么重放都差几行。
- **原因**：**手改过的注释也算补丁**——第一次就栽在这。补丁集没收录它，重放结果自然对不上落盘文件。
- **解法/验证**：
  1. 拿 `.lane-fix-orig/`（或 `baseline/ofm-2.3.0/`）三份原始文件搭一个干净包 → 跑补丁器 → 与真实落盘结果 `cmp`，**三个文件必须逐字节一致**；
  2. 再跑一次应报「7 处已应用，0 个文件待改」（幂等）；
  3. 破坏性用例要落在**未打补丁的原文**上——对着已应用的文本做 `replace` 会空转，锚点其实还在，用例假绿（冒烟里专门有 `用例自检｜破坏后锚点确实不在了` 防这个）。

## 三、指纹规范化相关的坑

### 3.1 装了中间层，还是 403 —— 第四道门在传输层

- **症状**：`403 FreeTierError`，无论头怎么改都过不去。
- **原因**：`opencode.ai` 还看**传输层指纹**（TLS ClientHello / HTTP2 帧），中间层改的是 HTTP 头，原理上够不到。决定性对照（2026-10-14 夜，代理 7890 同一出口 IP）：真 opencode CLI 走代理 4/4 次 200 出话；把它真实捕获的头（UA `opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`、`x-opencode-client: cli`、`x-opencode-session: ses_…ffe…`、`x-opencode-session-id`、`x-opencode-request: msg_…`、`authorization: Bearer public`）+ 完整 body，用 node fetch / node http2（ALPN 确认 h2）/ curl --http1.1 / bun 1.4.3 / bun 1.3.14 / node:https 走 CONNECT 隧道重放——**全部 403**，node 直连与走代理结果相同。
- **解法**：要过这道门必须复制真客户端的 ClientHello 指纹（uTLS / curl-impersonate / tls-client 一类）；改头类中间层做不到。本插件因此把免费车道这条线归为「客户端姿态封锁」，不再往里投工。
- **验证**：真客户端经代理能 200、你的客户端把头改到逐字节一致仍 403——两条对照就能定案。

### 3.2 探针怎么改都是 403，误判成「补丁无效」

- **症状**：试遍所有头变体、全 403，一度判 lane-fix 没用。
- **原因**：这些门是 **AND**，少一道就分不清是哪道在拒；第一轮用裸 body（无 `tools`）量矩阵，量出来的全是废数据——补上 tools 门后立刻分晓。
- **解法**：先用真客户端（opencode CLI）走 MITM 中继**逐字节转发拿到 200 基线**，再**单变量回退**定判据（只换 UA → 403、只换 session → 403；换 body／删 `x-opencode-session-id`／改 `x-opencode-client` → 200）。
- **验证**：每一格都能单变量复现，才写进文档/代码。

### 3.3 UA 那道门的真实边界（本机逐格实测，比 PR 描述更细）

- **症状**：以为「UA 里只要出现 deepseek-harness 就拒」或「剥掉版本号就够了」。
- **原因**：实际是**两件事同时在**：
  ① 拒的是 `deepseek-harness/` **+ 斜杠 + 版本号**这一个组合：`deepseek-harness/2.2.0` → 403、`deepseek-harness/v2.2.0` → 403、`DEEPSEEK-HARNESS/2.2.0` → 403；而 `deepseek-harness`（无版本）、`deepseek_harness/2.2.0`（下划线）、`dsh/2.2.0` 全放行。
  ② **UA 必须含 `opencode/<版本>` token**——`myapp/1.0`、`node`、空 UA 一律 403，加 `opencode/1.19.0` 即 200。
- **解法**：本层两件事一起做：剥版本号（`/\bdeepseek-harness\/[^\s)]*/gi` → `deepseek-harness`，保住归属本身）+ 缺 `opencode/` 时补 `CLIENT_UA = 'opencode/1.18.31'`。
- **验证**：`node scripts/smoke.mjs` 里的 UA 组断言（含 `下划线变体带版本 → 不动`、`无版本号的归属 → 不动`）。

### 3.4 `tools` 字段整个缺席也 403

- **症状**：纯文本轮次（body 里根本没有 `tools`）照样 403，哪怕头全对。
- **原因**：车道不看「有没有工具」，只看**声明的名字**：`bash` 与 `read` 必须同时在场、各自 schema 至少一个 property（只其一 → 403，`properties: {}` → 403，`tools: []` 同）。上游 `applyFingerprint` 处理了工具名，但没保证 `read` 在场、也没保证 schema 非空——0.3.1 补的就是这个缺口。
- **解法**：`normalizeTools()` 无条件补指纹（只对带 `model` 的像是聊天请求的 body 动手）：补 `FINGERPRINT_TOOLS = ['bash','glob','grep','read']` 里的缺项（诱饵），空的 schema 补一个 property；**请求本来一个客户端工具都没有时**，把 `tool_choice` 锁成 `'none'`（否则模型可能真去调诱饵）。
- **验证**：冒烟断言 `没有 tools 字段 → 照样补指纹` + `tool_choice 锁成 none` + 幂等。

### 3.5 极少数请求仍旧 403（约 0.39%）

- **症状**：整体通了，但偶尔单条 403。
- **原因**：判据是「低 12 位能否还原出一个小序号」，sha256 摘要派生头撞进合法区间的概率约 `16/4096 ≈ 0.39%`。放宽到 `0x800` 会让一半摘要头被误判成合规、一半探测照旧 403，所以不放宽。
- **解法**：接受这点漏改；下游探针会把它记成 `unknown`，等下一轮。
- **验证**：`SEQ_MAX = 15` 与 `looksTimeEncoded` 的边界断言。

### 3.6 `stream:false` 全合规也被拒

- **症状**：头、body 全对，非流式请求仍 403。
- **原因**：车道**只认流式**（会话/请求 id 的时间编码语义也建立在流式轮次上）——这是车道本身的约束，不是本层的职责。
- **解法**：不要试图在中间层把它改写成流式（会改变调用方语义）。
- **验证**：同一请求改 `stream:true` 后 200；本层对它的改写列表不变。

### 3.7 探针报 `Model is unavailable.` 被误读成闸门拒签

- **症状**：探针拿到 `400 {"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}`，被当成「车道在拒」，进而推出「还看出口/TLS 维度」的错误结论。
- **原因**：当时用的探针模型 `ling-3.1-flash-free` 已被上游下架。
- **解法**：**探针模型必须从当轮 `/inference/v1/models` 清单里取**——用下架模型量出来的矩阵是废的。
- **验证**：换清单内在售模型重跑，`400` 消失。

### 3.8 bili 报 `nested re-entry into the bili fetch chain`

- **症状**：`nested re-entry into the bili fetch chain detected (#1662) — a coexisting plugin re-wrapped bili's own chain`。
- **原因**：本层的中间层包了 `globalThis.fetch`，与别的包装器叠了一层。实测**无害**：bili 在最老活锚点终止下潜、请求深度恒定，不阻塞、不改历史、不进 conflicts 台账。
- **解法**：不用管。想彻底避免就卸载插件（`ctx.effect` 登记过，卸载即恢复原 `fetch`）。
- **验证**：告警不重复升级成错误；bili 请求正常返回。

### 3.9 边界纪律（别越界，越界比不过门更糟）

- **只碰一个主机**：白名单写死 `opencode.ai`，其它请求（别的提供方、你自己的 API）**逐字节透传**，连 `init` 对象都不换；且**必须有车道标记头**（`x-opencode-session` / `x-opencode-request`）才动手，已合规的请求一律放行（`normalizedRequest` 返回 `null`）。
- **body 只在能安全改时改**：工具指纹只对 `body` 是 JSON 字符串的请求生效，`ReadableStream` / `FormData` / 空体一律跳过、不猜不造；**任何一步出错只 warn**，原样放行——车道宁可 403，也不该因为我们抛错而让整轮失败。
- **验证**：`node scripts/smoke.mjs`（挂载/卸载、重复装配不叠 wrapper、非车道请求 `init` 未被包装）。

## 四、与 dsh-our-free-model 的版本联动

### 4.1 版本矩阵（判据真值表）

| 上游版本 | 端点 | `x-opencode-session-id` | UA 剥离 | 结论 |
| --- | --- | --- | --- | --- |
| 2.1.0 | `/zen/v1` | 无 | 无 | 一道门都不满足，整条车道（探测 + 对话）全 403 |
| `v2.2.0` 标签 | `/zen/v1` | 无 | `src/http.js` 无剥 UA 处理 | 同上（修复只活在 `main`） |
| `v2.3.0`（commit `ac4c55e`） | `src/upstream.js` 里 `/inference/v1` 出现 7 处 | 3 处 | `src/http.js:374` 有 `UA_REFUSED = /deepseek[-_]harness/gi` | 上游自带全部五道门修法 → **本层对它是空操作** |

- **验证空操作**：对 2.3.0 的合规请求，`normalizedRequest` 返回 `null`（零改动）；2026-10-15 现场复测用上游 `main` 的 `src/upstream.js` 当活体探针（`endpointFor()` 返回 `/inference/v1/chat/completions`、`gatewayHeaders()` 含 `x-opencode-session-id`、`mintSessionId()` 头形状合规），200 出流。

### 4.2 装了新版上游，插件还要不要留

- **症状**：上游升到 2.3.0 后，日志里不再出现 `已规范化车道请求 #n`，怀疑插件坏了。
- **原因**：不是坏了，是**自动让路**——对已经合规的请求本层是空操作（设计要求）。
- **解法**：留着无害；对旧版机器、以及上游将来再动判据时它仍然是那道保险。不需要撤。
- **验证**：手工构造一条 `x-opencode-session` 未规范的请求，仍能被拦下改写（`stats().rewrites` 增长）。

### 4.3 补丁集与基线都绑定 v2.3.0

- 补丁锚点、`baseline/ofm-2.3.0/*.gz`、`SHA256SUMS` 三份都是 v2.3.0 的。上游发 v2.4.0 后：先按 2.5 的取法重导基线，再逐处核对锚点（可能要升 `PATCH_SET_VERSION`）。
- **验证**：`--dry-run` 在干净新版上应报「7 处待应用」；报 `anchor-lost` 就是锚点真的变了。

### 4.4 `ofm-upstream` 分支：留档，别合进 `main`

- **症状**：看到远程有 `origin/ofm-upstream`，想合进 `main` 顺手带走。
- **原因**：那是一条**留档用的历史切片**，顶端是原始 commit `6bcf2e6`（SHA 与工作副本那笔完全一致，未 cherry-pick 重写），带着上游 424 个 commit 的完整祖先链——合进来会让 `src/http.js`、`src/upstream.js` 凭空长出一份上游源码副本。
- **它是什么**：我们本地领先上游 `main`（基线 `8c810d1`）的 3 个实质 commit：
  `0d06056`（12 位 hex 头改用规范时间编码 `~(ms×0x1000+seq)`，摘要只喂 14 字节尾巴）、
  `af5c444`（派生 request id 计数器 clamp 到 12 位 `& 0xfff`）、
  `6bcf2e6`（`userAgentWith()` 剥掉 `deepseek-harness/<版本号>` token）。
- **为什么推不上去 / 没建 fork**：上游 `main` 已经用等价（更简洁）的写法覆盖了这三点（`UA_REFUSED`、`mintSessionId()` 直接铸时间编码、request id 固定 `+1n` 压根不递增）。这 3 笔的**活代码价值为零**，同样的修法已经活在 `lib/lane.js` 里。
- **真要用的姿势**（只对旧的 `v2.2.0` 有意义，**别在 `node_modules` 部署副本上打**——那份已是 `main` 代码，打上去只会冲突）：
  ```bash
  git apply --check docs/ofm-upstream-patches.patch   # 先验
  git apply docs/ofm-upstream-patches.patch
  ```
- **取用**：`git fetch origin ofm-upstream && git log --oneline -5 origin/ofm-upstream`（不方便 clone 时用 `docs/ofm-upstream-patches.patch` 兜底，两者对应同一批改动）。

### 4.5 两条线「都打不通」但性质完全不同，别混

| | 免费车道（opencode.ai） | EAC 共付车道 |
| --- | --- | --- |
| 性质 | 客户端姿态封锁（有门，五道 AND + 传输层指纹） | **根本没有门**，是自家网关 `ourfreemodel.beichenapi.com/eac/v1` 的上游 provider 挂了 |
| 现象 | `403 FreeTierError` | HTTP 500，301s 后 `upstream returned non-SSE response`；或 `glm-5.3-flash` / `deepseek-v4.1-flash` 300s 内零数据帧 |
| 能修吗 | 改头够不到（要 uTLS 类）；补丁器只能修面板的「不喊疼」 | 客户端怎么改 body 都一样，**只能等网关修**；补丁让慢模型**如实失败**，不会让它们变快 |

### 4.6 包内还有别的补丁器，别搞混

- 本机 `vendor/channel-pack/` 下除 `pack.js`（2.88MB，2026-10-16 实测）外还有一串 `pack.js.bak-*` 备份——`bak-ofm-patch-<YYYYMMDD-HHMMSS>`、`bak-codearts-diag-*`、`bak-codearts-sig-*`、`bak-false-risk-*`，那是围绕**上游渠道适配器构建产物**的另一套补丁工作留下的，命名法与 lane-fix 的 `.lane-fix-orig/` 不同，两回事。
- **注意**：`pack.js` 是构建产物，改 `src/*.ts` 不生效——但这指的是上游**渠道适配器**那类补丁；lane-fix 补丁集的目标是包根的 `client.js` / `index.js` / `src/http.js`，三者互不替代。
- **验证**：跑 lane-fix 的 `--dry-run`，它只认那三个文件；`pack.js` 不在 `PATCHED_FILES` 里。

## 五、关键路径与配置落点

### 5.1 路径（2026-10-16 本机实测值）

| 项 | 值 |
| --- | --- |
| 本插件仓库 | `D:\DeepSeek Harness\Works\dsh-maid-lane-fix` |
| 插件安装点 | `~/.dsh/profiles/desktop/node_modules/dsh-maid-lane-fix`（junction → 工作副本；`web` profile 未装） |
| 上游包（profile 内） | `~/.dsh/profiles/desktop/node_modules/dsh-our-free-model`（junction） |
| 上游包（真实落点） | `D:\Downloads\dsh-our-free-model-2.1.0`（目录名旧，`package.json` 已是 `2.3.0`；**不是 git 仓库**） |
| 补丁备份目录 | `<包目录>/.lane-fix-orig/`（实测内容：`client.js`、`index.js`、`src_http.js`） |
| 还原基线 | `baseline/ofm-2.3.0/{client.js.gz,index.js.gz,src__http.js.gz}` + `SHA256SUMS` |
| 上游补丁档案 | `docs/ofm-upstream-patches.md` / `docs/ofm-upstream-patches.patch` |
| 补丁落点（3 文件） | `<包目录>/client.js`、`<包目录>/index.js`、`<包目录>/src/http.js` |
| 可用度数据源 | `$DSH_HOME/our-free-model/availability.json` |
| profile 目录 | `~/.dsh/profiles/{desktop,dev,web}` |

`baseline/` 与 `docs/` **故意不在 `package.json` 的 `files` 白名单**：`git clone` 看得到、`pnpm add` 装不到——它们随插件仓库走版本控制，是档案不是运行时要用的东西。

### 5.2 关键常量（改动前先读这里）

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `DERIVED_EPOCH` | `1767225600000` | 会话 id 时间编码的固定纪元（2026-01-01T00:00:00Z，保证跨重启稳定） |
| `SEQ_MAX` | `15` | 序号位上限，即「像不像真客户端铸的头」的判据 |
| `CLIENT_UA` | `opencode/1.18.31` | 缺 `opencode/` token 时补上的客户端令牌 |
| `LANE_HOSTS` | `['opencode.ai']` | 唯一会碰的主机 |
| `LANE_PATH_FROM` / `LANE_PATH_TO` | `/zen/v1/` → `/inference/v1/` | 端点改写 |
| `REQUIRED_TOOLS` / `FINGERPRINT_TOOLS` | `['bash','read']` / `['bash','glob','grep','read']` | 必查工具 / 补齐用的四个 |
| `PATCH_SET_VERSION` | `'1'` | 补丁集版本（上游结构变了就升它） |
| `BACKUP_DIR` | `.lane-fix-orig` | 落盘前的原文件备份目录 |
| `INSTALL_MARK` | `Symbol.for('dsh-maid-lane-fix.installed')` | 防重复装配的全局标记 |
| 本插件版本 | `0.3.1` | 与 `package.json` 一致 |

### 5.3 系统约束（装之前知道，省得排查）

- 零运行时依赖：不 import 任何 `@deepseek-ai/*`，`inject` 空数组，不注册路由、不带客户端半边——宿主缺服务时它也照常工作。
- `cordis.patch.yml` 只插一行（`id: lane-fix`，`name: 'dsh-maid-lane-fix'`），没有 config。
- 宿主侧插件 + 改第三方文件：**两条路都要重启 DSH**。

## 六、排查手法

按这个顺序走，基本不用猜：

1. **先体检，别先落盘**：`node scripts/patch-ofm.mjs --dry-run`。三种状态字形一眼分：`✓ 已应用` / `· 待应用` / `✗ 锚点失配`。
2. **落盘后必验**：`node scripts/patch-ofm.mjs --verify`。它不比对「看起来像」，而是逐字节核对落盘结果与补丁集一致；不过就 `exit 1`。
3. **跑冒烟**：`node scripts/smoke.mjs` —— 本机 2026-10-16 实测 `117 PASS / 0 FAIL`（README 说的「118 条」含下面那条需要 `OFM_DIR` 的分支，plain 模式不跑它，所以是 117）。
   追加真实上游分支：`OFM_DIR="D:/Downloads/dsh-our-free-model-2.1.0" node scripts/smoke.mjs` —— 在**未打补丁**的包上会红一条，这是预期的：
   `FAIL 真实上游：全部已应用 ["bench-deadline=ready","idle-clock-comment=ready",…]`
   打上之后应全部 `applied`。这条是「包到底打没打」的一键判据。
4. **核基线**：冒烟里已含 `baseline/ofm-2.3.0/*.gz` 解压后逐个核 sha256（对 `SHA256SUMS`）；手工核也行：
   ```bash
   cd "$PKG" && sha256sum client.js index.js src/http.js
   ```
   与清单三行一致 = 干净的上游 v2.3.0 原文。
5. **逐字节比对重放结果**：`cmp` 重放文件与真实落盘文件，三份全等才算通过（见 2.8）。
6. **确认补丁进没进内存**：比宿主进程启动时间与探测结果 `at` 时间戳（见 1.4）——别靠「改完应该好了」的感觉。
7. **量车道判据**：真客户端走 MITM 中继逐字节转发拿 200 基线 → 单变量回退 → 每格可复现才写结论；探针模型从当轮 `/inference/v1/models` 清单取（见 3.2 / 3.7）。
8. **锚点失配疑似「行尾」问题**：本机有过 CRLF 行尾让替换工具命中 0 次的记录（全局教训，非本仓专属）——先确认目标文件行尾，必要时用 Node 脚本做精确匹配，别用会规整行尾的编辑器盲改。
9. **别对着已应用的文本做破坏性用例**：锚点其实还在，用例会假绿（冒烟里专门加了自检断言）。破坏必须落在未打补丁的原文上。

## 暂未遇到（留给以后填）

- 补丁集跨大版本（v2.4.0+）的迁移实录：暂未遇到（上游尚未发新版）。
- 在 macOS / Linux 上的安装与路径差异：暂未遇到（本记录全部来自 Windows 本机）。
- 中间层与其它 `globalThis.fetch` 包装器的真实冲突（除 bili 那条无害告警外）：暂未遇到。
