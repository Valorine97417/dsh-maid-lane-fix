# 免费车道三类拒签事故：症状、根因与修法

> 2026-10-17 整理。对象是上游 `Ebony-Vinyl/dsh-our-free-model`；本仓库（`dsh-maid-lane-fix`）既有中间层也管补丁器，两类修法的落点都在这里。
> 每条按「症状 → 原因 → 解法 → 验证」写，症状照抄实际报错原文。没有现场证据的地方标「（待核）」，不猜。

## 小引：三条事故同属「指纹与签名判定」一族

| 车道 | 拒法 | 根因层级 | 我方修法 |
| --- | --- | --- | --- |
| WorkBuddy | `request illegal` | 请求缺会话三头 | 补丁器第 1 处 |
| CodeArts | `401` → 补签名后变 `429` | 签名把不该签的头也签了进去 | 补丁器第 2、3 处 |
| trae / lobsterai | `502`「额度已用尽」「模型不可用」 | 实为**模型级限流**伪装成凭据失效 | 无补丁；停手等解禁 |

三条的共同点：**报错文本都在指向错误的方向**。`request illegal` 看着像风控，`401` 看着像凭据坏了，`502 额度用尽` 看着像账号没额度——逐个当字面意思去修，三条都会修错。

---

## 一、WorkBuddy：`request illegal`

### 症状

```
request illegal
```

探测与真实对话**同时**失败，换账号、换模型都不变。

### 原因

请求缺 **`X-Conversation-ID` / `X-Conversation-Message-ID` / `X-Conversation-Request-ID` 三头**，上游压根没发。**不是账号风控**——四形态矩阵（换 UA / 换 body / 换账号 / 换模型）里只有「补上三头」这一个变量能把 403→200。

### 解法

补丁器补三头（`wb-conversation-headers`）。上游 2.5.1 已自行补上，见下文「2.5.1 之后的变化」。

### 验证

四形态矩阵重跑，三头在场的那一形态 200；本机 4/4 全通。

---

## 二、CodeArts：`401` → 补一半签名后变 `429`

### 症状

```
401 Unauthorized
```

旧补丁只改了签名的 canonical 部分，**没有改 `SignedHeaders` 声明数组**——于是 `Authorization` 里声明的已签头清单与实际签进去的头对不上，服务端按验签失败处理。

### 原因

上游 `pack.js` 的签名构造是这样的（2.5.1 实测，`vendor/channel-pack/pack.js:31259` 与 `:31285`）：

```js
const signedHeaders = [];
headers.forEach((_, k) => { if (k.toLowerCase() !== "content-type") signedHeaders.push(k); });
signedHeaders.sort();
const headerLines = signedHeaders.map((k) => `${k}:${headers.get(k) ?? ""}`);
return [method, uri, query, headerLines.join("\n"), "", signedHeaders.join(";"), payloadHash].join("\n");
```

**除了 `content-type`，其余头一律进签名**。而 `x-sdk-date` / `x-sdk-content-sha256` 是在签名算完**之后**才 set 上去的（同文件 `:31274-31275`），所以它们不该进签名。

于是要做的是**两处**，少一处都不成：

1. canonical 请求串里不包含这两个头；
2. `SignedHeaders` 声明数组里同样剔除它们。

只改 ① 不改 ②，声明与实际不一致，仍是验签失败——这正是「改了还是 401」的由来。

### 解法

补丁器两处（`codearts-signed-headers` + `codearts-signed-decl`），两处必须同时应用。

### 验证

**判据是错误码变化，不是 200**：`401` → `429` 就说明**验签已经过了**，剩下的 `429` 是限流（见下面 `deepseek-v4.1-flash` 那条）。看到 429 别以为补丁没生效，回头再改签名是白费功夫。

---

## 三、trae / lobsterai：502 是限流伪装

### 症状

```
trae: Your requests have exceeded the quota. (code=4008)
```
```
lobsterai: 所有账号均不可用（免费额度已用完，请升级套餐）
```

### 原因

**模型级限流**，被网关包成了「凭据/额度坏了」的话术。探针对应的两个坑：

- 看着像凭据失效，于是去重登账号——重登无用，因为凭据本来就是好的；
- **反复跑探针会给限流标记续命**，越探越晚解禁。

### 解法

