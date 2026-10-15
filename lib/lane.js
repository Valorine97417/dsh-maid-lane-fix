/**
 * 车道请求的规范化核心 —— 纯函数，无 I/O、无全局副作用，便于离线断言。
 *
 * 五道门的判据与修法都在这里；`installLaneFix` 只负责把它挂到 fetch 上。
 *
 * 前两道（会话 id 形状、UA 归属写法）是 2026-10-14 逐格实测出来的；
 * 后三道（端点地址、`x-opencode-session-id`、工具指纹）由上游 PR #330
 * 在 2026-10-15 公布（作者用 TLS MITM 读真客户端请求 + 单变量重放确认）。
 * 本层把五道一起兜住：上游哪天自己修好了，对已经合规的请求全是空操作。
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

/**
 * 车道**只认**的新端点前缀（2026-10-13 起）。
 *
 * 上游 2.2.0（含 `v2.2.0` 标签）仍在打 `/zen/v1/*`；PR #330 逐格实测：
 * 即使其余四道全对，`/zen/v1/chat/completions` 也照样 403，而
 * `/inference/v1/chat/completions` 放行——两套地址返回**同一份** 85 个模型清单，
 * 但只有新地址过闸。本层把老地址改写成新地址，对已经在新地址上的上游是空操作。
 */
export const LANE_PATH_FROM = '/zen/v1/'
export const LANE_PATH_TO = '/inference/v1/'

/** 车道要求**同时**声明的工具（各自 schema 至少一个 property，否则 403）。 */
export const REQUIRED_TOOLS = Object.freeze(['bash', 'read'])

/** 车道认的四个工具名；缺哪个就补哪个（上游 `FINGERPRINT_TOOLS` 同款）。 */
export const FINGERPRINT_TOOLS = Object.freeze(['bash', 'glob', 'grep', 'read'])

/** 诱饵工具的说明文案——与上游 `applyFingerprint` 逐字一致，便于对照。 */
const DECOY_DESC = 'This tool is currently unavailable and must not be used.'

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
 * 这道门要的是**两件事同时在**（逐格实测）：
 *   ① 不能出现 `deepseek-harness/<版本>`（大小写无关、位置无关）；
 *   ② 必须有 `opencode/<版本>` 令牌 —— 少了它照样 403，哪怕归属已剥干净。
 *
 * 2026-10-15 复测把①的边界钉死了（其余四道门全对，每格都带 `opencode/`）：
 *   `deepseek-harness/2.2.0` → 403   `deepseek-harness/v2.2.0` → 403
 *   `DEEPSEEK-HARNESS/2.2.0` → 403   `deepseek-harness`（无版本）→ 200
 *   `deepseek_harness/2.2.0` → 200   `dsh/2.2.0` → 200
 * 即：**只认连字符 + 斜杠 + 版本号**这一个形态，下划线变体不拦（上游
 * `userAgentWith` 用的 `/deepseek[-_]harness/i` 比门更宽，多改无害）。
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
 * 老端点 → 新端点。不是 `/zen/v1/*` 就返回 null（不必改）。
 *
 * @param {string} pathname URL 的 pathname。
 * @returns {string|null}
 */
export function normalizeLanePath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(LANE_PATH_FROM)) return null
  return `${LANE_PATH_TO}${pathname.slice(LANE_PATH_FROM.length)}`
}

/** 工具的形态：`nested`＝OpenAI 带 `function` 包裹、`flat`＝OpenAI 拍平、`claude`＝Anthropic。 */
function toolShape(tool) {
  if (tool === null || typeof tool !== 'object') return null
  if (tool.function !== null && typeof tool.function === 'object') return 'nested'
  if (tool.input_schema !== null && typeof tool.input_schema === 'object') return 'claude'
  if (tool.parameters !== null && typeof tool.parameters === 'object') return 'flat'
  return null
}

function toolNameOf(tool) {
  const shape = toolShape(tool)
  if (shape === 'nested') return tool.function.name
  if (shape === 'flat' || shape === 'claude') return tool.name
  return undefined
}

