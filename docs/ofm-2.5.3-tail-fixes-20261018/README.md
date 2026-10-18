# OFM 2.5.3 尾项补修记录（2026-10-18）

## 一、概述

在 `dsh-our-free-model`（OFM）2.5.3 版本中，针对先前审计留存的两个尾项问题完成分析、补丁工程化升级与落盘验证：
1. **`swap-min-interval`**：换号最小间隔（修复旧锚点漂移至饱和重试分支导致的失效问题，重新定位至真正账号轮换路径，增加 600ms 间隔并带 abort 守卫，不阻塞首请求）。
2. **`benefit-bare-4004`**：华为云 CodeArts 裸 4004 业务码映射与摘戳重试（上游全串等值匹配 `InferHub.4004.200` 导致裸 `"4004"` 被误判为 `INVALID_REQUEST` 无法触发重试）。

补丁已由观察点（`WATCHPOINTS`）正式升级为 `patchkit/patches.mjs` 中的 `PATCHES`，并成功通过 `patch-pack.mjs` 备份落盘，现有 `codearts-signed-headers` 与 `codearts-signed-decl` 经检验完全不受影响且保持生效。

---

## 二、问题成因与技术方案

### 1. `swap-min-interval`（换号最小间隔）

- **历史与漂移根因**：
  - 在旧版 OFM（2.4.0 之前）中，限流重试与换号共用循环，循环内有 `await sleepMs(waitMs)`，旧补丁改写为 `Math.max(waitMs, 600)` 以防止同 IP 短时间内秒级轮换多个账号触发风控。
  - 上游 2.4.0 重构时新增了**模型级饱和重试**分支（`isModelSaturationError`，报文 `14003 model busy`），上游自陈「在本账号重试——不换号」，其延迟 `waitMs = buddySaturationDelayMs(attempt) ≈ 2000 * n >= 2000ms`；
  - 旧补丁锚点不幸漂移并被留在了该饱和重试分支中，`Math.max(waitMs, 600)` 恒等于 `waitMs`，补丁退化为空操作；
  - 与此同时，真正的账号轮换逻辑（`BuddyAdapter.stream` 中 `if (this.options.accountPool && isRateLimited(errorText, response.status))`，位于原 `pack.js:35479-35530`）变为了**无任何延迟的零间隔紧凑循环**。一旦发生限流，若账号池有多账号，将在数毫秒内连打换号，极易引发服务商风控关联封锁。

- **修复方案**：
  - 准确定位真实的换号路径锚点：在 `getAvailableAccount` 成功获取新可用账号 `next` 之后、发起网络调用 `this.send(credential, body, options)` 之前插入最小 600ms 间隔；
  - **不阻塞首请求**：首请求（`let response = await this.send(...)`，`pack.js:35357`）在进入换号重试分支之前发出，完全不经过此延迟逻辑；
  - **Abort 守卫**：
    - 等待前检查 `if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");`；
    - 在 600ms 定时器等待期间挂载 `options.signal` 的 `abort` 监听器，一旦收到中断信号立即 `clearTimeout` 并抛错中止，不盲等 600ms，更不会在中断后向外发出无谓请求。

