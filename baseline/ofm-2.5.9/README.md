# EAC 补丁的还原基线（上游 v2.5.9）

这五份 `.gz` 是 **`dsh-our-free-model` v2.5.9 发布包的原文**，覆盖补丁集 v6 的四个补丁目标文件（`client.js` / `src/http.js` / `src/eac.js` / `vendor/channel-pack/pack.js`），并额外归档 `index.js` —— index.js 的三处补丁自 v4 起已作废（上游 2.5.7 原生化），归档它只为上游若回退 bench 重构时重锚取证。

`vendor/channel-pack/pack.js` 是 v6 追加的第五份：`developer-role-on-chat-wire` 这一处必须落在构建产物上（包里的 `vendor/` 是打包好的 JS，改 `src/*.ts` 不生效），补丁器要在内存里拿它的干净原文重放才能 `--verify`。

## 来源与交叉验证（2026-10-23 采集，现役包 auto-update 到 2.5.9 之后）

三路交叉，与 `ofm-2.5.7/README.md` 同一套方法（v6 追加的 `pack.js` 走第 1、2 两路）：

1. **官方签名 feed manifest × 现役包字节**：`https://raw.githubusercontent.com/Ebony-Vinyl/dsh-our-free-model/main/feed/manifest.json` 当时 `version = 2.5.9`、`publishedAt = 2026-10-22T03:36:10.088Z`，其 `files[]` 里四个包根目标文件的 `sha256` / `size` 与现役包（`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-our-free-model`）**逐字节一致**——现役就是官方发布原文，不是半打或手改状态。`vendor/channel-pack/pack.js` 同法核对：与官方发布包 tgz 内同名文件 sha256 一致（2592919 B）。
2. **jsdelivr tag `v2.5.9`（`cdn.jsdelivr.net/gh`）**：`index.js`、`src/http.js`、`src/eac.js` 三份与发布包一致；`client.js` 的 tag 源码树哈希是 `487abaae4c62c1ecded7650fff363447b055b311b6c7d513cdc46b4f7977adac`，与发布包不同——这是上游**发布构建与源码树的差异**（同 2.5.7 的已知偏差），基线取发布包字节（补丁锚点必须落在落盘目标上逐字节命中）。`vendor/channel-pack/pack.js` 同理属构建产物，只以发布包字节为准，不与源码树比。
3. **未被补丁污染**：现役四文件里 lane-fix marker（`progressed`、`EAC_BODY_LIMIT_BYTES`、`availability.flush()`、`const skipped = entry`）全部 **0 处命中**；`client.js` 里唯一的 `330_000)` 命中是**上游自己**的 bench 超时值（2.5.7 起上游已改，见 `lib/ofm-patch.js` 的 v4 说明），不是本地补丁残留。`pack.js` 上 `if (role === "system" || role === "developer")` 打前 0 处命中（证明存的是干净原文，不是打过补丁的落盘状态）。`.lane-fix-orig/` 里只有 `src__http.js` / `src__eac.js` 两份 10-21 旧备份，哈希与 2.5.9 原文相同（这两个文件 2.5.3 起上游一字未动），属于合法原文备份。

| 压缩包 | 解出来是 | 原始 sha256 | 字节 |
| --- | --- | --- | --- |
| `client.js.gz` | `client.js` | `5c71baca0a655d5b71cba1529725d5d44acec93c0ee440f3af31ad74b02f5ca2` | 508469 |
| `index.js.gz` | `index.js` | `13ada5d9d54d8f2c30f2431de758154e3c3c07bd4be19f2a7c2865a1de561fcb` | 112937 |
| `src__http.js.gz` | `src/http.js` | `982a5bef246bdff705be081bb25205c4e168f5741cb52a4bb37859e793bf35a3` | 28004 |
| `src__eac.js.gz` | `src/eac.js` | `359f5729ab22bdf406c6f1c0c4817eb1a1b6f3099c07dcaeb1558503333314b5` | 13561 |
| `vendor__channel-pack__pack.js.gz` | `vendor/channel-pack/pack.js` | `0a70f2ab6396154121663aa79dddf1fe50710686c61bd6aad3abcb5b9b20592c` | 2592919 |

