// lane-fix 离线冒烟：纯函数断言 + 挂载/卸载 + 「不碰别人」的边界。
// 从仓库根运行：node scripts/smoke.mjs（不起网络、不碰真实 fetch）
import { readFileSync } from 'node:fs'
import {
  canonicalSessionHex,
  canonicalRequestHex,
  looksTimeEncoded,
  normalizeSessionId,
  normalizeRequestId,
  normalizeUserAgent,
  normalizedHeaders,
  isLaneUrl,
  installLaneFix,
  INSTALL_MARK,
  DERIVED_EPOCH,
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
check('空 UA 不动', normalizeUserAgent('') === null)

// ── 系综：normalizedHeaders 只碰车道、只碰该碰的 ──
const lane = 'https://opencode.ai/zen/v1/chat/completions'
check('车道 URL 识别', isLaneUrl(lane) === true)
check('非车道 URL 不认', isLaneUrl('https://example.com/x') === false)
check('畸形 URL 不炸', isLaneUrl('not a url') === false)

const dirtyInit = {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-opencode-session': dirtySession, 'x-opencode-request': dirtyRequest, 'user-agent': harnessUA },
}
const out = normalizedHeaders(lane, dirtyInit)
check('脏三头 → 产出改写后的头', out !== null && out.changes.length === 3, JSON.stringify(out?.changes))
check('改写只发生在副本上（原对象未被改）',
  dirtyInit.headers['x-opencode-session'] === dirtySession && dirtyInit.headers['user-agent'] === harnessUA)
check('改写后的头里没有带版本的 UA', !/deepseek-harness\//.test(out?.headers.get('user-agent') ?? ''))
check('无关头原样保留', out?.headers.get('content-type') === 'application/json')
check('已合规的请求 → 返回 null（空操作）',
  normalizedHeaders(lane, { headers: { 'x-opencode-session': `ses_${sesHex}qwertyuiopasdfgh`, 'user-agent': 'opencode/1.18.31' } }) === null)
check('非车道主机 → 返回 null（绝不越界）',
  normalizedHeaders('https://example.com/x', dirtyInit) === null)
check('无车道标记头 → 返回 null（不猜）',
  normalizedHeaders(lane, { headers: { 'user-agent': harnessUA } }) === null)

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
check('统计计数涨了', handle.stats().rewrites === 1, JSON.stringify(handle.stats()))

await globalThis.fetch('https://example.com/keep', { headers: { 'x-opencode-session': dirtySession } })
check('非车道请求原样透传（init 未被包装）', calls.length === 2 && calls[1].init.headers['x-opencode-session'] === dirtySession)

handle.uninstall()
check('卸载后恢复原 fetch', globalThis.fetch === fakeOriginal)
check('卸载后标记已清', globalThis[INSTALL_MARK] === undefined)
globalThis.fetch = originalFetch

// ── 清单/契约 ──
const pkg = JSON.parse(readFileSync(root('package.json'), 'utf8'))
check('包名 dsh-maid-lane-fix', pkg.name === 'dsh-maid-lane-fix', pkg.name)
check('version 0.1.1', pkg.version === '0.1.1', pkg.version)
check('files 白名单含 lib 与 patch', Array.isArray(pkg.files) && pkg.files.includes('lib') && pkg.files.includes('cordis.patch.yml'))
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

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
