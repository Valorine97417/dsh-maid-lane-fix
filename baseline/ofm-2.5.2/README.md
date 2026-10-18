# EAC 补丁的还原基线（上游 v2.5.2）

这三份 `.gz` 是 **`dsh-our-free-model` v2.5.2 的原文**，正是补丁器要改的那三个文件在**打补丁之前**的样子：

| 压缩包 | 解出来是 | 原始 sha256 |
| --- | --- | --- |
| `client.js.gz` | `client.js` | `7a4377571cbdd707704a08b92ea2b0b64bf6a3cb4aa00ee89eb73b9d211f6353` |
| `index.js.gz` | `index.js` | `3bc572ed72e27543b4c4dc38c42911ec8e6d245ca9165d382022c889893409f2` |
| `src__http.js.gz` | `src/http.js` | `982a5bef246bdff705be081bb25205c4e168f5741cb52a4bb37859e793bf35a3` |

`src__http.js` 里的 `__` 是补丁器备份文件的命名法（`name.replace(/\//g, '__')`），解压出来要放回 `src/http.js`。

## 为什么放这一份在仓库里

补丁器的 `--restore` 依赖包目录里的 `.lane-fix-orig/`。把基线放进仓库，还原依据就跟代码一起走版本控制，不依赖任何一台机器的运行时状态。

## 怎么用

解压覆盖回上游包（**先确认包版本就是 v2.5.2**）：

```bash
PKG=~/.dsh/profiles/desktop/node_modules/dsh-our-free-model

gunzip -c baseline/ofm-2.5.2/client.js.gz    > "$PKG/client.js"
gunzip -c baseline/ofm-2.5.2/index.js.gz     > "$PKG/index.js"
gunzip -c baseline/ofm-2.5.2/src__http.js.gz > "$PKG/src/http.js"

# 校验（应与 SHA256SUMS 三行一致）
cd "$PKG" && sha256sum client.js index.js src/http.js
```
