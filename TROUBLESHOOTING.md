# dsh-maid-lane-fix · 问题与解决记录

> 用途：**新设备安装 / 重装 / 上游升级后**的排查手册。分三趟活：装插件（中间层）、跑补丁器（改上游字节）、验完了确认真的生效。
> 每条按「症状 → 原因 → 解法 → 验证」写；症状照抄实际报错或现象，命令都是可复制的具体值。
> 只写有据可查的；没素材的地方写「暂未遇到」，不确定的标「（待核）」。
> 最后更新 2026-10-19（本机实测口径：`dsh-our-free-model` 2.5.3 + lane-fix 0.3.3；**2026-10-19 补 2.14 profile 层 patch 缩进事故**）。
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
- **解法**：`node scripts/patch-ofm.mjs --dir <包目录>`。本机是 junction，脚本会 `realpath` 解开：`~/.dsh/profiles/desktop/node_modules/dsh-our-free-model` → `D:\DeepSeek Harness\Works\_vendor\dsh-our-free-model-2.5.1`（2026-10-17 搬迁后的位置；旧位置是 `D:\Downloads\dsh-our-free-model-2.1.0`）。
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

- **症状**：看到包目录名带版本号，以为补丁打在别的版本上；或在旧资料里看到 `dsh-our-free-model-2.1.0` 这个路径，找不到包。
- **原因**：本机包目录是早期 clone 留下的名字，内部 `package.json` 早已升级。**2026-10-17 已搬迁并改名对齐版本**：现行落点 `D:\DeepSeek Harness\Works\_vendor\dsh-our-free-model-2.5.1`（内部 `version` = `2.5.1`）；`D:\Downloads\dsh-our-free-model-2.1.0` 是历史路径，已不存在。搬迁同步改了四处：物理目录、profile `package.json` 的 `link:`、junction、两个 lockfile。
- **解法**：一律以 `package.json` 的 `version` 为准，路径只认现行 `_vendor` 落点。
- **验证**：`grep -m1 '"version"' "$PKG/package.json"`。

### 1.7 用 `node --input-type=module -e` 内联 import 补丁清单，报 `ERR_UNSUPPORTED_ESM_URL_SCHEME … Received protocol 'c:'`

- **症状**：想在命令行里直接取 OFM 的补丁清单做核对，一条 `node -e` 直接抛（原样）：
  `Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. On Windows, absolute paths must be valid file:// URLs. Received protocol 'c:'`
  栈顶是 `at throwIfUnsupportedURLScheme (node:internal/modules/esm/load:193:11)`。
- **原因**：**已定位，不是补丁或插件的问题，是取值姿势的问题**。肇事命令把 Windows 绝对路径直接当 ESM specifier：`node --input-type=module -e '… import { PATCHES } from "C:/…/.dsh/our-free-model/patchkit/patches.mjs" …'`。ESM 的 `import` 只吃 URL，Windows 盘符 `C:` 被当成协议名解析，于是撞出这个错。
- **解法**：把路径转成 file URL 再动态 import——`const mod = await import(url.pathToFileURL('C:/…/patchkit/patches.mjs').href)`；或 `createRequire(import.meta.url)('C:/…/patches.mjs')`（清单是 ESM 时用前者）。也可以先 `process.chdir()` 到目录再用相对路径 `import('./patchkit/patches.mjs')`。
- **验证**：本机实测（2026-10-19）——原命令报上面那条 `ERR_UNSUPPORTED_ESM_URL_SCHEME`；改成 `pathToFileURL(...).href` 后输出 `ok PATCHES,PATCH_TARGET,WATCHPOINTS`，不再抛错。**未验证**本仓脚本内部是否也有同样写法（只查了这一条现场命令）。
- 教训：**报错说「协议不对」时，先看自己把什么塞进了 `import`**——Windows 路径在 node 生态里从来不等于 URL。
> 证据：会话 `3a746e63` #352（tool/result 报错）+ 同会话 #347（tool/call，`node --input-type=module -e` 原文）；本机 2026-10-19 复现与修复各一次；全库 `ERR_UNSUPPORTED_ESM_URL_SCHEME` 此前零命中（候选 `_r3-session.md` S12）

## 二、补丁打不上 / 打上无效（上游版本变了怎么办）

### 2.1 锚点失配，整批中止（最常见的一种）