**停手**。不要重登、不要重试、不要拿探针「确认一下还好不好」。等标记过期（本机 2026-10-17 实测标记刷到 `12:36`）。

### 验证

解禁后单次探测即可，别连打。`trae` / `lobsterai` 与其他车道共用同一份探针脚本，但只有这两条是模型级限流。

---

## 四、2.5.1 之后的变化（重要，别照着旧笔记打补丁）

### 会话三头：上游已自行补上

`vendor/channel-pack/pack.js:35535-35537`：

```js
headers.set("X-Conversation-ID", globalThis.crypto.randomUUID().replace(/-/g, ""));
headers.set("X-Conversation-Message-ID", globalThis.crypto.randomUUID());
headers.set("X-Conversation-Request-ID", globalThis.crypto.randomUUID());
```

→ **我方 `wb-conversation-headers` 从「必需」降级为「冗余保险」**。对 2.5.1 它仍能应用（幂等），但已经不是修复；上游哪天再动这段，补丁会报 `anchor-lost`，届时应考虑的是**删掉这一处补丁**而不是去修它。

### CodeArts 签名：上游仍然没修

同文件 `:31259` / `:31285` 仍是 `headers.forEach` 全量收集，没有排除 `x-sdk-*`。**两处补丁对 2.5.1 仍然必需。**

### 一条判据总结

上游发新版后，**逐个补丁位置核上游原文**，别因为「作者说修了」就整批不打：

```bash
node scripts/patch-ofm.mjs --dry-run    # 哪些待应用、哪些已应用
node scripts/patch-ofm.mjs              # 落盘
node scripts/patch-ofm.mjs --verify     # 逐字节核对，改完必跑
```

---

## 五、方法论：怎么给这三类事故定性

1. **先换变量，别看报错文本**。报错说「非法」「未授权」「没额度」，都不足以定性；四形态矩阵（UA / body / 账号 / 模型各换一遍）里只动单一变量，谁能让错误码变，谁才是根因。
2. **错误码的「变化」本身就是证据**。`401 → 429` 说明验签已过；`403 → 200` 说明门已过。**别以最终是否 200 作为补丁生效的唯一判据**——限流、模型慢都会让你误判补丁无效。
3. **限流与凭据失效要分清**：重登、重试、反复探针这三件事，**对限流全是负收益**。
4. **探针模型必须从当轮模型清单里取**。用已下架的模型量出的矩阵是废的——本仓库 README 里记着这条教训的原始事故。

## 六、EAC 请求体超限事故（2026-10-18，与指纹/签名失败分流）

- **症状**：长会话或大附件请求返回 HTTP 413 `request body too large`；不是宿主输入框限制，也不是签名失败。
- **根因证据**：既有上游单变量测量显示 8388608 bytes 通过体积关、8388609 bytes 413，即 8 MiB 请求体限制。体积关放行不代表上游模型成功；本次只做离线验证，不再次发送大请求。
- **修复落点**：`lib/ofm-patch.js` 的三处 EAC 补丁（补丁集 v3，合计 11 处）。以 `Buffer.byteLength(JSON.stringify(body), 'utf8')` 的最终字节数为准，仅超上限才在签名/出网前拒绝。网关仍回 413 时用中文解释实测上限、附件/会话缩减建议；两条路径均归 `CODE.client`，原样重试无效，不宣称解除上游限额。
- **验证与还原**：既有冒烟 140 PASS（现役分支 141 PASS）；新增 `scripts/eac-body-limit-test.mjs` 32 PASS，另用 `EAC_USE_INSTALLED=1` 读取现役源码复测 32 PASS。覆盖 ASCII/中文 UTF-8 的上限前一字节、精确上限、上限加一字节；超限零 transport、签名/正常 SSE 与 JSON 不回归、上游 413 不可重试、CLI 幂等及还原保护。`baseline/ofm-2.5.3/` 补齐 EAC 原文和清单；`--verify` 已升级为基线重放逐字节比对，`--restore` 拒绝不属于当前版本的备份。
- **落盘与生效**：现役实体目录 `~/.dsh/profiles/desktop/node_modules/dsh-our-free-model` 仍为 2.5.3。已备份并仅通过现有补丁器写入 `src/eac.js`；11 处逐字节验证及语法检查通过。四份常规备份均与当前版本基线相等。**仅磁盘生效，未重启或重新加载宿主进程**；未提交、未 push。完整哈希、备份路径、命令记录见 `TROUBLESHOOTING.md` 2.10。

