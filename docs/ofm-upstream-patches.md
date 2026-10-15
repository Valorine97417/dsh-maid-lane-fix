# 存档：我们给上游提过、但没能推上去的指纹补丁

**这份东西是历史档案，不是代码资产。** 留着是为了记住「那天我们自己摸出来的修法长什么样」，不是为了让谁去用它。

## 是什么

`ofm-upstream-patches.patch` —— 相对 `Ebony-Vinyl/dsh-our-free-model` 的 `main`（基线 `8c810d1`），我们本地工作副本 `D:\DeepSeek Harness\Works\dsh-our-free-model` 领先的 **3 个实质 commit** 压成的一份 patch：

| 原始 commit | 改了什么 |
| --- | --- |
| `0d06056` | `sessionForConversation` / `requestIdFor` 的 12 位 hex 头改用规范时间编码 `~(ms×0x1000+seq)`，摘要只喂 14 字节尾巴；固定 epoch 保证跨重启字节稳定 |
| `af5c444` | 派生 request id 的计数器 clamp 到 12 位（`& 0xfff`） |
| `6bcf2e6` | `userAgentWith()` 剥掉 `deepseek-harness/<版本号>` 这个 token，保住归属 UA 本身 |

（原第 4 笔 `c5f7559` 是删临时探针脚本，没内容，已略去。）

## 为什么推不上去

工作副本的 `origin` 指向上游 `Ebony-Vinyl/dsh-our-free-model`，我们没有写权限，也没有 fork。

## 为什么没建 fork

2026-10-15 核过一遍：**上游 `main` 已经用等价（更简洁）的写法覆盖了这三点**——

- UA 那道：上游 `src/http.js` 有 `UA_REFUSED = /deepseek[-_]harness/gi` 的剥离逻辑；
- 时间前缀：上游 `mintSessionId()` 直接铸 `~(ms×0x1000+seq)`，派生 id 走缓存而非摘要头；
- 计数器 clamp：上游 request id 是固定 `+1n`，压根不递增，不需要 clamp。

所以这 3 笔的**活代码价值为零**——同样的修法已经活在 `lib/lane.js` 里（中间层不依赖上游怎么改）。为一个已被上游覆盖的补丁 fork 一个仓库，只会让一份公开副本挂着我们当时的探测过程。

## 怎么用（真要的话）

```bash
# 在上游仓库的干净 checkout 里
git apply --check docs/ofm-upstream-patches.patch   # 先验
git apply docs/ofm-upstream-patches.patch
```

**不要**在 `node_modules` 里的部署副本上打这个 patch —— 那份现在是上游 `main` 的代码，已经自带全部修法，打上去只会冲突。真要用就用在旧的 `v2.2.0` 标签上（那版确实缺）。

## 为什么不进 `package.json` 的 `files`

`docs/` 故意不在分发白名单里：这是仓库里的档案，不该随插件安装副本发到别人的机器上。`git clone` 看得到，`pnpm add` 装不到——正合适。
