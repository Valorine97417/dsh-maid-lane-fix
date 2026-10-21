# EAC 补丁的还原基线（上游 v2.5.7）

这四份 `.gz` 是 **`dsh-our-free-model` v2.5.7 发布包的原文**，覆盖补丁集 v4 的三个补丁目标文件（`client.js` / `src/http.js` / `src/eac.js`），并额外归档 `index.js` —— v4 起 index.js 的三处补丁已被 2.5.7 原生化作废，但上游若回退 bench 重构，重锚要用这份原文。

## 来源与交叉验证（2026-10-21 重锚时采集）

npm 源无 `dsh-our-free-model`（`npm pack` 报 ETARGET），GitHub 直连超时；基线按三路交叉取证：

1. **现役包字节 = 上游发布字节**：`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-our-free-model` 的 `client.js`、`index.js` sha256 与官方签名 feed manifest（`https://raw.githubusercontent.com/Ebony-Vinyl/dsh-our-free-model/main/feed/manifest.json`，当时版本 2.5.8，这两个文件与 2.5.7 发布相同）逐字节一致；`src/http.js`、`src/eac.js` 与 git tag `v2.5.7`（经 `cdn.jsdelivr.net/gh`）逐字节一致，且与 `ofm-2.5.3` 基线相同（这两个文件 2.5.3→2.5.7 上游没动）。
2. **未被补丁污染**：现役 4 个文件里 lane-fix marker（`availability.flush()`、`progressed`、`EAC_BODY_LIMIT_BYTES`、`const skipped = entry`）全部 0 处命中；`.lane-fix-orig/` 在落盘前不存在——现役是干净的未打状态，不是半打。
3. **已知偏差**：git tag `v2.5.7` 源码树的 `index.js`/`client.js` 含 CodeBuddy/WorkBuddy 渠道条目，发布包（现役）不含——这是上游**发布构建与源码树的差异**（6 行），与本机改动无关。基线取发布包字节（现役原文），不取 tag 源码，因为补丁锚点必须在落盘目标上逐字节命中。

| 压缩包 | 解出来是 | 原始 sha256 |
| --- | --- | --- |
| `client.js.gz` | `client.js` | `46f5764bd3f546770f1a280a3128d27fa45d7cd14d30ccc289098ce933f14880` |
| `index.js.gz` | `index.js` | `2a75a0d3dbcbd820568beefcc784e07cd20391e394f0f6f1654ce32f296ec4e5` |
| `src__http.js.gz` | `src/http.js` | `982a5bef246bdff705be081bb25205c4e168f5741cb52a4bb37859e793bf35a3` |
| `src__eac.js.gz` | `src/eac.js` | `359f5729ab22bdf406c6f1c0c4817eb1a1b6f3099c07dcaeb1558503333314b5` |

`src__http.js` 里的 `__` 是补丁器备份文件的命名法（`name.replace(/\//g, '__')`），解压出来要放回 `src/http.js`。

## 为什么这一版必须存

补丁器的 `--verify` 与 `--restore` 都要求「仓内有与包版本匹配的干净基线」，缺了它 `--verify` 直接报错、`--restore` 拒绝回滚。v2.5.7 落盘时若无此目录，整套验收跑不完（2026-10-21 失配修复时补入）。

## 怎么用

解压覆盖回上游包（**先确认包版本就是 v2.5.7**）：

```bash
PKG=~/.dsh/profiles/desktop/node_modules/dsh-our-free-model

gunzip -c baseline/ofm-2.5.7/client.js.gz    > "$PKG/client.js"
gunzip -c baseline/ofm-2.5.7/index.js.gz     > "$PKG/index.js"
gunzip -c baseline/ofm-2.5.7/src__http.js.gz > "$PKG/src/http.js"
gunzip -c baseline/ofm-2.5.7/src__eac.js.gz  > "$PKG/src/eac.js"

# 校验（应与 SHA256SUMS 四行一致）
cd "$PKG" && sha256sum client.js index.js src/http.js src/eac.js
```