- **症状**：
  ```text
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
- **本机实测（2026-10-18 20:15）**：上游包被整包覆盖，**两套补丁同时掉光**。①`scripts/patch-ofm.mjs --verify` → exit 1，11 处**全部**「待应用」，末行 `有 11 处不是"已应用"状态——落盘结果与补丁集不一致。`；四个目标文件（`client.js` / `index.js` / `src/http.js` / `src/eac.js`）现役 sha256 与 `baseline/ofm-2.5.3/SHA256SUMS` **逐字节相等**（`7a437757…` / `3bc572ed…` / `982a5bef…` / `359f5729…`），即干净未打状态；四文件 mtime 同为 `2026-10-18 20:15:45`。②`vendor/channel-pack/pack.js` 同样回到原文：现役 `2913003` 字节、sha256 前 16 位 `77c34f07049532fa`，与 `10-18 01:26:57` 那份「打补丁前的原文备份」**完全相同**，而与 `10-18 15:28:51` 打过补丁的那份（`2913768` 字节 / `28d763a7adae9817`）不同；关键词计数 `swap-min-interval` 0、`benefit-bare-4004` 0、`codearts-signed-headers` 0、`codearts-signed-decl` 0，而上游自带的 `InferHub.4004.200` 仍在（1 次）。`.lane-fix-orig/` 四份备份此时也已等于干净原文，**`--restore` 回滚不出打过补丁的状态**（回到 2.5 那条的坑）。
- **注意**：20:15:45 这次覆盖的**触发者未取证**（是 pnpm 重装、包内自愈升级还是人工操作，没留下可判定的证据），所以只写「被上游覆盖」，不写「被谁覆盖」；也未比对进程 StartTime 与文件 mtime，**不宣称**当前宿主会话在跑的是补丁版还是原文版。
- **解法**：重跑 `node scripts/patch-ofm.mjs`，重启 DSH。
- **补一步（2026-10-18）**：那次是**两套同时掉光**，车道侧还要另外重打 `node ~/.dsh/our-free-model/patchkit/scripts/patch-pack.mjs`（不在本仓 `scripts/` 下），两套都打完再重启——只补一套等于没补。
- **验证**：`--verify` 输出 `全部已应用，且落盘字节与补丁集完全一致。`

### 2.4 `--restore` 报「没有备份，无法回滚」

- **症状**：`没有备份，无法回滚：src/http.js`（exit 1）。
- **原因 A**：`.lane-fix-orig/` 被清掉了。它只在**第一次落盘前**生成，且随时可能被清（`node_modules` 重装、上游升级覆盖、清理脚本扫过）——本机 2026-10-15 实测被 sweep 连带清掉一次，`--restore` 当场 exit 1。
- **原因 B（本机 2026-10-16 实测，注意）**：备份**文件名对不上**。脚本找的是 `name.replace(/\//g, '__')` 的结果，即 `src__http.js`（双下划线）；而目录里实际躺着的是 `src_http.js`（单下划线）：
  ```text
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
- **解法**：要回「干净的上游原文」，用仓库里的基线，不用 `--restore`。**基线按版本分目录，用与包版本一致的那一份**（现行 `baseline/ofm-2.5.0/`）：
  ```bash
  PKG=~/.dsh/profiles/desktop/node_modules/dsh-our-free-model
  gunzip -c baseline/ofm-2.5.0/client.js.gz    > "$PKG/client.js"
  gunzip -c baseline/ofm-2.5.0/index.js.gz     > "$PKG/index.js"
  gunzip -c baseline/ofm-2.5.0/src__http.js.gz > "$PKG/src/http.js"
  ```
  注意 `src__http.js` 里的 `__` 是补丁器备份命名法，解出来要放回 `src/http.js`。
- **验证**：解压后 sha256 必须与 `baseline/ofm-2.5.0/SHA256SUMS` 三行一致；`--dry-run` 应报「7 处待应用」而不是「已应用」。
- **前置硬条件**：**先确认包版本与基线目录一致**——基线对应特定一版，往别的版本上盖等于换文件。上游发新版后要按同法重导：`git archive vX.Y.Z <files> | tar -x`，再 `gzip -9c` 那三个文件，新建 `baseline/ofm-<新版>/` 并写 `SHA256SUMS`（冒烟按目录扫，不用改脚本）。

- **补充（2026-10-18，`.gitattributes` 锁基线字节——未复现的预防性加固）**：
  - **事实**：提交 `a862ce7`「chore: 加 .gitattributes 锁住基线字节」只新增 7 行：`*.gz binary` 与 `baseline/**/SHA256SUMS text eol=lf`（附三行中文注释）。动机是提交正文自陈的，**本机未取到任何字节漂移的现场**——这条不是事后复盘，是事前加固。
  - **对照实验（未复现）**：临时仓里放一份 CRLF 的 `SHA256SUMS` 与一个 256 字节假 `.gz`，分别在「有 `.gitattributes`」与「删掉 `.gitattributes`」两种情形下用 `core.autocrlf=true` 检出并比对：两边的 `SHA256SUMS` **sha256 完全相同**（无 CR 字节），`.gz` 也是 256 字节原样。
  - **机制（为什么正常路径不会漂）**：`core.autocrlf=true` 的转换发生在**入库与检出两端**，一旦入库内容已被归一为 LF，检出端不会再吐出 CRLF——所以只靠 autocrlf 通常坏不了文本文件的字节。真正会坏字节的是另一条路：**`.gz` 被当成文本处理**（二进制启发式判定失手时会走文本转换）；`*.gz binary` 这条声明才是主要价值所在，`SHA256SUMS text eol=lf` 属于把解析器的期望显式钉死。
  - **验证**：未验证 / 未复现。若要真复现漂移，最小判据是：仓库里存一份**含 CRLF 入库**的文本（即入库时未经归一）+ 一个扩展名不被识别为二进制的压缩包，再用 `core.autocrlf=true` 克隆对比 sha256——只有在这种前置条件下才可能看到差异。
  - **教训**：加固提交的标题容易在后来被读成「以前真出过事」。写这类条目必须把「动机自陈」与「已复现的故障」分开写，否则半年后会有人照着它去查一场从未发生的漂移。

### 2.6 报告 7 行，注释却写「四处补丁」

- **症状**：`--dry-run` 列出了 7 行补丁，但 `lib/ofm-patch.js` 与 `scripts/patch-ofm.mjs` 的文件头注释写的是「四处补丁 / 这四处毛病」。
- **原因**：注释是 4 处时代的旧文案，后来补到 7 处（`PATCHES.length === 7`，`PATCH_SET_VERSION = '1'`）没同步改。**以报告行数为准。**
- **影响**：只影响阅读与自查（冒烟里有一条「补丁集非空且每处都有 why」，不校验数量），不影响落盘。
- **解法**：以代码常量 `PATCHES.length` 为唯一真值改注释；**以后每次增删补丁集都要同步改这两处文件头注释**，别再让文案落后于数组。
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

### 2.9 只想查用法，`--help` 却把补丁真打进了运行包

- **症状**：跑 `node scripts/patch-ofm.mjs --help` 想看用法，屏幕上却是体检表 + `写入 client.js（454383 字节）`——**运行包被改了**。
- **原因**：补丁器 v0.3.1 及以前**不校验参数**，`argValue` / `has` 只认自己认识的那几个旗标，其余一律静默忽略，然后一路走到**默认动作（体检 + 落盘）**。于是 `--help`、`-h`、以及打错一个字母的 `--dryrun`，全都等价于「不带参数运行」＝ 真改文件。更糟的是 `.lane-fix-orig/` 里已有一份**旧版本**的原文备份（见 2.5），`--restore` 会把文件换回旧版而不是干净原文。
- **解法**：v0.3.2 起脚本先做参数白名单校验——只认 `--dry-run / --verify / --restore / --dir / -h / --help`（`--dir` 的取值是裸路径，从待检列表里摘掉），**任何不认识的参数直接报错 `未知参数：xxx` 并 exit 2，绝不落到默认动作**；同时补上 `-h/--help` 只打印用法、exit 0。修完当场用真实运行包验证 `--help` / `-h` / `--dryrun` 三条，并核对三份文件 sha256 与基线一致（未被写脏）。
- **验证**：`node scripts/patch-ofm.mjs --help` 只出用法、`git status` 里包目录无改动；`node scripts/patch-ofm.mjs --dryrun` 报 `未知参数：--dryrun` 且 exit 2；`node scripts/patch-ofm.mjs --dry-run` 报「0 处已应用，3 个文件待改」+「（--dry-run，未写盘）」，随后 `sha256sum client.js index.js src/http.js` 与 `baseline/ofm-2.3.0/` 的 `SHA256SUMS` 逐行一致。

> **通用教训**：任何「默认动作会写盘」的脚本，都必须先做参数白名单校验。查询类旗标（`--help`）被静默忽略、反而触发写盘，是比锚点失配更难查的一类事故——它不报错，只是默默把文件改了。

### 2.10 EAC 长会话 HTTP 413：8 MiB 是网关限制，不是宿主限制（2026-10-18）

- **症状与硬证据**：上游 `/eac/v1/chat/completions` 对精确 8388608 bytes 的请求通过体积关、8388609 bytes 返回 HTTP 413。通过体积关不等于模型成功返回；不能声称客户端补丁解除上游限制。
- **原因**：长会话携带全量历史，请求体随轮次线性膨胀，最终撞上**上游 EAC 网关**（`/eac/v1/chat/completions`）的请求体上限——网关对 8388608 bytes 放行、8388609 bytes 直接返回 413。限制在上游那一侧，与宿主、客户端无关；因此改面板上限、改 forward 参数、改 vendor 侧本地常量统统无效，云端不认，本地常量改多大都过不去。补丁能做的只有「在签名与 transport 之前本地拦下」，把一句看得懂的中文说明交给用户，而不是让请求跑到上游吃一个裸 413。
- **修复**：补丁集 v3 共 11 处、跨 `client.js` / `index.js` / `src/http.js` / `src/eac.js`。新增 `eac-body-limit-constant`、`eac-body-limit-before-send`、`eac-413-restated`。对最终 `JSON.stringify(body)` 仅做一次 UTF-8 字节计数；只在 `> 8388608` 时于签名/transport 之前拒绝。等于上限必须放行；中文不能用字符数代替字节数。
- **报错**：本地超限与上游 413 均为简体中文说明，包含 8 MiB / 8388608 bytes 及缩短会话、移除附件或图片、新会话建议；使用 `new UpstreamError(message, CODE.client, details)`。真实 adapter 可重试集合仅含 `EMPTY_RESPONSE / SERVER / TIMEOUT / TRANSPORT`，因此 `CLIENT_ERROR` 不可重试；上游 413 不透传响应原文或 Retry-After。
- **基线与还原**：`baseline/ofm-2.5.3/SHA256SUMS` 已补 `src/eac.js`，原文 SHA256 为 `359f5729ab22bdf406c6f1c0c4817eb1a1b6f3099c07dcaeb1558503333314b5`；来源交叉核对见该目录 README。历史三文件基线保持原契约，不伪造旧版本 EAC 原文。补丁器 `--verify` 现真正按当前版本干净基线重放并逐字节核验（此前仅 marker 判定）；`--restore` 先整批校验备份等于当前版本基线，拒绝旧版/脏备份，避免 2.5 的历史事故。
- **验证**：`node scripts/smoke.mjs` → 140 PASS；设置 `OFM_DIR` 为现役安装后 → 141 PASS。`node scripts/eac-body-limit-test.mjs` → 32 PASS；`EAC_USE_INSTALLED=1 node scripts/eac-body-limit-test.mjs` → 同为 32 PASS，读取现役文件进行行为验证。覆盖 ASCII/中文的 8388607、8388608、8388609 bytes、签名字节不变、超限零 transport、正常 SSE/JSON、413 的纯文本/JSON/HTML 响应、500 分类、CLI 幂等、干净还原及错备份整批拒绝；全套真实出网次数为零。
- **本机落盘**：现役实体目录 `~/.dsh/profiles/desktop/node_modules/dsh-our-free-model`，版本 2.5.3。先备份 `src/eac.js.bak-eac-pre-2026-10-18T08-08-03-872Z`，再由现有 `scripts/patch-ofm.mjs --dir <现役目录>` 应用，仅写 `src/eac.js`（15592 bytes），其余三文件保留；`--verify` 全部 11 处通过。改后 EAC SHA256 `fe8bb92542a7e3efb3fa4768ad159f917a9c3cd583372870eff56e3722a8d4d3`。四份 `.lane-fix-orig/` 备份均与 2.5.3 基线逐字节相等；现役文件及补丁器语法检查通过。
- **运行状态**：磁盘已应用；未重启宿主、未让现有进程重新加载，故不宣称当前 GUI 会话已使用新逻辑。未提交、未 push；本次未重放真实上游大请求，边界上游证据沿用先前测量。

### 2.11 换号最小间隔补丁变成空操作（锚点被上游饱和重试分支顶掉，2026-10-18）

> 与 4.7 台账的关系：台账第 3 行记的是这条补丁**初次落盘**（`pack.js:35232` 循环内 `await sleepMs(600)`）；本条记的是它**失效后的返工与位置迁移**，两件事，不重复。

- **症状**：补丁报「已应用」、`--verify` 也认，但账号轮换依旧在限流后**数毫秒内**连续换号——原意是「换号之间至少隔 600ms」，实测换号间隔是 0，账号池被打成紧凑循环，同 IP 短时轮换多号（风控关联特征）原样复现。
- **原因**：补丁插在 `await sleepMs(waitMs)` 处，把等待改写成 `Math.max(waitMs, 600)`。上游 2.4.0 新增了**模型级饱和重试**分支（`isModelSaturationError`，报文 `14003 model busy`），该分支的 `waitMs = buddySaturationDelayMs(attempt) ≈ 2000 * n`，恒 ≥ 2000ms，于是 `Math.max(waitMs, 600)` 永远等于 `waitMs`——补丁退化成空操作：**锚点还在、行也改了、行为没变**。而真正的换号路径在 `BuddyAdapter.stream` 里（`if (this.options.accountPool && isRateLimited(errorText, response.status))`，原 `pack.js:35479-35530`），那条路径上**没有任何延迟**。
- **解法**：把锚点搬到换号真正发生的位置——`const next = await this.options.accountPool.getAvailableAccount(...)` 成功之后、`response = await this.send(credential, body, options)` 之前插入 600ms 等待，并带 abort 守卫（宿主取消时不吞掉中断）。首个请求在 `pack.js:35357` 之前发出，不经这层延迟。
- **验证**：`node scripts/patch-pack.mjs --verify` → `4 处已应用 / 0 待应用 / 0 锚点异常`；`node scripts/smoke.mjs` → `18 通过 0 失败`（2026-10-18 实测）。
- **验证命令路径更正（2026-10-19 00:2x 复核）**：`patch-pack.mjs` **不在本仓 `scripts/` 里**——本仓 `scripts/` 只有 `patch-ofm.mjs` / `smoke.mjs` / `eac-body-limit-test.mjs`。车道补丁器实际在 `~/.dsh/our-free-model/patchkit/scripts/patch-pack.mjs`，且执行时 cwd 要落在 `~/.dsh/our-free-model`（它按相对位置找 `profiles/desktop/node_modules/dsh-our-free-model/vendor/channel-pack/pack.js`）。照上面那行在仓根敲会 `MODULE_NOT_FOUND`。
- **重跑结果（2026-10-19 00:2x）**：同一命令现报 `已应用 0 / 待应用 4 / 锚点异常 0`、exit 1、末行 `尚未全部应用——跑一次不带参数的 patch-pack.mjs 落盘。`——**4 个锚点全部唯一命中、只是落盘被上游覆盖冲掉**（见 2.3 的 2026-10-18 20:15 实测）。即本条记录的打法本身没被上游升版顶掉，失效原因是「打完又被覆盖」。
- 证据：提交 `2635396`（`docs: 归档 OFM 2.5.3 两个尾项补修与可重放记录 (swap-min-interval & benefit-bare-4004)`，2026-10-18 17:15），正文 `docs/ofm-2.5.3-tail-fixes-20261018/README.md:1-204`。
- **教训**：「锚点命中 + 行已改」不等于补丁有效。上游只要在锚点附近插一个恒等变换的分支，`Math.max`、`|| 默认值`、`if (!x) x = …` 这类写法就会静默失效——验证必须验**行为**（换号间隔实测 > 0），不能只验 patch 已应用。

### 2.12 无权益账号的裸 `4004` 被当成 `INVALID_REQUEST`，摘戳重试落空（2026-10-18）

> 与 4.7 台账的关系：台账第 5 行记的是补丁**初次落盘**（判定加 `|| data.error_code === "4004"`，`pack.js:33217`）；本条记的是它**为什么必须重打、以及打在哪一层才生效**。

- **症状**：带 `maas_type: "benefit"` 头的请求，上游在 **HTTP 200 的 SSE 首帧**里回业务错误；插件没有走「无权益 → 摘掉 benefit 头重试」的逻辑，而是直接抛 `INVALID_REQUEST`，v4.1-flash 一直失败。
- **原因**：上游只做**全串等值匹配**——`CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE = "InferHub.4004.200"`；实测常常只回裸 `data.error_code === "4004"`（华为云 APIG / InferHub 两种口径都出现过）。裸值匹配不上，代码落进 `throw new LlmError2(\`codearts: ${message2}\`, "INVALID_REQUEST", { status: 200 })`，外层 `error.code === BENEFIT_NOT_FOUND_CODE && isBenefitModel && !benefitHeaderDropped` 这个分支**永远不会命中**，摘戳重试自然不触发。补丁要生效必须同时改两处：判定处 + 抛错类型（只加 `||` 判断、仍抛 `INVALID_REQUEST` 的话外层照样不认）。
- **解法**：`CodeArtsAdapter.consumeSse` 内把判定扩为 `data.error_code === CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE || data.error_code === "4004" || String(data.error_code) === "4004"`，并统一抛 `BENEFIT_NOT_FOUND_CODE`，让外层重试分支能命中；两个补丁从 `WATCHPOINTS` 升级进 `patchkit/patches.mjs` 的 `PATCHES`（**升格后才会被 `--verify` 与重放核对**，留在 WATCHPOINTS 里等于没人管）。
- **验证**：`--verify` 报 4 处已应用、`smoke` 18/18 通过；`pack.js` 由 `2765888` 字节变为 `2766877` 字节，打补丁前备份 `pack.js.bak-repatch-20261018-171346211`（2026-10-18 实测）。命令的真实路径与 2026-10-19 的重跑结果见 2.11 的「验证命令路径更正」——与换号补丁同落盘、同被覆盖，两者一起掉。
- 证据：提交 `2635396`，正文 `docs/ofm-2.5.3-tail-fixes-20261018/README.md:90-140`。
- **教训**：上游同时存在「全串错误码」与「裸错误码」两种口径时，只按文档里的全串写判据必然落空；判据写宽之后还要确认**抛出的错误类型**能触发外层分支，否则前面改了也白改。

### 2.13 备份被写成 `.patched-<时间戳>` 后缀，`--restore` 随之失效（安装包缺基线，2026-10-19）

- **症状**：`.lane-fix-orig/` 里躺着的是 `client.js.patched-2026-10-19T04-18-59-427Z` 这类带时间戳的名字，而不是常规的 `client.js`；于是 `--restore` 报「没有备份，无法回滚」（同 2.4 的表现，**但成因完全不同**）。补丁本身是好的——`--verify` 照常 EXIT=0、11 处已应用、落盘字节与干净基线重放逐字节一致。
- **原因**：**装包时序事故**。`patch-ofm.mjs:235` 的常规名条件是合取式 `baseline !== null && files[name] === baseline.files[name]`，只要 `baseline === null` 为假，就落 `:239` 的 `.patched-<stamp>` 分支。而 `baseline` 目录**不在 `package.json` 的 `files` 白名单里**，先前装进 `node_modules` 的安装版**不带基线**，`loadBaseline()` 找不到就返 `null`。
  本机时间线（2026-10-19）：
  ```text
  11:30:57  OFM 2.5.3 整包解包（干净原文落盘）
  12:17:54  clone lane-fix 工作树（含 baseline/）
  12:18:24  lane-fix 装进 node_modules —— 包内不含 baseline/
  12:18:59  跑脚本：baseline = null → 4 份落 .patched-*，覆盖打补丁
  12:19:08  baseline/ 才被补进安装目录（事后手工补的）
  ```
  两条物证：备份的 sha256 与 `baseline/ofm-2.5.3/SHA256SUMS` **逐一相等**（原文没错，只是名字撒了谎）；4 份时间戳毫秒级同刻（`04-18-59-427Z` = 北京 `12:18:59.427`），说明是同一进程一次算出，排除分批或人工放置。
- **解法**：把 `baseline` 加进 `package.json` 的 `files` 字段（本仓 2026-10-19 已修）：
  ```json
  "files": ["index.js", "lib", "baseline", "scripts", "cordis.patch.yml", "README.md", "LICENSE", "assets/plugin-icon.png"]
  ```
  **不改的话每次重装都会复发**——从安装版跑就会缺基线。要打补丁又想有常规名备份，就从**工作树**跑脚本（工作树里 `baseline/` 一直在）。
- **验证**：① `node -e "console.log(require('./package.json').files)"` 或 `pnpm pack --dry-run`（注意本仓无 prepack，不会触发构建）确认清单里出现 `baseline`；② 装完后 `ls node_modules/dsh-maid-lane-fix/baseline` 有内容即修好；③ 再从安装版跑 `--dry-run`，若备份落到常规名 `client.js` 而非 `.patched-*`，说明 `loadBaseline()` 已能读到基线。
- **注**：`.lane-fix-orig/` 里那 4 份 `.patched-*` **内容就是干净原文**（哈希已验），要还原可直接改名去掉后缀，或用 `baseline/ofm-2.5.3/` 解压覆盖（见 2.5）。
- **教训**：备份名撒谎不等于备份坏——**先比哈希再判死刑**。另外「`files` 白名单漏目录」这类缺陷只在**安装版**暴露，工作树里一切正常，所以本仓自测必须**从安装目录跑一遍**，不能只测工作树。

### 2.14 profile 层 `cordis.patch.yml` 缩进写错 → 整份 profile 配置解析失败，**所有**面板保存全挂（2026-10-19）

- **症状**：面板上点保存，底部红字报
  `dsh: failed to parse patches $DSH_HOME/profiles/desktop/cordis.patch.yml:` + `YAMLException: bad indentation of a sequence entry (326:3)`（同一个坏文件还有 `(327:5)` 这一版）。现象**看起来像某个插件的保存按钮坏了**（本次报的是 ofm 面板「api 保存不了」），实际爆炸半径是**该 profile 里所有 namespace 的设置都存不了**——profile 的 patch 层在配置加载阶段就解析失败，根本到不了保存逻辑。
- **原因**：profile 层与 bundle 层是**两套不同的 patch 语法**，混用即坏。profile 层顶层必须是 **0 缩进的扁平数组**：`- id:` 顶格、`name:` / `config:` 缩 2、子键缩 4；而包内 bundle patch 走 `- insert:` 原语、子行缩 4 格（对照 `node_modules/dsh-cost-meter/cordis.patch.yml` 271 字节、`node_modules/@sugarforever/dsh-zvec-grep/cordis.patch.yml` 298 字节）。本次是照 bundle 的写法把三行以 **2 格缩进**追加进 profile patch：

  ```yaml
    # --- 新增扩展插件 ---
    - id: cost-meter
      name: 'dsh-cost-meter'
      config:
        enabled: true

    - id: zvec-grep
      name: '@sugarforever/dsh-zvec-grep'
      config:
        enabled: true
  ```

  解析器把这三行当成上一项 `- id: xiaomi-mimo-tts` 的 `config:` 块内内容（报错点 `326:3` 正落在 `  - id: cost-meter` 上），于是整份文件 `bad indentation of a sequence entry`。
  **写入方（待核）**：那两行中文注释 `# --- 新增扩展插件 ---` / `# --- 新增增强插件配置 ---` 在 `app.asar`、`$DSH_HOME`、`D:\DeepSeek Harness` 全盘（含 storages 与会话解压内容）**零命中**，不是任何已装插件或内置代码生成的，怀疑人工或外部脚本手写。**官方写入方可排除**：asar 内 `@deepseek-ai/dsh-config-editor` 的 `ConfigEditor.edit(entry, change)` 用 `yaml.parseDocument` + `document.setIn([index,'config'])` / `document.add(document.createNode(...))`，缩进由解析器生成、写入前 `isDeepStrictEqual` 全等比对、失败即回滚——**不可能**产出坏缩进，别去查面板保存路径的 bug。
- **解法**（三步，第三步才是干净的收尾）：
  1. 备份：`cp cordis.patch.yml cordis.patch.yml.bak-<用途>-<时间戳>`。
  2. 修缩进：**整块**去 2 格，中文注释行与所有子键跟着一起归一。只改顶层 `- id:` 那行会立刻换一种错——本机实测先改 333/338 两行后报 `ScannerError: mapping values are not allowed here`（`334:9`），改到 332–341 整块才过。
  3. **删整块**（本次采用，推荐）：那两条本就是**冗余覆盖**——`dsh-cost-meter` 1.9.11 与 `@sugarforever/dsh-zvec-grep` 0.1.2 都在 profile `package.json` 的 `dsh.profile.bundles` 清单里，且各自 `dsh.bundle.patch = "./cordis.patch.yml"`，随 bundle 层自动挂载，profile 层再写一遍没有意义。删前 10906 B / 339 行，删后 **10723 B / 328 行**，顶层项 14 → 12。
  **为什么删比修好**：`applyEntryPatches` 对配置执行 `target[key] = value`——**整体替换，不是逐字段合并**。冗余条目里随手写的 `config: {enabled: true}` 会把包内声明的整份默认 config 清掉；删掉它，合成产物里 zvec-grep 段才恢复成包内声明的 7 项默认值（`embedding: local/potion-code-16m-v2`、`device: auto`、`defaultLimit: 10`、`maxLimit: 30`、`watchDebounceMs: 750`、`reconcileIntervalMs: 3600000`、`statusPollIntervalMs: 2000`）。顺带把混进来的行尾碎片一并归一（`replace(/\r\n/g,'\n')` + 收敛末尾换行）。
- **验证**：
  1. **解析层（决定性）**：用同方言的 YAML 解析器复验——`python -c "import yaml;d=yaml.safe_load(open('$DSH_HOME/profiles/desktop/cordis.patch.yml',encoding='utf-8'));print(len(d),[e.get('id') for e in d])"` → 修复后输出 `12` 与 12 个 id；另确认没有残留的 2 格顶层项：`grep -c '^  - id:'` = 0。（本机可用的解释器：`~/.dsh/profiles/desktop/node_modules/dsh-video-understand/.venv/Scripts/python.exe`，自带 pyyaml。）
  2. **合成层（不必重启）**：宿主用 chokidar 持续监听 profile 的 `cordis.patch.yml`，改完约 3 秒 `cordis.yml` 就被重新合成——本机 15:43:30 落盘、15:43:33 `cordis.yml` 重写为 68780 B（同日 15:25:45 那轮亦吻合）。
  3. **面板层**：本次修完**未再点一次保存（未验）**；但同一文件已被面板写过两次——`agent-default-model` 的 `model` 从 `gemini/gemini-3.8-flash` → `lobsterai/deepseek-flash` → `raccoon/sn-deepseek-v4-1-flash`，写入链路可证。
- **注**：OFM 面板的绝大多数设置**不进** `cordis.patch.yml`，它们落在 `$DSH_HOME/our-free-model/settings.json`（OFM `src/store.js` 的 `JsonStore`，写盘走临时文件 + rename，不留半截文件）；只有「默认模型」这类写 profile patch 的 `agent-default-model` 才会因 patch 文件坏而存不了。看到「面板存不了」，先把这两条落盘路径分开看。
- **教训**：① 症状像某个插件坏了，先怀疑**共享的配置层**——它一坏，全体保存全挂；② 往 profile 层追加条目**别照抄包内 bundle 的 `- insert:` 写法**，两套语法不通用；③ 冗余覆盖能删就删，少一个复发点，也免了整体替换清空包内默认值。
- 证据强度：A（报错原文、修复前后字节/行数/顶层项数、合成产物 mtime 与字节、包内两处 patch 原文均已上机核验）。
- 证据：记忆 `0mvexwp5k-ed429c9a60af4764a7b9ad71d8`（事故与修法）、`0mveygjy8-7a0dd66bc94b461698a13b2a85`（冗余判定与删后复验）、`0mvdl20cw-80f27dc9c75b4b0e831d7fed48`（两层语法对照）。

### 2.15 OFM Chat wire 遗漏 developer 角色报 400（2026-10-19）

- **症状**：请求 OFM 渠道时服务端抛错并中断会话：
  ```
  HTTP 400 Unsupported message role: developer
  code: INVALID_REQUEST
  ```
- **原因**：上游 `vendor/channel-pack/pack.js`（及独立版 `packages/standalone/channels/business.mjs`）的 Chat wire `convertMessage()` 仅处理了 `system`、`user`、`assistant`、`tool` 四种角色。而 `developer` 是 DSH 宿主的标准合法会话角色（宿主内置 `createDeveloperMessage`），同文件 Responses wire 与 `src/messages.js` 均已支持该角色，Chat wire 是唯一遗漏分支。
- **解法**：在 `pack.js:63314` 及 `business.mjs:63303` 将判断条件由 `if (role === "system")` 修改为 `if (role === "system" || role === "developer")`，使 developer 角色与 system 角色共享相同转换逻辑。
- **验证**：重启服务后向独立版 18900 端口发送 `{role: 'developer'}` 测试消息，返回 HTTP 200 且模型正确遵循开发者指令作答；对照组发送非法角色 `{role: 'banana'}` 仍按预期返回 HTTP 400。
- 来源：提交 `0c4a3a7`；记忆库 lesson `0mverqec6`；`docs/ofm-lane-fingerprint-incidents.md` 第七章。

### 2.16 OFM 2.5.5 与 2.5.7 版本错位：installedVersion 虚报 2.5.7 实际跑 2.5.5（2026-10-20）

- **症状**：插件设置面板与状态文件均显示当前已安装版本为 `2.5.7` 且不再提示升级，但运行表现与旧版相同。
- **原因**：三处证据交叉核对表明真实运行的是 2.5.5 版本：`settings.json` 的 `installedVersion` 虽记为 2.5.7，`upgrade-state.json` 虽记为 `2.5.5 → 2.5.7, activated: true`，但安装目录 `package.json` 的 `version` 仍为 `2.5.5`，核心产物 `pack.js` 为 2913003 字节（真实 2.5.7 应为 2926187 字节）。原因在于升级流程只更新了自报元数据，未真正执行物理文件的覆写替换。
- **解法**：不要盲目相信 JSON 状态记录。稳妥方案为将 `settings.json` 与 `upgrade-state.json` 中的版本元数据重置回真实值 `2.5.5`，使升级提示重新激活；或从 feed 重新下载对应版本的 tarball 完整执行物理覆盖安装。
- **验证**：核对 `pack.js` 实际字节数（2913003 字节对应 2.5.5）及版本特征串；重置元数据后面板恢复升级提示并能重新触发安装。
- 来源：2026-10-20 实测证据核对；`docs/incidents-2026-10-20.md` 附录 B.1。
### 2.17 OFM 自动升到 2.5.7 → 补丁集 v3 三处锚点失配整批中止；其中三处补丁应「作废」而非「重锚」（2026-10-21）

- **症状**：面板「测一次」连报 `Rate limit exceeded. Please try again later.` 与 `no eligible anonymous exit; retry after cooldown`；跑 `patch-ofm.mjs --verify` 报 `补丁锚点失配，整批中止`，点名 index.js 三处：`bench-records-a-verdict` / `bench-ttft-from-measured` / `verdict-outlives-the-round`。现役 `package.json` 已是 **2.5.7**（补丁集绑定 2.5.3 基线）。
- **原因（分两层，别混）**：① 那两条面板文案**本机代码里不存在**——全包 grep 零命中，是上游原样透传：前者 = opencode.ai 网关 429 全池限流（探测台账 `availability.json` 里 11 个模型 8 个同时 throttled），后者 = EAC 网关「匿名出口池全在冷却」。与 4.5 分流表一致，**本机修不了，别为它们动补丁**。② 真正要修的是版本脱钩：2.5.7 把 bench 重构进 `src/core/runtime.js` + `src/model-test.js`，且**原生化了这三处补丁的全部意图**（testModel 自己 `availability.edit(manualResults)+flush`、空答案/无收尾抛 `CODE.empty`、返回铺 `measured.ttftMs`、summary 走原生 `modelAvailability()`）——锚点消失不是上游写坏了，是补丁不再被需要。
- **解法**：补丁集升 **v4，11 处 → 8 处有效**。index.js 三处在 `lib/ofm-patch.js` 注释作废、标「2.5.7 已原生化」（原文留档备上游回退）；`bench-deadline` 的 330_000 也是上游自己发布的，条目保留仅为 2.5.3 基线重放兼容。http.js 4 处 + eac.js 3 处锚点仍命中，正常重放落盘。新建 `baseline/ofm-2.5.7/`（SHA256SUMS + .gz + README）。**取法备忘**：npm registry 无 2.5.7 包、GitHub 直连超时时，走三路交叉——官方签名 feed manifest（raw main）+ jsdelivr tag v2.5.7 + 现役 marker 扫描（0 命中 = 干净未打，无需还原）；注意发布构建与 tag 源码树差 6 行（上游自己摘除 CodeBuddy/WorkBuddy 渠道），index/client 以**发布包字节**为准。
- **验证**：`--verify` 8/8「全部已应用，且落盘字节与干净基线重放结果完全一致」exit 0；`node --check lib/ofm-patch.js` 干净；smoke 离线 146 PASS、`OFM_DIR` 指向现役 147 PASS；`eac-body-limit-test.mjs` 32 PASS（真实出网 0 次）。
- **教训**：① 锚点失配先 diff 上游新版**有没有把补丁意图原生化**——原生化了就作废，硬重锚是往重构后的代码里塞死代码；② 面板报错文案先 grep 安装包，查无此文案 = 上游透传，按 4.5 分流，不动客户端；③ 上游 auto-update 已在 2.5.8 候着，重启 DSH 前后各跑一次 `--verify`，届时按本节流程再导 ofm-2.5.8 基线。
- 证据强度：A（--verify/smoke/eac-body-limit-test 输出、三路交叉取证哈希、availability.json 台账原文均已上机核验）。
- 证据：记忆 `0mvhqx7h`（两条透传文案判据）、`0mvdhzzru`（2.5.7 现况）。

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

- **补充（2026-10-17 实测，两道闸门会互相污染）**：这道门与「会话头形态」是**两道彼此独立的闸门**。同一个合法降序会话头（本该 200），**带官方 tools 就 200，不带就全 403**。小困第一次跑会话头四形态对照时忘了带 tools，四条**全部 403**（连本该 200 的 mint 形态也 403），差点据此误判成「降序编码根本过不了」。
- **做法（固定一个维度，只变另一个）**：判「403 是哪道门挂的」之前，先确认 `body.tools` 里 `bash` 与 `read` 的官方定义同时在场（记忆原文写作「read+shell 官方定义」，代码侧常量以 §5.2 的 `REQUIRED_TOOLS = ['bash','read']` 为准，`FINGERPRINT_TOOLS` 另含 `glob`/`grep`）；把 tools 钉死为官方定义，再**一次只变会话头这一个维度**，否则每一格数据都被这道门污染，矩阵整张作废。
- **验证**：同一 body 只摘掉 `tools` 字段 → 复现全 403；补回 `bash` + `read` 官方定义、其余字节不动 → 恢复到该会话头形态应有的 200/403。§3.2 的「探针怎么改都是 403」是同一类误判的另一副面孔，两条对照着看。

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

### 3.10 给「会真出网」的模块写离线测试：零真实连接的写法

- **症状**：要给 EAC poster 这类**天生会打真实 HTTP** 的模块补离线测试，两难——不注入就真出网（测试变成真请求、慢且脏），注入了又怕「测试全靠 mock、等于什么都没验」；另外凭据字段总得填点什么，填了又怕把假值写进仓库。
- **原因**：这类模块的出网点收敛在**一个 transport seam**（可替换的请求函数）上，而不是散在各处。只要从 seam 注入，被测逻辑（签名、body 上限、413 解析、重试判定）就全都还是真代码在跑；出网与否跟「被测逻辑是否真实」并不冲突。
- **解法**：三条一起用。
  1. **域名一律用 `.invalid`**：`https://offline.invalid/eac/v1`。RFC 2606 保证这个 TLD 永远不可解析，即使某次注入失手真的发出去，也只会 DNS 失败，**不会打到任何真实主机**。
  2. **从 transport seam 注入假请求函数**，不打真实连接；并在测试开头**把真实出网通道全部钉死**成抛错桩——`http.request` / `https.request` / `globalThis.fetch` 三者一起换成 `forbidden`，谁绕过 seam 就直接炸，测试结束时还原。
  3. **凭据用一眼可辨的假值**：`signingSecret: 'offline-test-not-a-credential'`（示例假值、非真实密钥）。
- **验证**：测试跑完，`sends` 计数等于预期发送次数（全部来自注入的 seam），真实 `http/https/fetch` 一次都没被调用；断网环境（或临时把 `offline.invalid` 写进 hosts）下测试结果不变。本机落点：`scripts/eac-body-limit-test.mjs`——`base: 'https://offline.invalid/eac/v1'`、`signingSecret: 'offline-test-not-a-credential'`（示例假值、非真实密钥）、`http.request = https.request = globalThis.fetch = forbidden`、`lane.fetch = async (url, request) => …` 注入。
- **教训（真正会咬人的那一下）**：推代码前跑敏感词扫描，`offline-test-not-a-credential` 这类串**必然命中**。**别一命中就当泄露回滚**——先看它自不自证：域名是不是 `.invalid`、值里是不是明写 `not-a-credential` / `test` / `fake`。反过来也成立：写假凭据时**主动**让值自带这种自证标记，省下将来每一个人的一次惊慌。

### 3.11 buddy 全家报 unapproved channel：真凶在 system prompt 首句内容指纹（2026-10-20）

- **症状**：模型切换到 `buddy/deepseek-v4.1-flash` 后每一轮运行均失败，切模型或切推理档位表现一致：
  ```
  本轮运行失败  buddy: 请求被拦截，请重新发送 Illegal API invocation from an unapproved channel
  code: INVALID_REQUEST  status: 400
  ```
  插件错误透传中对应错误码为 `code=11128`。
- **原因**：并非白名单、账号过期、UA 风控或代理劫持（单变量实测均已排除）。真因在于腾讯网关（`copilot.tencent.com/v2/chat/completions`）对 `role=system` 消息首句进行第三方客户端内容指纹检测，DSH 内置开场白 `You are an AI agent powered by DeepSeek Harness.` 恰好命中拦截规则。判定条件：`AI agent` + `powered by` + `DeepSeek Harness` 三组词同时存在且顺序固定即拦截，大小写不敏感。此外发现 `code 11128` 为内容指纹、角色非法、缺会话头及首条非 system 四种情况共用的通用拦截码。
- **解法**：利用 `@deepseek-ai/dsh-system-prompt` 自带的官方开关，在 profile 层的 `cordis.patch.yml` 中为 `system-prompt` 增加配置 `includeHarnessIdentity: false`。重要注意：profile patch 为整块替换 `config` 而非深度合并，必须将原 `cordis.yml` 中的完整女仆人设（`personaPrefix`）原样重述，否则人设配置会被清空。
- **验证**：单变量改前测试含该句报 400，删除该句报 200；落地配置后检查 YAML 语法无误，重启 DSH 确认端口切换且会话日志中首句身份声明已消除，发送 20091 字真实长 prompt 打腾讯网关返回 HTTP 200 正常持续发流。
- 来源：2026-10-20 单变量实测；`docs/incidents-2026-10-20.md` 第八章。

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

- **症状**：上游发新版，`--dry-run` 报 `anchor-lost`，或基线校验 `SHA256SUMS` 不匹配。
- **原因**：补丁锚点、`baseline/ofm-2.3.0/*.gz`、`SHA256SUMS` 三份都绑定在 v2.3.0 上，上游一改这三份就集体对不上（可能要升 `PATCH_SET_VERSION`）。
- **解法**：先按 2.5 的取法重导基线，再逐处核对锚点；锚点真变了就按新版改写锚点并升 `PATCH_SET_VERSION`。
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

- **症状**：免费车道与 EAC 共付车道同时不通，日志里一边 `403 FreeTierError`、一边 HTTP 500 / 零数据帧，容易当成同一个毛病去修。
- **原因**：两者的失败机理完全不同——免费车道是**客户端姿态封锁**（有门，五道 AND + 传输层指纹），EAC 是**根本没有门**，自家网关 `ourfreemodel.beichenapi.com/eac/v1` 的上游 provider 挂了。
- **解法**：先按下面的表分流，别把一条线的解法套到另一条上——免费车道改头够不到（要 uTLS 类），补丁器只能修面板的「不喊疼」；EAC 客户端怎么改 body 都一样，**只能等网关修**，补丁只让慢模型**如实失败**，不会让它们变快。
- **验证**：按现象归位后，改动只影响对应那一条线；免费车道的修复不会让 EAC 的 500/零帧消失，反之亦然。

| 维度 | 免费车道（opencode.ai） | EAC 共付车道 |
| --- | --- | --- |
| 性质 | 客户端姿态封锁（有门，五道 AND + 传输层指纹） | **根本没有门**，是自家网关 `ourfreemodel.beichenapi.com/eac/v1` 的上游 provider 挂了 |
| 现象 | `403 FreeTierError` | HTTP 500，301s 后 `upstream returned non-SSE response`；或 `glm-5.3-flash` / `deepseek-v4.1-flash` 300s 内零数据帧 |
| 能修吗 | 改头够不到（要 uTLS 类）；补丁器只能修面板的「不喊疼」 | 客户端怎么改 body 都一样，**只能等网关修**；补丁让慢模型**如实失败**，不会让它们变快 |

### 4.6 包内还有别的补丁器，别搞混

- **症状**：`vendor/channel-pack/` 下看到一串 `pack.js.bak-*`，误以为是 lane-fix 自己留下的备份，或以为改 `src/*.ts` 能生效。
- **原因**：本机 `vendor/channel-pack/` 下除 `pack.js`（2.88MB，2026-10-16 实测）外还有一串 `pack.js.bak-*` 备份——`bak-ofm-patch-<YYYYMMDD-HHMMSS>`、`bak-codearts-sig-*`、`bak-false-risk-*`、`bak-codearts-diag-*`、`bak-benefit4004-*`，那是围绕**上游渠道适配器构建产物**的另一套补丁工作留下的，命名法与 lane-fix 的 `.lane-fix-orig/` 不同，两回事（完整台账见 4.7）。另外 `pack.js` 是构建产物，改 `src/*.ts` 不生效——但这指的是上游**渠道适配器**那类补丁；lane-fix 补丁集的目标是包根的 `client.js` / `index.js` / `src/http.js`，三者互不替代。
- **解法**：认准目标文件——lane-fix 只动包根的 `client.js` / `index.js` / `src/http.js`；`vendor/channel-pack/pack.js` 归 4.7 那套渠道补丁台账管，动它前先 `cp` 一份 `pack.js.bak-<用途>-<时间戳>`。
- **验证**：跑 lane-fix 的 `--dry-run`，它只认那三个文件；`pack.js` 不在 `PATCHED_FILES` 里。

### 4.7 channel-pack 渠道补丁台账（2026-10-16/17，五补丁 + 一配置）

> 落点全在 `<上游包>/vendor/channel-pack/pack.js`（构建产物）与 `src/` 同名源码，逐处带 `/* patched(小困 …) */` 注释。动 pack.js 前先 `cp` 一份 `pack.js.bak-<用途>-<时间戳>`。改 `src/*.ts` 不生效——运行时读的是 pack.js。

| # | 补丁 | 落点 | 针对症状 | 修法 |
| --- | --- | --- | --- | --- |
| 1 | workbuddy 会话三头 | pack.js:35282 | 国际版全模型 400 code=11128「conversation id missing / first message is not system prompt」 | 请求头补 `X-Conversation-ID` / `X-Conversation-Message-ID` / `X-Conversation-Request-ID`（2×2 矩阵实证：三头与首条 system 是 AND 的两关，只补头会撞第二关） |
| 2 | 11128 前置排除 | pack.js:34510 | 假风控：缺头的 11128 响应被 `isContentRejection` 判成账号级安全拦截 → 换号循环把健康账号逐个冻 30 分钟 | 判据最前加 `if (/"code"\s*:\s*11128/.test(body)) return false;`——11128 与真拦截 11140 **共用 "request illegal" 文案**，判据必须看 code 不能看 msg（上游 `tencent-fingerprint.ts:54` 注释明令别把 11128 加进判据，删正则会漏判真拦截） |
| 3 | 换号最小间隔 | pack.js:35232 | 换号循环零延迟连打，同 IP 短时轮换多号是风控关联特征 | 循环内 `await sleepMs(600)` |
| 4 | content-type 退出签名 | pack.js:31028 | codearts 全模型 403/401 `APIG.0301 verify ak sk signature fail`（直连矩阵单变量实证：content-type 不参与签名即变 429） | 签名前不再 set content-type，挪到 Authorization 之后挂回（发送侧行为不变） |
| 5 | benefit 裸 "4004" 判定 | pack.js:33217 | v4.1-flash 摘戳重试永不触发：插件自带「benefit not found → 去掉 `maas_type` 戳重发」（pack.js:32992），但触发判定只认全串 `InferHub.4004.200`，上游实测只回裸 `"4004"` | 判定加 `|| data.error_code === "4004"`（`src/llm-adapter.ts:1658` 同步） |

**配置类（非补丁）——403 真凶**：codearts 的 403 不是华为云回的，是本机 bili 压缩代理拒转签名请求，响应体 `signed_request_requires_resign / bili_resign_unavailable`——SDK-HMAC-SHA256 签名覆盖请求体，bili 一旦压缩改写内容签名即失效（上游必 401），于是直接 403。修法在 `%USERPROFILE%/.config\billion-context\billion-context.json` 加 `"resign":{"sdk-hmac-sha256":{"passthrough":true}}`（签名链直通不压缩）。复验：经网关 8326 发 `codearts/deepseek-v4-flash` HTTP 200 真出词（2026-10-17 00:25，`"收到"`）。

- **症状**：五处修复全落盘、重启生效后 codearts 仍全 403；直连矩阵（不经 bili）怎么改都是 429/200，一个 403 都复现不出来。
- **原因**：403 是 bili 中间层写的；插件的抛错点（pack.js:33064）只抛 `codearts: model request failed with HTTP 403`，**响应体直接丢弃**——不抓 body 永远在猜。
- **解法**：在 pack.js 非 200 分支埋日志（`appendFileSync` 追加到 `~/.dsh/our-free-model/codearts-diag.log`，记 status + 前 800 字，try/catch 包住），重启后触发一次即抓到真凶。
- **补记（2026-10-18，三条台账行的失效机理与判据）**：
  - **WorkBuddy `wb-conversation-headers`**：现象是探测与真实对话**同时**回 `request illegal`，换账号、换模型都不变，极易误判成账号风控。真因是请求缺 `X-Conversation-ID` / `X-Conversation-Message-ID` / `X-Conversation-Request-ID` 三头，上游压根没发。判据是四形态矩阵（换 UA / 换 body / 换账号 / 换模型）里**只有「补上三头」这一个变量能把 403 变 200**——先换变量，别看报错文本。上游 2.5.1 已自行补上三头，本补丁降级为冗余保险。
  - **CodeArts `codearts-signed-headers` + `codearts-signed-decl`**：两处必须**同时**应用。旧补丁只改 canonical 未改 `SignedHeaders` 声明数组，而上游 `headers.forEach((_, k) => { if (k.toLowerCase() !== "content-type") signedHeaders.push(k); })` 把除 `content-type` 外的所有头签进签名，而 `x-sdk-date` / `x-sdk-content-sha256` 是在签名后才 `set` 的——于是验签必失败。判据：**`401` 变 `429` 就说明验签已过**，429 是限流；别以「最终是否 200」作为补丁生效的唯一判据。
  - **trae / lobsterai 的「额度用尽」**：`trae: Your requests have exceeded the quota. (code=4008)` 与 `lobsterai: 所有账号均不可用（免费额度已用完，请升级套餐）` 都是**模型级限流**被网关包成了「凭据/额度坏了」的话术。判据：停手等标记过期（2026-10-17 实测 12:36 恢复）。限流与凭据失效要分清：**重登、重试、反复探针这三件事，对限流全是负收益**。
- **验证**：日志白纸黑字 `bili_resign_unavailable`；passthrough 配置后同请求 200 出词。

- **补充 A（2026-10-17 00:25 复验闭环 + 三条教训）**：
  - **复验**：经网关 8326 发 `codearts/deepseek-v4-flash` 取 **HTTP 200 真出词**（正文 `"收到"` + `reasoning_content`）。即 `"resign":{"sdk-hmac-sha256":{"passthrough":true}}` 之后签名链不再被压缩改写（备份文件名 `bak-resign-passthrough-20261016-235912`）。
  - **顺带暴露的良性行为**：插件对 `TM.00001041`（并发会话上限 3）自带 3 次 × 10.5s 轮询重试，能扛过瞬时会话堆积——**`400` 会自动恢复，不是死态**，别拿它当「凭据坏了」的证据去重登。
  - **教训一（判据别混）**：台账第 4 行 `content-type 退出签名` 改的是**真 bug**（直连矩阵单变量证实过），但它**不是 403 的本因**。别把「修了真 bug」当成「修了症状」——本次就是五处修复全落盘、codearts 仍全 403。
  - **教训二（先问谁写的响应体）**：中间层（压缩/代理）会自己制造 403。抛错点只抛 `codearts: model request failed with HTTP 403`（册内上文记作 `pack.js:33064`，本轮**未复核该行号**）、**响应体直接丢弃**，所以必须在日志层抓 body；抓到 `bili_resign_unavailable` 才定案。
  - **教训三（探针要有超时）**：长任务中途触发的脚本必须带 `AbortSignal.timeout`，否则网关慢响应会把探针挂到 120s+ 才自己放弃。
  - **证据强度**：A（有原始响应体 `signed_request_requires_resign / bili_resign_unavailable` 与 200 出词两端原文）。

- **补充 B（2026-10-18，OFM 2.5.3 核对时的修正：五条里两条已被上游内建）**：
  - **已被上游自带的**：① `false-risk-11128`（台账第 2 行）；② `wb-conversation-headers`。后者上游实现得更正确——`pack.js:35552-35556` 用 `this.product.id === "workbuddy"` 注入 `X-Conversation-ID`（取实例级稳定 `this.sessionId`）/ `X-Conversation-Message-ID` / `X-Conversation-Request-ID`（后两个 `crypto.randomUUID()`）。稳定 sessionId 比补丁的「每请求新 UUID」更贴近上游语义；**强打会被同 key 覆盖，净效果为零**。故台账第 1 行的状态从「冗余保险」进一步放宽为「可移入观察点」。
  - **缺的那半：codearts 两条被一个异常锚点连坐**。`codearts-signed-headers` 与 `codearts-signed-decl` 必须同时落盘（见上文「验签必失败」那条），但它们**落不了盘**：只要 `false-risk-11128` 仍留在补丁器的 `PATCHES` 里报锚点异常，那套补丁器就整批中止、一个字节都不写——所以 codearts 两条会长期停在「待应用」。lane-fix 侧的结论只有一句：**先把这个已被上游内建的补丁降级或删除，codearts 那两条才有机会落盘**，不要反复重跑落盘命令等它自己好。
  - **证据强度**：A（`pack.js:35552-35556` 逐行核对原文：`if (this.product.id === "workbuddy") {` / `headers.set("X-Conversation-ID", this.sessionId);`）。
  - **未取证**：`pack.js:34915`（sessionId 的构造点）本机核对时未定位到该行号，只有 `35553` 引用 `this.sessionId` 这一侧的证据；补丁器「整批中止」的实现代码不在本仓，由 patch-kit 册记录。

**备份台账**（按时间序，都在 `<上游包>/vendor/channel-pack/`）：`bak-ofm-patch-20261016-200606`（2881789B）→ `bak-codearts-sig-20261016-201657`（2882226B）→ `bak-false-risk-20261016-202625`（2882513B）→ `bak-codearts-diag-20261016-204044`（2883203B）→ `bak-benefit4004-20261017-002745`（2883449B）；最终 pack.js 2883612 字节，md5 `801850a2880be6ea3a55fb731510db00`。

**收尾战果**（2026-10-17 全量探测 62 模型）：48 通。codearts 3/4（仅 `glm-5.3-flash` 上游未注册 404；`deepseek-v4-flash`/`deepseek-v4.1-flash`/`glm-5.3` 全 200）、workbuddy 4/4、buddy 4/5、cline 16/24（8 个上游 502/地区封锁）、qoder 1/4（上游 502 pricingUrl）、gemini 0/1（出口地区，换节点即通）、其余渠道全绿——剩余 14 个失败全部非本机代码问题。

### 4.8 只推文档、没推源码：别人照文档跑一遍直接失败（待核）

- **症状**：仓库里文档写好了、也推上去了，另一台机器按文档操作却失败；两侧的提交历史已经**不是祖先关系**（`git log` 各有一串对方没有的提交），`git pull` 既不是 fast-forward 也无法干净 rebase。
- **原因**：文档描述的行为依赖尚未推送的源码改动，文档先于代码上线；两台机器各自在此基础上继续提交，历史就分叉成了两条线。**根因未证实（待核：分叉发生时两侧各自的确切起点提交，未记进任何提交正文或会话日志）**。
- **解法**：`git reset --mixed <目标提交>` 把索引与工作区对齐到同一基线（**不要 `--hard`**，工作区里未提交的实测改动要留住）；比对差异时先统一行尾再比，否则整篇全是噪声——`git -c core.autocrlf=false diff --ignore-cr-at-eol`。
- **验证**：未验：本次只有方法记录，没有「按此法对齐后另一台机器重跑由红转绿」的实测结果。复现判据：`git rev-list --left-right --count HEAD...origin/main` 两侧都 > 0。
- 证据：记忆 `0mvdldirc-abe17fdfb1ae450e8905afe56b`（2026-10-18 复核，无对应提交号）。
- **教训**：文档是交付物的一部分，它描述的改动必须与源码同一次推送；「先写文档占位」在多机协作里会直接制造分叉。

## 五、关键路径与配置落点

### 5.1 路径（2026-10-16 本机实测值）

| 项 | 值 |
| --- | --- |
| 本插件仓库 | `D:\DeepSeek Harness\Works\dsh-maid-lane-fix` |
| 插件安装点 | `~/.dsh/profiles/desktop/node_modules/dsh-maid-lane-fix`（junction → 工作副本；`web` profile 未装） |
| 上游包（profile 内） | `~/.dsh/profiles/desktop/node_modules/dsh-our-free-model`（junction） |
| 上游包（真实落点） | `D:\DeepSeek Harness\Works\_vendor\dsh-our-free-model-2.5.1`（2026-10-17 从 `D:\Downloads\dsh-our-free-model-2.1.0` 搬迁并改名对齐；**不是 git 仓库**） |
| 补丁备份目录 | `<包目录>/.lane-fix-orig/`（实测内容：`client.js`、`index.js`、`src_http.js`） |
| 还原基线 | `baseline/ofm-2.3.0/{client.js.gz,index.js.gz,src__http.js.gz}` + `SHA256SUMS` |
| 上游补丁档案 | `docs/ofm-upstream-patches.md` / `docs/ofm-upstream-patches.patch` |
| 补丁落点（3 文件） | `<包目录>/client.js`、`<包目录>/index.js`、`<包目录>/src/http.js` |
| 可用度数据源 | `$DSH_HOME/our-free-model/availability.json` |
| profile 目录 | `~/.dsh/profiles/{desktop,dev,web}` |
| profile patch（源层） | `~/.dsh/profiles/desktop/cordis.patch.yml`（**顶层必须是 0 缩进的扁平数组**，别混 bundle 层的 `- insert:` 语法，见 2.14） |
| profile 合成产物 | `~/.dsh/profiles/desktop/cordis.yml`（宿主监听 patch 文件，变更后约 3 秒自动重合成，**不必重启**） |

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
   追加真实上游分支：`OFM_DIR="D:/DeepSeek Harness/Works/_vendor/dsh-our-free-model-2.5.1" node scripts/smoke.mjs` —— 在**未打补丁**的包上会红一条，这是预期的：
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

10. **改 profile 的 `cordis.patch.yml` 后先验解析，再看面板**：宿主用 chokidar 监听它，改完约 3 秒 `cordis.yml` 就会重新合成（**不必重启**）；但必须先用 YAML 解析器过一遍——**缩进写错不是「丢一行」，而是整份 profile 配置解析失败、所有面板保存全挂**（见 2.14）。同理，往 profile patch 追加条目**别照抄包内 bundle 的 `- insert:` 写法**，两层语法不通用。
## 七、暂未遇到（留给以后填）

- 补丁集跨大版本（v2.4.0+）的迁移实录：暂未遇到（上游尚未发新版）。
- 在 macOS / Linux 上的安装与路径差异：暂未遇到（本记录全部来自 Windows 本机）。
- 中间层与其它 `globalThis.fetch` 包装器的真实冲突（除 bili 那条无害告警外）：暂未遇到。
