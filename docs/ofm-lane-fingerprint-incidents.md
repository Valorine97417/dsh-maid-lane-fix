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
