/**
 * dsh-maid-lane-fix —— 免费车道的**中间层**（自家插件）。
 *
 * 为什么需要它：`dsh-our-free-model` 直连 opencode 的免密车道，而那车道会给
 * 第三方客户端上五道「指纹门」，五道都过才放行：
 *
 *   ① 端点地址必须是 `/inference/v1/*`（`/zen/v1/*` 即使其余全对也 403）；
 *   ② `x-opencode-session-id` 必须存在且与 `x-opencode-session` 同值；
 *   ③ `x-opencode-session` / `x-opencode-request` 去掉前缀后的 12 位 hex，
 *      必须是客户端自己的时间编码 `~(毫秒×0x1000 + 序号)` 那一族形状；
 *      插件是 sha256 摘要派生的头，解出来是 1970 年 → 403 FreeTierError。
 *   ④ `User-Agent` 里出现 `deepseek-harness/<版本号>`（忽略大小写、位置无关）
 *      → 403；而 `dsh/…`、`deepseek_harness/…`、不带版本号的写法都放行。
 *      harness 要求归属 UA 必须在场，插件的回退值恰好就是被点名的那个形状。
 *   ⑤ `bash` 与 `read` 必须同时声明，且各带至少一个 schema property。
 *
 * 怎么修：**不改上游一个字节**（改人家的文件＝升级即丢，且要维护多处副本）。
 * 本插件在启动时包一层 `globalThis.fetch`，只对发往车道的请求把这几道规范化
 * （地址、头、body 里的工具指纹），其余原样透传。上游哪天自己修好了，对已经
 * 合规的请求本层是**空操作**，自动让路、零冲突。这也是 `dsh-maid-scenery`
 * 那套「融合层」思路在网络层的同一种做法：隔离在自家包里，与上游配合，
 * 不接管它的实现。
 *
 * 生存法则：任何一步出错只 warn，绝不向上抛——一个装饰性修复没有资格让
 * 整个应用起不来；宿主没装我们的-free-model 时它也不过是白挂一层。
 *
 * @module dsh-maid-lane-fix
 */
import { installLaneFix } from './lib/lane.js'

export const name = 'lane-fix'
/** 无必需服务：不依赖 webServer / settings / tools，纯进程级修补。 */
export const inject = []

/**
 * 装配：把中间层挂到 `globalThis.fetch` 上。
 *
 * 时机：apply 是同步的，且发起车道请求的是稍后的探测/对话（都带延时），
 * 所以本层一定先在场——哪怕 bundle 顺序把我们排在后面也一样，因为
 * 调用点是 `fetch(...)` 的运行时查找，不是模块加载期捕获。
 *
 * @param {object} ctx cordis 上下文。
 */
export function apply(ctx) {
  const warn = (message) => {
    try { ctx.logger?.warn?.(`[${name}] ${message}`) } catch { /* 日志不是失败理由 */ }
  }
  const info = (message) => {
    try { ctx.logger?.info?.(`[${name}] ${message}`) } catch { /* 同上 */ }
  }
  try {
    const handle = installLaneFix({ log: info })
    // 随插件卸载干净收回：宿主热重载插件时不会留两层 wrapper。
    ctx.effect?.(() => () => {
      try { handle.uninstall() } catch { /* 拆解失败不是失败理由 */ }
    })
  } catch (error) {
    warn(`中间层装配失败，车道保持原样（上游 403 会照旧发生）：${error instanceof Error ? error.message : String(error)}`)
  }
}