- **精确锚点与替换**：
  - **Find（上游原文）**：
    ```javascript
              const next = await this.options.accountPool.getAvailableAccount(
                this.product.id,
                options.model,
                tried
              );
              if (!next || tried.has(next.entry.id)) break;
              tried.add(next.entry.id);
              credential = next.credential;
              currentAccountId = next.entry.id;
              response = await this.send(credential, body, options);
              if (response.ok) {
                yield* this.consumeSse(response, options, currentAccountId);
    ```
  - **Replace（补丁后）**：
    ```javascript
              const next = await this.options.accountPool.getAvailableAccount(
                this.product.id,
                options.model,
                tried
              );
              if (!next || tried.has(next.entry.id)) break;
              tried.add(next.entry.id);
              credential = next.credential;
              currentAccountId = next.entry.id;
              /* patched(小困 2026-10-18, swap-min-interval): 换号最小间隔 600ms（带 abort 守卫，不阻塞首请求）。
               避免同一出口 IP 上秒级轮换多个账号触发风控关联特征。若收到中断信号立即退出，不盲等不发请求。 */
              if (options.signal?.aborted) {
                throw options.signal.reason ?? new Error("aborted");
              }
              await new Promise((resolve2, reject) => {
                const onAbort = () => {
                  clearTimeout(timer);
                  reject(options.signal?.reason ?? new Error("aborted"));
                };
                const timer = setTimeout(() => {
                  options.signal?.removeEventListener?.("abort", onAbort);
                  resolve2();
                }, 600);
                options.signal?.addEventListener?.("abort", onAbort, { once: true });
              });
              response = await this.send(credential, body, options);
              if (response.ok) {
                yield* this.consumeSse(response, options, currentAccountId);
    ```

---

### 2. `benefit-bare-4004`（裸 4004 业务码映射与摘戳重试）

- **调用链路与失效成因**：
  - CodeArts 请求在带权益模型上默认在请求头附带 `maas_type: "benefit"`；
  - 针对无权益账号，华为云 APIG / InferHub 服务端在 HTTP 200 响应的 SSE 首帧返回业务错误 JSON；
  - 上游实现期望匹配 `CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE = "InferHub.4004.200"`，并在匹配成功时抛出带有 `BENEFIT_NOT_FOUND_CODE`（`"BENEFIT_NOT_FOUND"`）的 `LlmError2`；
  - 外层重试循环（`pack.js:33257`）：
    ```javascript
    } else if (error instanceof LlmError2 && error.code === BENEFIT_NOT_FOUND_CODE && isBenefitModel && !benefitHeaderDropped) {
      benefitHeaderDropped = true;
      continue;
    }
    ```
    负责捕获该错误、将 `benefitHeaderDropped` 置为 `true`，从而摘掉 `maas_type` 请求头并重新发起请求走普通计费通道；
  - **实测断链**：华为云服务端常只回裸业务码 `"4004"`（即 `data.error_code === "4004"`），全串等值匹配 `InferHub.4004.200` 失败，直接落入末尾分支抛出 `INVALID_REQUEST`，外层无法识别，摘戳重试彻底落空。

- **修复方案**：
  - 在 `CodeArtsAdapter.consumeSse` 内部的错误码判断中，将裸 `"4004"` 及数字 `4004` 映射至 `BENEFIT_NOT_FOUND_CODE`；
  - 恢复外层摘戳重试信号通路。

- **精确锚点与替换**：
  - **Find（上游原文）**：
    ```javascript
                if (isSseQueueErrorCode(data.error_code)) {
                  throw new SseQueueRetryError(data.error_code, message2);
                }
                if (data.error_code === CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE) {
                  throw new LlmError2(`codearts: ${message2}`, BENEFIT_NOT_FOUND_CODE, { status: 200 });
                }
                throw new LlmError2(`codearts: ${message2}`, "INVALID_REQUEST", { status: 200 });
    ```
  - **Replace（补丁后）**：
    ```javascript
                if (isSseQueueErrorCode(data.error_code)) {
                  throw new SseQueueRetryError(data.error_code, message2);
                }
                /* patched(小困 2026-10-18, benefit-bare-4004): 裸 4004 业务码映射到 BENEFIT_NOT_FOUND_CODE，触发摘戳重试。
                 上游实测响应常只回裸 "4004"，全串等值匹配 InferHub.4004.200 会落空至 INVALID_REQUEST。 */
                if (data.error_code === CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE || data.error_code === "4004" || String(data.error_code) === "4004") {
                  throw new LlmError2(`codearts: ${message2}`, BENEFIT_NOT_FOUND_CODE, { status: 200 });
                }
                throw new LlmError2(`codearts: ${message2}`, "INVALID_REQUEST", { status: 200 });
    ```

---

## 三、文件落盘与核验台账