`src__http.js` / `vendor__channel-pack__pack.js` 里的 `__` 是补丁器备份文件的命名法（`name.replace(/\//g, '__')`），解压出来要放回 `src/http.js` / `vendor/channel-pack/pack.js`。

## 相对 ofm-2.5.7 变了什么

- `src/http.js`、`src/eac.js`：**与 2.5.7 / 2.5.3 基线逐字节相同**（sha256 一致、gz 体积一致）。补丁集 v4 的 7 处锚点（空闲时钟 4 处 + EAC body 上限 3 处）在 2.5.9 上**逐字仍在**，故 v5 零重锚、零新作废。
- `client.js`：2.5.7→2.5.9 的改动是前端「视觉特效」开关（新增 `effects.enabled` 文案、`.ofm_navtools` 布局、`data-ofm-effects="off"` 一套降级样式）与 `.ofm_navspacer` 移除；`post('/bench', …, 330_000)` 一带未动。
- `index.js`：渠道条目精简（`白嫖 channels` 里 CodeArts/华为云移除、`outlet.fetchSigned` 收窄、挂载日志文案改成「10 account providers」），bench 相关代码仍在上游 2.5.7 的重构位置（`src/core/runtime.js` + `src/model-test.js`），三处 index.js 补丁维持 RETIRED。
- `vendor/channel-pack/pack.js`（v6 新增归档）：2.5.9 的 `convertMessage()`（`pack.js:56153`）只分派 system / user / assistant / tool，末尾 `throw … unsupported message role`——developer 角色直接 400；同文件 Responses 侧（`:56723`）上游自己已认 `system || developer`，Chat wire 这侧漏了。补丁集 v4/v5 的文档写了这一处、代码里没落地，v6 才补回并归档其干净原文。

## 为什么这一版必须存

补丁器的 `--verify` 与 `--restore` 都要求「仓内有与包版本匹配的干净基线」：缺了它 `--verify` 直接抛「缺少当前版本干净基线，无法逐字节核对」、`--restore` 拒绝回滚，整套验收跑不完整；落盘前的备份判定也靠它（文件与基线不符时只落 `.patched-*`，不落常规备份）。2026-10-23 auto-update 把包从 2.5.7 顶到 2.5.9、v4 补丁被整包覆盖冲掉（`--verify` 7 处 `待应用`），就是靠补这个目录才恢复了对齐。

`pack.js` 这份尤其不能省：`loadBaseline()` 按 `PATCHED_FILES` **逐个成员**去 `SHA256SUMS` 找条目、去目录找 `<name>.gz`，缺一条就抛「基线与补丁集不同步」——只要补丁集里含 `vendor/channel-pack/pack.js`，这个目录少一份 `.gz` 就整套验收跑不起来。

## 怎么用

解压覆盖回上游包（**先确认包版本就是 v2.5.9**）：

```bash
PKG=~/.dsh/profiles/desktop/node_modules/dsh-our-free-model

gunzip -c baseline/ofm-2.5.9/client.js.gz    > "$PKG/client.js"
gunzip -c baseline/ofm-2.5.9/index.js.gz     > "$PKG/index.js"
gunzip -c baseline/ofm-2.5.9/src__http.js.gz > "$PKG/src/http.js"
gunzip -c baseline/ofm-2.5.9/src__eac.js.gz  > "$PKG/src/eac.js"
gunzip -c baseline/ofm-2.5.9/vendor__channel-pack__pack.js.gz > "$PKG/vendor/channel-pack/pack.js"

# 校验（应与 SHA256SUMS 五行一致）
cd "$PKG" && sha256sum client.js index.js src/http.js src/eac.js vendor/channel-pack/pack.js
```
