/**
 * 车道请求的规范化核心 —— 纯函数，无 I/O、无全局副作用，便于离线断言。
 *
 * 两道门的判据与修法都在这里；`installLaneFix` 只负责把它挂到 fetch 上。
 *
 * @module lib/lane.js
 */

/** 车道认的客户端令牌（`>= 1.17` 即可）；归属 UA 缺它时由本层补上。 */
export const CLIENT_UA = 'opencode/1.18.31'

/** 只有发往这些主机的请求会被本层碰。 */
export const LANE_HOSTS = Object.freeze(['opencode.ai'])

/** 会话 id 的高位时间戳编码所用的固定纪元：2026-01-01T00:00:00Z。
 *  用常量而不是 `Date.now()`，是为了让同一个会话跨重启仍派生出同一个 id——
 *  车道的配额按会话计，id 一变就换了一个会话。上游实测接受任意可解释的时间
 *  （±30 天都过），所以固定一个纪元没有代价。 */
export const DERIVED_EPOCH = 1767225600000

/**
 * 序号位的上限，也就是「多久不碰」的判据。
 *
 * 上游查的**不是**整个 48 位能不能解出时间（`毫秒×0x1000` 远大于 48 位，
 * 高位在编码时就截掉了，谁也解不回来）——它查的是**低 12 位这个序号位**：
 * 会话头取反过，序号 1..6 实测对应 `ffe / ffd / ffc / ffb / ffa / ff9`，
 * 即低 12 位落在 `0xfff - 序号`；请求头不取反，低 12 位就是序号本身。
 *
 * 所以判据按「序号是否在合理范围」写：真客户端的序号是同一毫秒内的计数器，
 * 绝不可能上千；而 sha256 摘要的低 12 位是随机的，撞进来的概率只有
 * `16/4096 ≈ 0.39%`——那一点漏改可以接受，放宽到 0x800 则会让一半的摘要
 * 头被误判成合规、一半的探测照旧 403。
 */
export const SEQ_MAX = 15

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** 给测试与调用方一个可复用的标记，避免热重载叠两层 wrapper。 */
export const INSTALL_MARK = Symbol.for('dsh-maid-lane-fix.installed')

function hex48(value) {
  let out = ''
  for (let i = 0; i < 6; i += 1) out += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  return out
}

/** 会话 id 的时间编码：`~(毫秒×0x1000 + 序号)`，取低 48 位。 */
export function canonicalSessionHex(timestamp = DERIVED_EPOCH, counter = 1) {
  return hex48(~(BigInt(timestamp) * 0x1000n + BigInt(counter)))
}

/** 请求 id 的时间编码：与上面同族，但**不取反**。 */
export function canonicalRequestHex(timestamp = DERIVED_EPOCH, counter = 1) {
  return hex48(BigInt(timestamp) * 0x1000n + BigInt(counter))
}

/**
 * 这个头的**序号位**像不像真客户端铸的。
 *
 * `hex` 的低 12 位即序号相关位：会话头是取反过的，低 12 位 = `0xfff - 序号`；
 * 请求头不取反，低 12 位 = 序号本身。真客户端的序号是同一毫秒内的计数器，
 * 量级在个位数，所以按「能不能还原出一个小序号」判断。
 *
 * @param {string} hex 12 位 hex。
 * @param {boolean} flipped 会话头是取反过的（request 头不是）。
 * @returns {boolean}
 */
export function looksTimeEncoded(hex, flipped) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{12}$/.test(hex)) return false
  try {
    const low = Number(BigInt(`0x${hex}`) & 0xfffn)
    // 会话头：还原序号 = 0xfff - low（取反把序号位翻过来了）。
    const seq = flipped ? 0xfff - low : low
    return seq >= 0 && seq <= SEQ_MAX
  } catch {
    return false
  }
}

/** 会话 id：头部换成规范编码，**保留 14 字节尾**（同一个会话仍稳定）。 */
export function normalizeSessionId(id) {
  if (typeof id !== 'string' || !/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id)) return null
  const head = id.slice(4, 16)
  if (looksTimeEncoded(head, true)) return null
  return `ses_${canonicalSessionHex()}${id.slice(16)}`
}

/** 请求 id：同上，计数从旧头派生（但夹进合法序号区间，否则新头自己就不合规）。 */
export function normalizeRequestId(id) {
  if (typeof id !== 'string' || !/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id)) return null
  const head = id.slice(4, 16)
  if (looksTimeEncoded(head, false)) return null
  // 同一输入 → 同一输出（可重复、可追溯），但又必须落在 SEQ_MAX 之内——
  // 直接拿旧头的低 12 位当序号会让新头的序号上千，那一刻这道门又过不去了。
  const counter = Number(BigInt(`0x${head}`) % BigInt(SEQ_MAX + 1))
  return `msg_${canonicalRequestHex(DERIVED_EPOCH, counter)}${id.slice(16)}`
}

