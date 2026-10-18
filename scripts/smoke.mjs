// lane-fix 离线冒烟：纯函数断言 + 挂载/卸载 + 「不碰别人」的边界。
// 从仓库根运行：node scripts/smoke.mjs（不起网络、不碰真实 fetch）
import { readFileSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  canonicalSessionHex,
  canonicalRequestHex,
  looksTimeEncoded,
  normalizeSessionId,
  normalizeRequestId,
  normalizeUserAgent,
  normalizeLanePath,
  normalizeTools,
  normalizedHeaders,
  normalizedRequest,
  isLaneUrl,
  installLaneFix,
  INSTALL_MARK,
  DERIVED_EPOCH,
  REQUIRED_TOOLS,
  FINGERPRINT_TOOLS,
  LANE_PATH_FROM,
  LANE_PATH_TO,
} from '../lib/lane.js'

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`PASS  ${name}`); pass += 1 } else { console.log(`FAIL  ${name} ${extra}`); fail += 1 }
}
const root = (p) => new URL(`../${p}`, import.meta.url)

// ── 编码形状：会话头取反、请求头不取反，两者都要能被 looksTimeEncoded 认回来 ──
const sesHex = canonicalSessionHex()
const reqHex = canonicalRequestHex()
check('会话头是 12 位 hex', /^[0-9a-f]{12}$/.test(sesHex), sesHex)
check('请求头是 12 位 hex', /^[0-9a-f]{12}$/.test(reqHex), reqHex)
check('规范会话头被认成时间编码（取反形态）', looksTimeEncoded(sesHex, true), sesHex)
check('规范请求头被认成时间编码（不取反形态）', looksTimeEncoded(reqHex, false), reqHex)
check('同一毫秒内序号 1..6 全部被接受（上游实测那一族）',
  [1, 2, 3, 4, 5, 6].every((n) => looksTimeEncoded(canonicalSessionHex(DERIVED_EPOCH, n), true)),
  String([1, 2, 3, 4, 5, 6].map((n) => canonicalSessionHex(DERIVED_EPOCH, n)).join(',')))
check('时间戳 ±30 天仍被接受（上游实测）',
  looksTimeEncoded(canonicalSessionHex(DERIVED_EPOCH + 30 * 86400000), true)
  && looksTimeEncoded(canonicalSessionHex(DERIVED_EPOCH - 30 * 86400000), true))

// ── 摘要形态（插件现状）必须被识别为「不合规」，才会被改写 ──
const digestHex = '9a1b2c3d4e5f'
check('摘要头不被误认成时间编码（取反形态）', !looksTimeEncoded(digestHex, true), digestHex)
check('摘要头不被误认成时间编码（不取反形态）', !looksTimeEncoded(digestHex, false), digestHex)
check('全零头不被误认', !looksTimeEncoded('000000000000', true))
check('非 hex 直接拒绝', !looksTimeEncoded('zzzzzzzzzzzz', true))