---

## 七、会话角色与诊断信息事故（2026-10-19，与拒签/限流分流）

> 本节两条都不是「车道拒绝」，而是**本机自己的代码**造成的：一条把宿主合法的会话角色判成非法，
> 一条把已经诊断出来的错误码在最后一米丢掉。它们的表现都是「报错看不懂」，所以归在一起。

### 7.1 `400 unsupported message role: developer`（宿主每一轮都撞）

#### 症状

宿主里任何一次正常对话（带系统提示词）都失败，模型选择器里切模型也没用：

```
本轮运行失败  400: {"message":"unsupported message role: developer","type":"invalid_request_error","param":null}  INVALID_REQUEST
```

#### 原因

`vendor/channel-pack/pack.js` 的 Chat wire 入口 `convertMessage()` 只认四个角色：

```js
if (role === "system") { ... }
if (role === "user")   { ... }
if (role === "assistant") { ... }
if (role === "tool")   { ... }
throw new OpenAiGatewayError(`unsupported message role: ${String(role)}`);   // pack.js:63339
```

而 **`developer` 是 DSH 宿主的合法会话角色**（宿主有 `createDeveloperMessage`，宿主自己会产出它）。
所以这不是「谁发了个怪角色」，是**本机把宿主说的话判成了非法**。

**同一份文件里另外两处都认它**——这才是它属于遗漏而非设计的证据：

| 位置 | 对 `developer` 的态度 |
| --- | --- |
| `pack.js:63878`（Responses wire） | `raw.role === "system" \|\| raw.role === "developer"` → 当 system |
| `src/messages.js:196`（OFM 自己的 chat 转换） | `case 'system': case 'developer':` → 当 system |
| **`pack.js:63314`（Chat wire）** | **只认 `system`，落到 63339 抛错** |

Chat wire 是三处实现里唯一的遗漏。**已核对 pristine tgz：这是上游 bug，不是补丁造成的。**

#### 解法

一行，把 `developer` 并进 system 分支（**内容不丢**，不像 `normalizeHarnessMessages:31487` 那样整条 `continue` 掉）：

```js
- if (role === "system") {
+ if (role === "system" || role === "developer") {
```

**两处都要改**——插件与独立版是两份同源代码：

| 文件 | 行 | 落点 |
| --- | --- | --- |
| `pack.js` | 63314 | `~/.dsh/profiles/desktop/node_modules/dsh-our-free-model/vendor/channel-pack/pack.js` |
| `business.mjs` | 63303 | `D:\Our Free Model\service\packages\standalone\channels\business.mjs`（独立版桌面应用的副本） |

> **注意**：`pack.js` 与 `business.mjs` **不在** `lib/ofm-patch.js` 的补丁集覆盖范围内（补丁集只管 `client.js` / `index.js` / `src/http.js` / `src/eac.js` 四个文件，`baseline/ofm-2.5.3/` 也只有这四个）。
> 所以这条**必须手改**，不能指望 `patch-ofm.mjs`。它属于 `TROUBLESHOOTING.md` §4.7 那条「channel-pack 独立补丁线」。

#### 验证

改后重启对应服务，向宿主实际使用的入口发请求：

| 用例 | 改前 | 改后 |
| --- | --- | --- |
| `{role:'developer'}` 单独一条 | `400 unsupported message role: developer` | **`200`**，且模型按系统指令作答（回了「I can't share internal developer instructions…」） |
| `{role:'banana'}`（伪造角色，对照组） | `400` | `400`（**仍正确拒绝**，说明不是把校验放空了） |
| `{role:'system'}+user` | — | `200` |
| `{role:'system'}+{role:'developer'}+user` | — | `200` |

**最强的一条证据不是状态码，是行为**：模型把那条 `developer` 当系统指令读了并据此作答。
若代码仍在拒绝 `developer`，这一条不可能返回 200。

**落盘记录（本机 2026-10-19）**：

| 文件 | 改前 | 改后 | 备份 |
| --- | --- | --- | --- |
| `pack.js` | 2913003 B / `77c34f07…` | 2913027 B / `f17115fb…` | `pack.js.bak-developerrole-20261019-133846` |
| `business.mjs` | 2912284 B / `39316afc…` | 2912308 B / `96fb3fbf…` | `business.mjs.bak-developerrole-20261019-133846` |