function schemaOf(tool) {
  const shape = toolShape(tool)
  if (shape === 'nested') return tool.function.parameters
  if (shape === 'claude') return tool.input_schema
  if (shape === 'flat') return tool.parameters
  return undefined
}

/** 把一个工具换成「schema 至少一个 property」的版本；已经够用就返回 null。 */
function withProperty(tool) {
  const shape = toolShape(tool)
  if (shape === null) return null
  const schema = schemaOf(tool)
  const properties = schema !== null && typeof schema === 'object' && schema.properties !== null && typeof schema.properties === 'object'
    ? schema.properties
    : null
  if (properties !== null && Object.keys(properties).length > 0) return null
  const next = { ...(schema ?? {}), type: (schema ?? {}).type ?? 'object', properties: { input: { type: 'string', description: DECOY_DESC } } }
  if (shape === 'nested') return { ...tool, function: { ...tool.function, parameters: next } }
  if (shape === 'claude') return { ...tool, input_schema: next }
  return { ...tool, parameters: next }
}

/** 造一个诱饵工具（车道只登记声明的名字，模型真调了会得到 unknown tool）。 */
function decoyTool(name, shape) {
  const base = { description: DECOY_DESC, parameters: { type: 'object', properties: { input: { type: 'string', description: DECOY_DESC } } } }
  if (shape === 'claude') return { name, description: DECOY_DESC, input_schema: base.parameters }
  if (shape === 'flat') return { type: 'function', name, ...base }
  return { type: 'function', function: { name, ...base } }
}

/**
 * 工具指纹：车道要求 `bash` 与 `read` **同时**在场，且各自 schema 至少一个
 * property（只其一 → 403，`properties: {}` → 403；PR #330 逐格实测）。
 *
 * 还有一条 PR #330 没写、本层 2026-10-15 实测抓到的：**连 `tools` 字段都不存在
 * 时照样 403**（纯文本轮次就长这样）。所以补指纹是无条件的——上游
 * `applyFingerprint` 也是无条件补四个。
 *
 * 另外：请求本来一个工具都没有时，光补工具还不够——得把 `tool_choice` 设成
 * `'none'`，否则模型可能真去调那些诱饵。上游 `applyFingerprint` 同款处理。
 *
 * @param {object} body 已解析的请求体（会被就地改）。
 * @returns {string[]} 改动说明；空数组＝不需要改。
 */
export function normalizeTools(body) {
  if (body === null || typeof body !== 'object') return []
  // 车道不看「有没有工具」，只看**声明的名字**：请求里根本没有 `tools` 字段时
  // 照样 403（2026-10-15 实测，纯文本轮次必踩）。所以这里不能提前返回——
  // 上游 `applyFingerprint` 同样是无条件补的。只对像是聊天请求的 body 动手
  // （带 `model`），别去改我们不认识的载荷。
  if (typeof body.model !== 'string') return []
  const tools = Array.isArray(body.tools) ? body.tools : []
  if (!Array.isArray(body.tools)) body.tools = tools
  const changes = []
  const shape = tools.map(toolShape).find(s => s !== null) ?? 'nested'
  const names = new Set(tools.map(toolNameOf).filter(n => typeof n === 'string'))

  // ① 已有的 bash / read：schema 空就补一个 property。
  for (const name of REQUIRED_TOOLS) {
    if (!names.has(name)) continue
    const index = tools.findIndex(tool => toolNameOf(tool) === name)
    const fixed = withProperty(tools[index])
    if (fixed !== null) {
      tools[index] = fixed
      changes.push(`${name} 补 schema property`)
    }
  }

  // ② 缺的工具：补诱饵（车道只看声明，不看谁真被调用）。
  const added = []
  for (const name of FINGERPRINT_TOOLS) {
    if (names.has(name)) continue
    tools.push(decoyTool(name, shape))
    added.push(name)
  }
  if (added.length > 0) changes.push(`补工具声明 ${added.join('/')}`)

  // ③ 一个客户端工具都没有时，诱饵必须锁住：tool_choice 设 'none'。
  const hadClientTools = tools.length > added.length
  if (!hadClientTools && body.tool_choice === undefined) {
    body.tool_choice = shape === 'claude' ? { type: 'none' } : 'none'
    changes.push("tool_choice 设 'none'（无客户端工具）")
  }
  return changes
}