// ── 会话/请求规范化：换头、留尾、可重复 ──
// 长度一律用代码补齐，不靠手数（小困已经数错两次）。
const HEAD = '9a1b2c3d4e5f'.padEnd(12, '0').slice(0, 12) // 恰好 12 位 hex
const TAIL = 'qwertyuiopasdf'.padEnd(14, 'z').slice(0, 14) // 恰好 14 字符
const dirtySession = `ses_${HEAD}${TAIL}`
const dirtyRequest = `msg_${HEAD}${TAIL}`
const SESSION_SHAPE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const REQUEST_SHAPE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/
// 自检：用例自己先得合法，否则后面的断言全是假失败（这次就栽在这）。
check('用例自检｜脏会话 id 格式合法', SESSION_SHAPE.test(dirtySession), `${dirtySession} len=${dirtySession.length}`)
check('用例自检｜脏请求 id 格式合法', REQUEST_SHAPE.test(dirtyRequest), `${dirtyRequest} len=${dirtyRequest.length}`)
check('用例自检｜脏会话头确实不合规', !looksTimeEncoded(HEAD, true), HEAD)
check('用例自检｜脏请求头确实不合规', !looksTimeEncoded(HEAD, false), HEAD)
const fixedSession = normalizeSessionId(dirtySession)
const fixedRequest = normalizeRequestId(dirtyRequest)
check('会话 id 被规范化', typeof fixedSession === 'string' && fixedSession !== dirtySession, String(fixedSession))
check('规范化后的会话 id 仍是合法形状', SESSION_SHAPE.test(fixedSession ?? ''), String(fixedSession))
check('会话 id 保留 14 字节尾（同一会话仍稳定）', fixedSession?.slice(16) === dirtySession.slice(16))
check('规范化后的会话头被认成时间编码', fixedSession !== null && looksTimeEncoded(fixedSession.slice(4, 16), true))
check('规范化是幂等的（第二次不再改）', fixedSession !== null && normalizeSessionId(fixedSession) === null)
check('请求 id 被规范化', typeof fixedRequest === 'string' && fixedRequest !== dirtyRequest, String(fixedRequest))
check('规范化后的请求 id 仍是合法形状', REQUEST_SHAPE.test(fixedRequest ?? ''), String(fixedRequest))
check('请求 id 保留 14 字节尾', fixedRequest?.slice(16) === dirtyRequest.slice(16))
check('规范化后的请求头合规（序号落在 SEQ_MAX 内）', fixedRequest !== null && looksTimeEncoded(fixedRequest.slice(4, 16), false), String(fixedRequest))
check('请求 id 规范化幂等', fixedRequest !== null && normalizeRequestId(fixedRequest) === null)
check('同一输入派生同一输出（可重复）', normalizeRequestId(dirtyRequest) === fixedRequest)
check('不合形的 id 一律拒绝', normalizeSessionId('ses_short') === null && normalizeRequestId('msg_short') === null)
check('已合规的会话 id 原样放行（不重复改写）', normalizeSessionId(`ses_${sesHex}${TAIL}`) === null)