逐行 diff 复核：**69204 行中仅 1 行不同**（L63314），无副作用。`node --check` 通过。

---

### 7.2 `transportCause()` 把已经诊断出来的错误码丢掉

#### 症状

EAC 共付车道偶发一条**光秃秃、没有任何错误码后缀**的传输错误：

```
model request failed: Client network socket disconnected before secure TLS connection was established
```

没有 ` — ECONNRESET` 后缀，也没有别的线索，用户无从判断该不该重试。

#### 原因

`src/http.js` 的 `transportCause()` 是用来把「传输层真正的原因」从错误对象里挖出来、
追加到用户可见消息后面的。但它**只沿 `.cause` 链走**：

```js
for (let depth = 0; depth < 3 && node?.cause !== undefined; depth += 1) {
  node = node.cause
  ...
}
```

**而 `node:https` 的 `ECONNRESET` 挂在顶层 error 自己身上，根本没有 `.cause`**。
于是这个函数对走 `node:https` 的车道返回空串，错误码在最后一米被丢掉。

**为什么偏偏是 EAC 这条线**：`src/eac.js` 与 `src/kilo.js` 用的是 module-private 的
`laneFetch`（`node:http`/`node:https` 的 `transport.request`），**不是 `fetch`**；
而 `fetch()` 会把真因放进 `.cause`（`TypeError: fetch failed` ← cause），所以免费车道那条路正常。

**这条报错的出身**（不是猜的）：在 `node.exe` 二进制里搜字符串命中 `_tls_wrap.js` 的
`onConnectEnd()` → `ConnResetException`，语义是 **TCP 已建连、对端在 TLS 握手完成前关闭**。
本地用 `net.createServer(s => s.end())`（accept 后立即 FIN）可精确复现，`code=ECONNRESET`。
**它既不是 DNS 失败，也不是证书错误**——分清这点能省掉一整轮往代理/证书方向的猜测。

#### 解法

让顶层 error 也算一条链上的环节。**但要按深度区分，否则会引入噪声**：

| 深度 | 贡献什么 | 为什么 |
| --- | --- | --- |
| 0（调用方自己会插值的那个 error） | **只贡献 `code`** | 调用方已经拼了 `error.message`，重复它就是噪声 |
| ≥1（`.cause` 链上的） | 完整 message + code | 这些没人打印，必须带上 |

#### 验证

四项行为全对（第一项用真实的 `net.createServer(s=>s.end())` 复现，不是构造对象）：

| 用例 | 结果 |
| --- | --- |
| node:https 连接复位 | ` — Client network socket disconnected … (ECONNRESET)` ✅ 码补回来了 |
| `fetch failed` + cause `ENOTFOUND` | ` — getaddrinfo ENOTFOUND opencode.ai` ✅（不重复 `fetch failed`） |
| 嵌套三层 cause | ` — middle; deep ETIMEDOUT` ✅（不重复顶层） |
| 纯 `Error('plain')` / `null` | `""` ✅ 零噪声 |

**踩过的坑（值得单列）**：第一版写成「顶层有 message 就输出」，结果 `Error('plain')` 变成
`" — plain"`，给**所有**普通错误消息都加了噪声——而当时只跑了「有 code 的用例」，没发现。
**教训：改诊断/格式化类函数，必须专门跑「无信息的输入」这一格**，否则噪声会污染所有调用点。

**落盘记录（本机 2026-10-19）**：`src/http.js` 29007 → 29859 字节；备份
`http.js.bak-transportcause-20261019-133846`。`node --check` 通过。
改动后用 `node scripts/patch-ofm.mjs --dry-run` 复核：**11 处补丁仍全「已应用」**
（`transportCause` 不在其锚点范围，未破坏补丁集判定）。

---

### 7.3 方法论补充：先确认「我测的入口」是不是用户用的那个

这一节记的是**本节两条事故为什么会差点被自己判成无效**，比技术细节更值得留。

本机 OFM 有**两个独立入口、两份独立代码**：

