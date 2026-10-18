# EAC 补丁的还原基线（上游 v2.5.3）

这四份 `.gz` 是 **`dsh-our-free-model` v2.5.3 的原文**，覆盖补丁集 v3 的四个文件。

2026-10-18 补入 `src/eac.js`：本地发行归档 `D:/Works By DSH/dsh-our-free-model-2.5.3.tgz` 与 `_probe/` 下同名副本的归档 SHA256 均为 `ae61cc2b393cd304f5f02cac0f88ba23052ea8de1c9cfd32c8651ebca7a87952`。核对归档内包版本为 2.5.3，`package/src/eac.js`、本基线解压结果及应用前现役文件逐字节相等。此为本地发行归档交叉核对，并非重新从远端校验发行签名。

| 压缩包 | 解出来是 | 原始 sha256 |
| --- | --- | --- |
| `client.js.gz` | `client.js` | `7a4377571cbdd707704a08b92ea2b0b64bf6a3cb4aa00ee89eb73b9d211f6353` |
| `index.js.gz` | `index.js` | `3bc572ed72e27543b4c4dc38c42911ec8e6d245ca9165d382022c889893409f2` |
| `src__http.js.gz` | `src/http.js` | `982a5bef246bdff705be081bb25205c4e168f5741cb52a4bb37859e793bf35a3` |
| `src__eac.js.gz` | `src/eac.js` | `359f5729ab22bdf406c6f1c0c4817eb1a1b6f3099c07dcaeb1558503333314b5` |

`src__http.js` 里的 `__` 是补丁器备份文件的命名法（`name.replace(/\//g, '__')`），解压出来要放回 `src/http.js`。

## 为什么放这一份在仓库里

补丁器的 `--restore` 依赖包目录里的 `.lane-fix-orig/`。把基线放进仓库，还原依据就跟代码一起走版本控制，不依赖任何一台机器的运行时状态。

**没有对应版本的基准线时，补丁器无法证明包内文件是原文**，会退一步：备份照做但改名为 `.patched-<时间戳>`，而 `--restore` 只认常规备份——等于这一版落盘之后无法用 `--restore` 回滚。v2.5.3 这份基线就是为此补的。

## 怎么用

解压覆盖回上游包（**先确认包版本就是 v2.5.3**）：

```bash
PKG=~/.dsh/profiles/desktop/node_modules/dsh-our-free-model

gunzip -c baseline/ofm-2.5.3/client.js.gz    > "$PKG/client.js"
gunzip -c baseline/ofm-2.5.3/index.js.gz     > "$PKG/index.js"
gunzip -c baseline/ofm-2.5.3/src__http.js.gz > "$PKG/src/http.js"
gunzip -c baseline/ofm-2.5.3/src__eac.js.gz  > "$PKG/src/eac.js"

# 校验（应与 SHA256SUMS 四行一致）
cd "$PKG" && sha256sum client.js index.js src/http.js src/eac.js
```