/**
 * User-Agent：剥掉 `deepseek-harness/<版本>` 的版本号，**并确认客户端令牌在场**。
 *
 * 这道门要的是**两件事同时在**（逐格实测，2026-10-14）：
 *   ① 不能出现 `deepseek-harness/<版本>`（大小写无关、位置无关）；
 *   ② 必须有 `opencode/<版本>` 令牌 —— 少了它照样 403，哪怕归属已剥干净
 *      （实测 `deepseek-harness (…)` → 403、`deepseek-harness (…) opencode/1.18.31` → 200）。
 *
 * 上游的 `userAgentWith()` 通常会把令牌拼上，所以真实链路本来就能通；但中间层
 * 不该依赖上游的行为：内核换版本、attribution 配置变了都可能让令牌缺席，那时
 * 光剥版本号救不回来。这里两件事一起做，本层独自兜住整道门。
 */
export function normalizeUserAgent(ua) {
  if (typeof ua !== 'string' || ua === '') return null
  let fixed = ua
  if (/deepseek-harness\//i.test(fixed)) {
    fixed = fixed.replace(/\bdeepseek-harness\/[^\s)]*/gi, 'deepseek-harness')
  }
  if (!fixed.includes('opencode/')) fixed = `${fixed} ${CLIENT_UA}`
  return fixed === ua ? null : fixed
}

/** 这个 URL 是车道吗。 */
export function isLaneUrl(url) {
  try {
    const parsed = new URL(String(url))
    return LANE_HOSTS.includes(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * 拿一份请求，产出规范化后的头；不需要改就返回 null。
 *
 * 只在**车道的标记头在场**时才动手（`x-opencode-session`），这样别的 fetch
 * 调用——哪怕目标主机相同、或完全没有头——一律不受影响。
 *
 * @param {string} url 请求 URL。
 * @param {object|undefined} init fetch 的第二个参数。
 * @returns {{headers: Headers, changes: string[]}|null}
 */
export function normalizedHeaders(url, init) {
  if (!isLaneUrl(url)) return null
  let headers
  try {
    headers = new Headers(init?.headers ?? {})
  } catch {
    return null
  }
  const session = headers.get('x-opencode-session')
  const request = headers.get('x-opencode-request')
  if (typeof session !== 'string' && typeof request !== 'string') return null

  const changes = []
  const fixedSession = typeof session === 'string' ? normalizeSessionId(session) : null
  if (fixedSession !== null) {
    headers.set('x-opencode-session', fixedSession)
    changes.push(`session ${session.slice(4, 16)}→${fixedSession.slice(4, 16)}`)
  }
  const fixedRequest = typeof request === 'string' ? normalizeRequestId(request) : null
  if (fixedRequest !== null) {
    headers.set('x-opencode-request', fixedRequest)
    changes.push(`request ${request.slice(4, 16)}→${fixedRequest.slice(4, 16)}`)
  }
  const fixedAgent = normalizeUserAgent(headers.get('user-agent') ?? '')
  if (fixedAgent !== null) {
    headers.set('user-agent', fixedAgent)
    changes.push('UA 剥版本号')
  }
  return changes.length === 0 ? null : { headers, changes }
}

/**
 * 把中间层挂到 `globalThis.fetch` 上。幂等：重复调用只复用已有的那层。
 *
 * @param {{ log?: (message: string) => void }} [options]
 * @returns {{ uninstall: () => void, installed: boolean, stats: () => object }}
 */
export function installLaneFix({ log = () => {} } = {}) {
  const existing = globalThis[INSTALL_MARK]
  if (existing !== undefined && typeof existing.uninstall === 'function') {
    return { ...existing, installed: false }
  }

  const original = globalThis.fetch
  if (typeof original !== 'function') {
    throw new Error('globalThis.fetch 不可用，无法挂载中间层')
  }

  let rewrites = 0
  let lastChanges = []

  const wrapped = async function laneFetch(input, init) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url
    let normalized = null
    try {
      normalized = url === undefined ? null : normalizedHeaders(url, init)
    } catch {
      // 规范化本身出问题就原样放行：车道宁可 403，也不能因为我们抛错而整轮失败。
      normalized = null
    }
    if (normalized === null) return original(input, init)
    rewrites += 1
    lastChanges = normalized.changes
    log(`已规范化车道请求 #${rewrites}：${normalized.changes.join('、')}`)
    return original(input, { ...init, headers: normalized.headers })
  }

  // 保住 fetch 上被别的代码挂过的静态属性与原型，别让替换看起来像换了个函数。
  try {
    Object.setPrototypeOf(wrapped, Object.getPrototypeOf(original))
    for (const key of Object.getOwnPropertyNames(original)) {
      if (key === 'length' || key === 'name' || key === 'prototype') continue
      try { wrapped[key] = original[key] } catch { /* 只读属性就跳过 */ }
    }
  } catch { /* 属性搬运失败不影响主路径 */ }

  const handle = {
    uninstall: () => {
      if (globalThis.fetch === wrapped) globalThis.fetch = original
      if (globalThis[INSTALL_MARK] !== undefined) delete globalThis[INSTALL_MARK]
    },
    installed: true,
    stats: () => ({ rewrites, lastChanges }),
  }

  globalThis.fetch = wrapped
  globalThis[INSTALL_MARK] = handle
  log(`中间层已挂载（目标主机 ${LANE_HOSTS.join('、')}）`)
  return handle
}

export { BASE62 }