| 入口 | 谁在用 | 代码落点 | 密钥 |
| --- | --- | --- | --- |
| `127.0.0.1:8326` | DSH 内插件网关 | `~/.dsh/profiles/desktop/node_modules/dsh-our-free-model/` | `~/.dsh/openai-gateway/api-key` |
| `127.0.0.1:18900` | **独立版 OFM 桌面应用**（`D:\Our Free Model\ofm-desktop.exe`） | `D:\Our Free Model\service\packages\standalone\` | `~/.our-free-model/settings.json` 的 **`forwardKey`**（形如 `ofm-…`） |

修 7.1 时**全程在测 8326**，而用户截图里配的是 `http://127.0.0.1:18900/v1`。于是：

1. 8326 上「带 `system` 就失败、不带就 200」，横跨 **9 个渠道完全一致**；
2. 报错字面是 `role: developer`，而我发的是 `system`——「角色名对不上」；
3. 据此推断「有别的环节在改写，我改的那行够不着」，**把自己的修复判成无效**。

**第 3 步是错的推论。** 真相：7.1 的修法是对的（18900 上实测 `{role:'developer'}` 返回 200），
而「渠道适配器把 `system` 转成 `developer` 再发上游、上游不认」是**另一码事**，两者被我混为一谈。

**四条纪律**：

1. **从用户截图里读出协议、地址、端口、展示名，照抄**。用户配的是哪个入口，就打哪个。
2. **同一问题两个入口都测**。行为不同不代表其中一边是错的。
3. **改了哪份代码，就重启对应的那个进程**。本轮改独立版文件后只重启 DSH 是无效的——
   独立服务进程起于 11:17，而补丁是 13:38 才打的，它根本没加载新字节。
4. **密钥别乱猜**。`service.lock` 里的 `token` 是内部服务 token，拿它调 `/v1` 会得
   `401 missing or invalid API key`；面板「留空使用已保存数据」对应的真 key 是 `forwardKey`。

**判别错误来自本机还是上游：故意发一个谁都不认的角色**（`{role:'banana'}`），比对错误体字段——
**本机抛的带 `code`、不含 `param`；上游返回的常被 502 裹着、带 `param:null`。**

> **但这条判别法有个前提**：它只在你**已经测对了入口**时有效。测错入口时，它会非常自信地把
> 你带到一个错误的结论上。**先确认入口，再谈归属。**

---

### 7.4 已撤回：「带 system 九渠道全挂」是 7.1 的连带现象，不是独立 bug

> **本节已于 2026-10-19 撤回。** 保留在此是为了记录一次**差点写进事故单的假待查项**——
> 它曾被列为「比 7.1 更严重」，实际是 7.1 未修时的连带现象。

**当时的观察**：8326 上凡 `messages` 带 `{role:'system'}` 的请求，9 个渠道
（buddy / codearts / trae / loomy / raccoon / zcode / minimax / qodercn / cline）一律失败，
报错是 `502` 裹着一个带 `param:null` 的上游 400 `unsupported message role: developer`，
不带 system 一律 200。据此推断「渠道适配器把 `system` 转成 `developer` 再发上游」，列为待查。

**修完 7.1 之后的复测（两个入口各 6 个模型）**：

| 入口 | 模型 | 仅 user | 带 system |
| --- | --- | --- | --- |
| 18900 独立版 | qodercn/dfmodel、qodercn/qfmodel、raccoon/sn-deepseek-v4-1-flash、zcode/GLM-5.3-Flash、cline/cline-free/mimo-v2.6-flash、buddy/hy3 | 全 200 | **全 200** |
| 8326 插件网关 | ofm/qodercn/dfmodel、ofm/zcode/GLM-5.3-Flash、ofm/buddy/hy3 | 全 200 | **全 200** |

**结论**：现象**不复现**。

**为什么会被误当成独立问题**：那个 `502` 裹着的 400 里写着 `role: developer`，而我发的是
`system`。当时把「角色名对不上」理解成「有个渠道侧的改写环节」，于是把它当成 7.1 之外的
另一个 bug。实际上 7.1 修好之后，**本机不再把 `system` 判成非法、也不再有那条把 system
交给上游的路径**，连带现象就一起消失了。

**留下的教训（已并入 7.3）**：

1. **同一现象修 A 之后要复测，别急着立成新待办**。这一条是 7.1 的连带效应，
   如果当时并列成「更严重的待查」，就会白白多查一轮。
2. **「报错里的角色名与我的输入不一致」有多种可能**，把它当成「有别的环节在改写」是
   一次过度推断——也可能是本机上一处未修的 bug 在同一路径上留下的痕迹。
