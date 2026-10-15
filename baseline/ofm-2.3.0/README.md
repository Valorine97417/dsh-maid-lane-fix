# EAC 补丁的还原基线（上游 v2.3.0）

这三份 `.gz` 是 **`dsh-our-free-model` v2.3.0 的原文**，正是补丁器要改的那三个文件在**打补丁之前**的样子：

| 压缩包 | 解出来是 | 原始 sha256 |
| --- | --- | --- |
| `client.js.gz` | `client.js` | `21c387c6ebe04fc3cf4f9bedac33e53832f6fb7fd92152fd543455f9351774b6` |
| `index.js.gz` | `index.js` | `8d8a4b541e3740c455e4c2735abd608b3999a11a1646a5e338f0e9a226c74ff0` |
| `src__http.js.gz` | `src/http.js` | `43b3cb0a62a0476c2602d0500da542090391fa7a81048af721c8c454c9339ac9` |

`src__http.js` 里的 `__` 是补丁器备份文件的命名法（`name.replace(/\//g, '__')`），解压出来要放回 `src/http.js`。

## 为什么放这一份在仓库里

补丁器的 `--restore` 依赖包目录里的 `.lane-fix-orig/`。那份备份有两个弱点：

1. **它是运行时产物**——只在你第一次落盘时生成，落盘之前不存在；
2. **它随时可能被清掉**——`node_modules` 被重装、被上游升级覆盖、被清理脚本扫过，它就没了，`--restore` 会直接 `exit 1` 说「没有备份，无法回滚」。（本机 2026-10-15 实测栽过一次：`.lane-fix-orig/` 被 sweep 连带清掉。）

把基线放进仓库，还原依据就跟代码一起走版本控制，不依赖任何一台机器的运行时状态。

## 怎么用

解压覆盖回上游包（**先确认包版本就是 v2.3.0**，解错了版本等于把文件换成别的版本）：

```bash
# 包目录，默认位置见 README「二、补丁器」
PKG=~/.dsh/profiles/desktop/node_modules/dsh-our-free-model

gunzip -c baseline/ofm-2.3.0/client.js.gz    > "$PKG/client.js"
gunzip -c baseline/ofm-2.3.0/index.js.gz     > "$PKG/index.js"
gunzip -c baseline/ofm-2.3.0/src__http.js.gz > "$PKG/src/http.js"

# 校验（应与 SHA256SUMS 三行一致）
cd "$PKG" && sha256sum client.js index.js src/http.js
```

校验通过后就是**干净的 v2.3.0**：`node scripts/patch-ofm.mjs --dry-run` 应报「7 处待应用」，而不是「已应用」。

## 注意

- 这是**还原用**的基线，不是上游分发物——它不在上游 `package.json` 的 `files` 白名单里，是 `dsh-maid-lane-fix` 自己存的档案。
- 上游发新版（v2.4.0…）后，这份基线**对应的是 v2.3.0**，锚点可能已经变了：新版本要重新导一份基线（见主 README「二、补丁器 · 还原基线」的取法），别拿旧基线往新包上盖。