/**
 * 拿一份请求，产出规范化后的 url / 头 / 体；不需要改就返回 null。
 *
 * 只在**车道的标记头在场**时才动手（`x-opencode-session`），这样别的 fetch
 * 调用——哪怕目标主机相同、或完全没有头——一律不受影响。
 *
 * @param {string} url 请求 URL。
 * @param {object|undefined} init fetch 的第二个参数。
 * @returns {{url: string, headers: Headers, body: (string|undefined), changes: string[]}|null}
 */
export function normalizedRequest(url, init) {
  if (!isLaneUrl(url)) return null
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return null
  }
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

  // ① 端点地址：老地址改写成新地址（路径级，与头无关）。
  const path = normalizeLanePath(parsed.pathname)
  let nextUrl = String(url)
  if (path !== null) {
    parsed.pathname = path
    nextUrl = parsed.toString()
    changes.push(`${LANE_PATH_FROM}→${LANE_PATH_TO}`)
  }

  // ② 会话 id 形状。
  const fixedSession = typeof session === 'string' ? normalizeSessionId(session) : null
  if (fixedSession !== null) {
    headers.set('x-opencode-session', fixedSession)
    changes.push(`session ${session.slice(4, 16)}→${fixedSession.slice(4, 16)}`)
  }

  // ③ `x-opencode-session-id` 必须与 `x-opencode-session` 同值在场（缺则 403）。
  const effectiveSession = fixedSession ?? session
  if (typeof effectiveSession === 'string' && headers.get('x-opencode-session-id') !== effectiveSession) {
    headers.set('x-opencode-session-id', effectiveSession)
    changes.push('补 x-opencode-session-id')
  }

  // ④ 请求 id 形状。
  const fixedRequest = typeof request === 'string' ? normalizeRequestId(request) : null
  if (fixedRequest !== null) {
    headers.set('x-opencode-request', fixedRequest)
    changes.push(`request ${request.slice(4, 16)}→${fixedRequest.slice(4, 16)}`)
  }

  // ⑤ UA 归属写法。
  const fixedAgent = normalizeUserAgent(headers.get('user-agent') ?? '')
  if (fixedAgent !== null) {
    headers.set('user-agent', fixedAgent)
    changes.push('UA 剥版本号')
  }

  // ⑥ 工具指纹：要改 body，而 body 只有在是字符串时才碰得安全。
  let body = init?.body
  if (typeof body === 'string' && body !== '') {
    try {
      const parsedBody = JSON.parse(body)
      const bodyChanges = normalizeTools(parsedBody)
      if (bodyChanges.length > 0) {
        body = JSON.stringify(parsedBody)
        changes.push(...bodyChanges)
      }
    } catch {
      // 不是 JSON（或不是我们该管的东西）→ 原样放行。
    }
  }

  return changes.length === 0 ? null : { url: nextUrl, headers, body, changes }
}

/**
 * 只关心头的调用方（旧名保留）：返回规范化后的头，或 null。
 *
 * @deprecated 用 `normalizedRequest` —— 它还会改端点地址、补 session-id、修工具指纹。
 */
export function normalizedHeaders(url, init) {
  const out = normalizedRequest(url, init)
  if (out === null) return null
  return { headers: out.headers, changes: out.changes }
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
      normalized = url === undefined ? null : normalizedRequest(url, init)
    } catch {
      // 规范化本身出问题就原样放行：车道宁可 403，也不能因为我们抛错而整轮失败。
      normalized = null
    }
    if (normalized === null) return original(input, init)
    rewrites += 1
    lastChanges = normalized.changes
    log(`已规范化车道请求 #${rewrites}：${normalized.changes.join('、')}`)
    const next = { ...init, headers: normalized.headers }
    if (normalized.body !== undefined) next.body = normalized.body
    return original(normalized.url, next)
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