### 1. 修改文件
- **补丁集正本**：`C:/Users/Kayle/.dsh/our-free-model/patchkit/patches.mjs`
  - 将 `swap-min-interval` 和 `benefit-bare-4004` 移出 `WATCHPOINTS` 并升级至 `PATCHES`（共 4 处补丁）；
  - 保留 `false-risk-11128` 和 `wb-conversation-headers` 于 `WATCHPOINTS`。
- **运行目标包**：`C:/Users/Kayle/.dsh/profiles/desktop/node_modules/dsh-our-free-model/vendor/channel-pack/pack.js`
  - 原文件已安全备份为：`pack.js.bak-repatch-20261018-171346211`；
  - 字节变动：`2765888` → `2766877` 字节。

### 2. 补丁应用状态核验
运行 `node scripts/patch-pack.mjs --verify` 输出：
```
4 处补丁 → C:\Users\Kayle\.dsh\profiles\desktop\node_modules\dsh-our-free-model\vendor\channel-pack\pack.js

  ✓ 已应用  codearts-signed-headers   （content-type 不参与签名）
  ✓ 已应用  codearts-signed-decl      （声明数组与 canonical 必须同剔）
  ✓ 已应用  swap-min-interval         （换号最小间隔 600ms（带 abort 守卫）
  ✓ 已应用  benefit-bare-4004         （裸 4004 业务码映射到 BENEFIT_NOT_FOUND_CODE）
  ⊙ 观察点  false-risk-11128          （不自动补，锚点在）
  ⊙ 观察点  wb-conversation-headers   （不自动补，锚点在）

小结：已应用 4 / 待应用 0 / 锚点异常 0
全部已应用。
```

### 3. Smoke 冒烟自测
运行 `node scripts/smoke.mjs`：
```
=== ① 三态识别 ===
  PASS 未打补丁时：全部报「待应用」 — 待应用 4/4
  PASS 未打补丁时：无锚点异常
=== ② 落盘 ===
  PASS 落盘后报「全部已应用」 — 已应用 4/4
  PASS 文件内容确实变了 — 1476 → 2998 字节
  PASS 每条补丁的小困注释都在（可审计）
  PASS 原文备份已生成
=== ③ 幂等 ===
  PASS 再跑一次字节数不变（不重复叠加） — 2998 → 2998
  PASS 再跑时提示无需重打
=== ④ 锚点异常时整批中止 ===
  PASS 锚点缺失 → 退出码非 0 — exit=1
  PASS 锚点缺失 → 报「整批中止」
  PASS 锚点缺失 → 文件未被修改
=== ⑤ 回滚 ===
  PASS 回滚后与落盘前逐字节一致 — 1476 vs 1476
=== ⑥ 参数白名单 ===
  PASS 不认识的参数 → 报「未知参数」
  PASS 不认识的参数 → exit 2 — exit=2
  PASS 不认识的参数 → 绝不落到默认动作（文件未变）
=== ⑦ 备份文件名的毫秒精度（防同秒覆盖）===
  PASS 两次落盘生成了两个不同名的备份（毫秒精度生效）
  PASS 备份文件名带毫秒
  PASS 第 1 次落盘后确实写入了补丁

结果: 18 通过 / 0 失败
```

---

## 四、可重放指引

若日后 OFM 再次全量升级并覆盖 `vendor/channel-pack/pack.js`，只需执行标准可重放步骤：

```bash
# 1. 体检（确保锚点存活）
node C:/Users/Kayle/.dsh/our-free-model/patchkit/scripts/patch-pack.mjs --dry-run

# 2. 自动落盘
node C:/Users/Kayle/.dsh/our-free-model/patchkit/scripts/patch-pack.mjs

# 3. 严格核验
node C:/Users/Kayle/.dsh/our-free-model/patchkit/scripts/patch-pack.mjs --verify

# 4. 冒烟测试
node C:/Users/Kayle/.dsh/our-free-model/patchkit/scripts/smoke.mjs

# 5. 重启 DSH 桌面端以加载新 channel-pack 运行时
```
