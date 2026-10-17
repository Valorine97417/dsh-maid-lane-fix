# EAC 补丁的还原基线（上游 v2.5.0）

这三份 `.gz` 是 **`dsh-our-free-model` v2.5.0 的原文**，正是补丁器要改的那三个文件在**打补丁之前**的样子：

| 压缩包 | 解出来是 | 原始 sha256 |
| --- | --- | --- |
| `client.js.gz` | `client.js` | `9e1fe4bf301acc8c3fe75a2fda1fc5d50ac48938ac88d4cd981e819bea416db0` |
| `index.js.gz` | `index.js` | `9e509a7dfd8c42a1c625e778b21737d5e756ac6bf2fcb38ef202ddd5933dbd91` |
| `src__http.js.gz` | `src/http.js` | `79bbf303933001d4e48cd309639e60edc34d1d6c2bbb8298d28168e96cac245c` |

`src__http.js` 里的 `__` 是补丁器备份文件的命名法（`name.replace(/\//g, '__')`），解压出来要放回 `src/http.js`。

## 为什么放这一份在仓库里

补丁器的 `--restore` 依赖包目录里的 `.lane-fix-orig/`。那份备份有两个弱点：

1. **它是运行时产物**——只在你第一次落盘时生成，落盘之前不存在；
2. **它随时可能被清掉**——`node_modules` 被重装、被上游升级覆盖、被清理脚本扫过，它就没了，`--restore` 会直接 `exit 1` 说「没有备份，无法回滚」。（本机 2026-10-15 实测栽过一次：`.lane-fix-orig/` 被 sweep 连带清掉。）

把基线放进仓库，还原依据就跟代码一起走版本控制，不依赖任何一台机器的运行时状态。

## 怎么用

解压覆盖回上游包（**先确认包版本就是 v2.5.0**，解错了版本等于把文件换成别的版本）：

```bash
# 包目录，默认位置见 README「二、补丁器」
PKG=~/.dsh/profiles/desktop/node_modules/dsh-our-free-model

gunzip -c baseline/ofm-2.5.0/client.js.gz    > "$PKG/client.js"
gunzip -c baseline/ofm-2.5.0/index.js.gz     > "$PKG/index.js"
gunzip -c baseline/ofm-2.5.0/src__http.js.gz > "$PKG/src/http.js"

# 校验（应与 SHA256SUMS 三行一致）
cd "$PKG" && sha256sum client.js index.js src/http.js
```

校验通过后就是**干净的 v2.5.0**：`node scripts/patch-ofm.mjs --dry-run` 应报「7 处待应用」，而不是「已应用」。

## 注意

- 这是**还原用**的基线，不是上游分发物——它不在上游 `package.json` 的 `files` 白名单里，是 `dsh-maid-lane-fix` 自己存的档案。
- 上游发新版（v2.6.0…）后，这份基线**对应的是 v2.5.0**，锚点可能已经变了：新版本要重新导一份基线（见主 README「二、补丁器 · 还原基线」的取法），别拿旧基线往新包上盖。
- **本基线取自已验签的 2.5.0 发行清单**（`feed/manifest.json` 的 sha256 逐文件核对通过），不是从打过补丁的现行文件里倒推的。