// ── UA：两件事同时在（剥版本号 + 令牌在场）；不该动手时一个字都不改 ──
const harnessUA = 'deepseek-harness/0.1.7 (+https://github.com/deepseek-ai/deepseek-harness) opencode/1.18.31'
const fixedUA = normalizeUserAgent(harnessUA)
check('UA 剥掉版本号', typeof fixedUA === 'string' && !/deepseek-harness\//.test(fixedUA), String(fixedUA))
check('UA 保留归属本身（harness 要求在场）', fixedUA?.includes('deepseek-harness') === true, String(fixedUA))
check('UA 保留 opencode 令牌（网关认这个）', fixedUA?.includes('opencode/1.18.31') === true, String(fixedUA))
check('UA 大小写变体也剥', /^deepseek-harness /i.test(normalizeUserAgent('DeepSeek-Harness/1.0 opencode/1.18.31') ?? ''), String(normalizeUserAgent('DeepSeek-Harness/1.0 opencode/1.18.31')))
// 这道门的第二半（实测出来的）：光剥版本号不够，令牌必须在场。
const noToken = 'deepseek-harness/0.1.7 (+https://github.com/deepseek-ai/deepseek-harness)'
const fixedNoToken = normalizeUserAgent(noToken)
check('缺令牌时由本层补上（不能只剥版本号）', fixedNoToken?.includes('opencode/') === true, String(fixedNoToken))
check('补令牌后仍不含带版本的归属', !/deepseek-harness\//.test(fixedNoToken ?? ''), String(fixedNoToken))
check('归属本身仍在（补令牌不等于删归属）', fixedNoToken?.includes('deepseek-harness') === true, String(fixedNoToken))
check('已合规且带令牌的归属 UA 不动', normalizeUserAgent('deepseek-harness (+https://x) opencode/1.18.31') === null)
check('干净 UA 不动', normalizeUserAgent('opencode/1.18.31') === null)
check('dsh 前缀不动（上游放行这一族）', normalizeUserAgent('dsh/0.1.7 opencode/1.18.31') === null)
// 2026-10-15 逐格复测钉死的门边界：只认「连字符 + 斜杠 + 版本号」这一个形态。
check('下划线变体带版本 → 不动（实测上游放行）', normalizeUserAgent('deepseek_harness/2.2.0 opencode/1.19.0') === null)
check('无版本号的归属 → 不动（实测上游放行）', normalizeUserAgent('deepseek-harness opencode/1.19.0') === null)
check('v 前缀版本也算带版本 → 剥', !/deepseek-harness\//.test(normalizeUserAgent('deepseek-harness/v2.2.0 opencode/1.19.0') ?? ''))
check('空 UA 不动', normalizeUserAgent('') === null)

// ── 端点地址：老 /zen/v1 改写成新 /inference/v1（PR #330 逐格实测的那道门）──
check('老端点被改写', normalizeLanePath('/zen/v1/chat/completions') === '/inference/v1/chat/completions', String(normalizeLanePath('/zen/v1/chat/completions')))
check('新端点不动（幂等）', normalizeLanePath('/inference/v1/chat/completions') === null)
check('别的路径不碰', normalizeLanePath('/v1/models') === null)
check('空值不炸', normalizeLanePath(undefined) === null)
check('改写常量成对', LANE_PATH_FROM === '/zen/v1/' && LANE_PATH_TO === '/inference/v1/')

// ── 工具指纹：bash 与 read 必须同时在、且各带至少一个 property（PR #330）──
const nested = (name, props) => ({ type: 'function', function: { name, description: 'x', parameters: { type: 'object', properties: props } } })
{
  const onlyBash = { model: 'cat-jam-free', tools: [nested('bash', { command: { type: 'string' } })] }
  const c1 = normalizeTools(onlyBash)
  check('只有 bash → 补 read', onlyBash.tools.some(t => t.function.name === 'read'), JSON.stringify(c1))
  check('补进来的 read 带 property', Object.keys(onlyBash.tools.find(t => t.function.name === 'read').function.parameters.properties).length > 0)

  const emptyProps = { model: 'cat-jam-free', tools: [nested('bash', {}), nested('read', {})] }
  const c2 = normalizeTools(emptyProps)
  check('properties 为空 → 各补一个 property',
    Object.keys(emptyProps.tools[0].function.parameters.properties).length > 0
    && Object.keys(emptyProps.tools[1].function.parameters.properties).length > 0, JSON.stringify(c2))

  const good = { model: 'cat-jam-free', tools: FINGERPRINT_TOOLS.map(n => nested(n, { input: { type: 'string' } })) }
  check('已合规的工具集 → 不动（空操作）', normalizeTools(good).length === 0, JSON.stringify(normalizeTools(good)))
  check('四个工具都在 → 也不补 tool_choice（有客户端工具）', good.tool_choice === undefined)

  const none = { messages: [] }
  check('没有 model（不是聊天请求）→ 不动', normalizeTools(none).length === 0)

  // 车道只看「声明的名字」：tools 字段整个缺席也照样 403（2026-10-15 实测）。
  const plain = { model: 'space-bunny-free', messages: [{ role: 'user', content: 'hi' }] }
  const c3 = normalizeTools(plain)
  check('没有 tools 字段 → 照样补指纹', FINGERPRINT_TOOLS.every(n => plain.tools.some(t => t.function.name === n)), JSON.stringify(c3))
  check('没有 tools 字段 → tool_choice 锁成 none', plain.tool_choice === 'none', JSON.stringify(plain.tool_choice))
  check('没有 tools 字段 → 补完幂等', normalizeTools(plain).length === 0)

  const noClientTools = { model: 'cat-jam-free', tools: [] }
  normalizeTools(noClientTools)
  check('无客户端工具时 tool_choice 锁成 none', noClientTools.tool_choice === 'none', JSON.stringify(noClientTools.tool_choice))
  check('无客户端工具时四个指纹工具全补上',
    FINGERPRINT_TOOLS.every(n => noClientTools.tools.some(t => t.function.name === n)),
    noClientTools.tools.map(t => t.function.name).join())

  const claudeShape = { model: 'cat-jam-free', tools: [{ name: 'bash', description: 'x', input_schema: { type: 'object', properties: {} } }] }
  normalizeTools(claudeShape)
  check('Anthropic 形态：补 input_schema property',
    Object.keys(claudeShape.tools[0].input_schema.properties).length > 0)
  check('Anthropic 形态：诱饵也用 input_schema', claudeShape.tools.every(t => t.input_schema !== undefined))
  check('必查工具表就是 bash 与 read', REQUIRED_TOOLS.join() === 'bash,read')

  const flatShape = { model: 'cat-jam-free', tools: [{ type: 'function', name: 'bash', description: 'x', parameters: { type: 'object', properties: {} } }] }
  normalizeTools(flatShape)
  check('拍平形态：补 parameters property', Object.keys(flatShape.tools[0].parameters.properties).length > 0)

  const idempotent = { model: 'cat-jam-free', tools: [nested('bash', {}), nested('read', {})] }
  normalizeTools(idempotent)
  check('工具指纹幂等（第二次零改动）', normalizeTools(idempotent).length === 0)
}

// ── 系综：normalizedRequest 只碰车道、只碰该碰的 ──
const lane = 'https://opencode.ai/zen/v1/chat/completions'
check('车道 URL 识别', isLaneUrl(lane) === true)
check('非车道 URL 不认', isLaneUrl('https://example.com/x') === false)
check('畸形 URL 不炸', isLaneUrl('not a url') === false)

const dirtyInit = {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-opencode-session': dirtySession, 'x-opencode-request': dirtyRequest, 'user-agent': harnessUA },
}
const out = normalizedHeaders(lane, dirtyInit)
check('脏头 + 老端点 → 产出五项改写（地址/会话/session-id/请求/UA）', out !== null && out.changes.length === 5, JSON.stringify(out?.changes))
check('改写只发生在副本上（原对象未被改）',
  dirtyInit.headers['x-opencode-session'] === dirtySession && dirtyInit.headers['user-agent'] === harnessUA)
check('改写后的头里没有带版本的 UA', !/deepseek-harness\//.test(out?.headers.get('user-agent') ?? ''))
check('无关头原样保留', out?.headers.get('content-type') === 'application/json')
check('非车道主机 → 返回 null（绝不越界）',
  normalizedHeaders('https://example.com/x', dirtyInit) === null)
check('无车道标记头 → 返回 null（不猜）',
  normalizedHeaders(lane, { headers: { 'user-agent': harnessUA } }) === null)

// 全合规的请求必须原样放行：五道门全过才叫"空操作"。
const cleanInit = {
  headers: {
    'x-opencode-session': `ses_${sesHex}qwertyuiopasdfgh`,
    'x-opencode-session-id': `ses_${sesHex}qwertyuiopasdfgh`,
    'x-opencode-request': `msg_${reqHex}qwertyuiopasdfgh`,
    'user-agent': 'opencode/1.18.31',
  },
}
check('已合规且地址已在新端点 → 返回 null（空操作）',
  normalizedRequest(`${lane.replace('/zen/v1/', '/inference/v1/')}`, cleanInit) === null)
check('已合规但地址还在老端点 → 只改地址（那道门单独存在）',
  JSON.stringify(normalizedRequest(lane, cleanInit)?.changes) === JSON.stringify(['/zen/v1/→/inference/v1/']),
  JSON.stringify(normalizedRequest(lane, cleanInit)?.changes))
check('缺 x-opencode-session-id → 补上（PR #330 那道门）',
  normalizedHeaders(lane, { headers: { 'x-opencode-session': `ses_${sesHex}qwertyuiopasdfgh`, 'user-agent': 'opencode/1.18.31' } })
    ?.headers.get('x-opencode-session-id') === `ses_${sesHex}qwertyuiopasdfgh`)
check('session-id 补的是规范化**之后**的会话值（不能补旧值）',
  (() => {
    const r = normalizedRequest(lane, { headers: { 'x-opencode-session': dirtySession, 'user-agent': 'opencode/1.18.31' } })
    return r !== null && r.headers.get('x-opencode-session-id') === r.headers.get('x-opencode-session')
  })())
check('端点改写走 normalizedRequest（头没毛病时也照改）',
  normalizedRequest(lane, { headers: { 'x-opencode-session': dirtySession } })?.url.includes('/inference/v1/chat/completions') === true)

// ── 挂载：装得上、拦得住、卸得干净、重复装不叠层 ──
const calls = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, status: 200, text: async () => 'ok' } }
const fakeOriginal = globalThis.fetch

const handle = installLaneFix({ log: () => {} })
check('挂载成功', handle.installed === true && globalThis.fetch !== fakeOriginal)
check('全局标记已写入', globalThis[INSTALL_MARK] !== undefined)
const again = installLaneFix({ log: () => {} })
check('重复挂载复用已有层（不叠 wrapper）', again.installed === false && globalThis.fetch === globalThis.fetch)

await globalThis.fetch(lane, { method: 'POST', headers: { ...dirtyInit.headers } })
check('车道请求被拦下并改写', calls.length === 1 && calls[0].init.headers instanceof Headers, JSON.stringify(calls.length))
check('拦下的请求头已合规', looksTimeEncoded(calls[0].init.headers.get('x-opencode-session').slice(4, 16), true))
check('拦下的请求 URL 已换到新端点', calls[0].url.includes('/inference/v1/chat/completions'), calls[0].url)
check('拦下的请求补了 session-id 且与会话头同值',
  calls[0].init.headers.get('x-opencode-session-id') === calls[0].init.headers.get('x-opencode-session'))
check('统计计数涨了', handle.stats().rewrites === 1, JSON.stringify(handle.stats()))

await globalThis.fetch('https://example.com/keep', { headers: { 'x-opencode-session': dirtySession } })
check('非车道请求原样透传（init 未被包装）', calls.length === 2 && calls[1].init.headers['x-opencode-session'] === dirtySession)

// 带 body 的整链：工具指纹也在 wrapper 里生效。
await globalThis.fetch(lane, {
  method: 'POST',
  headers: { ...dirtyInit.headers },
  body: JSON.stringify({ model: 'cat-jam-free', tools: [{ type: 'function', function: { name: 'bash', description: 'x', parameters: { type: 'object', properties: {} } } }] }),
})
const sentBody = JSON.parse(calls[2].init.body)
check('wrapper 里工具指纹也生效（read 补进来了）', sentBody.tools.some(t => t.function.name === 'read'), calls[2].init.body.slice(0, 120))
check('wrapper 里 bash 的 schema 被补上 property', Object.keys(sentBody.tools.find(t => t.function.name === 'bash').function.parameters.properties).length > 0)

handle.uninstall()
check('卸载后恢复原 fetch', globalThis.fetch === fakeOriginal)
check('卸载后标记已清', globalThis[INSTALL_MARK] === undefined)
globalThis.fetch = originalFetch

// ── 上游补丁集：锚点唯一、幂等、失配即中止 ──
// 重点在"补丁器不会改错地方"。合成用例随包跑；真实上游原文用 OFM_DIR 指过去，
// 没指就跳过（本仓库不存上游副本）。
{
  const { PATCHES, applyPatchSet, inspectPatchSet, patchStatus, PATCHED_FILES } = await import('../lib/ofm-patch.js')

  check('补丁集非空且每处都有 why', PATCHES.length > 0 && PATCHES.every(p => Array.isArray(p.why) && p.why.length > 0))
  check('每处补丁 id 唯一', new Set(PATCHES.map(p => p.id)).size === PATCHES.length)
  check('每处补丁都声明 file 与 marker', PATCHES.every(p => typeof p.file === 'string' && typeof p.marker === 'string' && p.marker.length > 0))
  check('marker 不在 from 里（否则"已应用"会立刻误判）', PATCHES.every(p => !p.from.includes(p.marker)), PATCHES.filter(p => p.from.includes(p.marker)).map(p => p.id).join())

  const synth = {}
  for (const p of PATCHES) synth[p.file] = `${synth[p.file] ?? ''}${p.from}\n`
  const once = applyPatchSet(synth)
  check('合成输入：全部 ready', once.report.every(r => r.status === 'ready'), JSON.stringify(once.report.map(r => r.status)))
  check('合成输入：替换后 marker 全部命中', PATCHES.every(p => once.files[p.file].includes(p.marker)))
  const twice = applyPatchSet(once.files)
  check('幂等：第二次全部 applied、零改动', twice.report.every(r => r.status === 'applied') && PATCHED_FILES.every(f => twice.files[f] === once.files[f]))

  // 破坏必须落在"还没打过补丁"的原文上：对着已应用的文本做替换会空转，
  // 锚点其实还在原地，这种用例会假绿（第一次就栽在这）。
  const first = PATCHES[0]
  const broken = { ...synth, [first.file]: synth[first.file].replace(first.from, 'something else entirely') }
  check('用例自检｜破坏后锚点确实不在了', !broken[first.file].includes(first.from))
  let threw = false
  try { applyPatchSet(broken) } catch { threw = true }
  check('锚点失配时整批中止（不写一半）', threw)
  check('inspectPatchSet 对缺文件报 missing-file', inspectPatchSet({})[0].status === 'missing-file')
  check('patchStatus 对无关文本报 anchor-lost', patchStatus(first, 'nothing relevant here') === 'anchor-lost')

  const upstream = process.env.OFM_DIR ?? null
  if (upstream !== null) {
    const real = {}
    for (const name of PATCHED_FILES) real[name] = readFileSync(`${upstream}/${name}`, 'utf8')
    const rows = inspectPatchSet(real)
    check('真实上游：全部已应用', rows.every(r => r.status === 'applied'), JSON.stringify(rows.map(r => `${r.id}=${r.status}`)))
  }
}

// ── 清单/契约 ──
const pkg = JSON.parse(readFileSync(root('package.json'), 'utf8'))
check('包名 dsh-maid-lane-fix', pkg.name === 'dsh-maid-lane-fix', pkg.name)
// 版本号别写死：bump 一次就要改断言，属于假红。只校验形态与「不低于已知基线」。
const VERSION_FLOOR = [0, 3, 2]
const versionParts = String(pkg.version ?? '').split('.').map(Number)
const cmpVersion = (a, b) => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}
const versionOk = versionParts.length === 3 && versionParts.every(Number.isInteger)
  && cmpVersion(versionParts, VERSION_FLOOR) >= 0
check(`version 形态合法且不低于 ${VERSION_FLOOR.join('.')}`, versionOk, pkg.version)
check('files 白名单含 lib、scripts 与 patch', Array.isArray(pkg.files) && pkg.files.includes('lib') && pkg.files.includes('scripts') && pkg.files.includes('cordis.patch.yml'))
check('dsh.bundle.patch 指向本包 patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('peer 只有 cordis（零运行时依赖）', Object.keys(pkg.peerDependencies ?? {}).join() === '@deepseek-ai/cordis')
check('无运行时 dependencies（宿主侧纯修补）', pkg.dependencies === undefined)
const patch = readFileSync(root('cordis.patch.yml'), 'utf8')
check('patch 插入自身行（id: lane-fix）', /- id: lane-fix\s*\n\s*name: 'dsh-maid-lane-fix'/.test(patch))
const index = readFileSync(root('index.js'), 'utf8')
check('index 导出 name（=patch id）', /export const name = 'lane-fix'/.test(index))
check('index inject 为空数组（无必需服务）', /export const inject = \[\]/.test(index))
check('index 用 ctx.effect 登记卸载', /ctx\.effect\?\.\(/.test(index))
const laneSrc = readFileSync(root('lib/lane.js'), 'utf8')
check('源文件通篇无 @deepseek-ai import（零内核依赖）', !/@deepseek-ai\//.test(laneSrc))
check('车道主机白名单只列 opencode.ai', /LANE_HOSTS = Object\.freeze\(\['opencode\.ai'\]\)/.test(laneSrc))

// ── 还原基线：仓库里每一份上游原文都必须真的等于上游原文 ──
// 校验靠清单而不是硬编码：改了基线就得连清单一起改，两边对不上立刻红。
// 目录按版本号扫，新增基线不用改这里；但每份都得有 SHA256SUMS 且三行对齐 PATCHED_FILES。
{
  const { PATCHED_FILES } = await import('../lib/ofm-patch.js')
  const baseRoot = root('baseline')
  const dirs = readdirSync(baseRoot).filter(d => /^ofm-\d/.test(d)).sort()
  check('基线目录至少一份', dirs.length > 0, dirs.join(' '))
  for (const d of dirs) {
    const sums = readFileSync(root(`baseline/${d}/SHA256SUMS`), 'utf8')
      .trim().split('\n')
      .map(line => { const [hash, name] = line.trim().split(/\s+/); return { hash, name } })
    // 历史基线保留当时的三文件契约；2.5.3 起才新增 EAC 请求边界补丁。
    const expectedFiles = d === 'ofm-2.5.3' ? PATCHED_FILES : ['client.js', 'index.js', 'src/http.js']
    check(`${d} 清单列了 ${expectedFiles.length} 个文件`, sums.length === expectedFiles.length, String(sums.length))
    check(`${d} 清单覆盖对应版本的补丁目标文件`,
      sums.map(s => s.name).sort().join() === [...expectedFiles].sort().join(),
      sums.map(s => s.name).join(' '))
    for (const { hash, name } of sums) {
      const gz = root(`baseline/${d}/${name.replace(/\//g, '__')}.gz`)
      const raw = gunzipSync(readFileSync(gz))
      check(`${d} 基线 ${name} 解压后 sha256 与清单一致`, createHash('sha256').update(raw).digest('hex') === hash, name)
    }
  }
  check('基线不进 files 白名单（档案，不是运行时资产）', !pkg.files.includes('baseline'))
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
