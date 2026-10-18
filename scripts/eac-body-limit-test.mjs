// 离线集成：真实 EAC poster + 测试 transport seam；绝不读取/输出凭据。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyPatchSet, PATCHED_FILES } from '../lib/ofm-patch.js'
const repo = fileURLToPath(new URL('../', import.meta.url))
const upstream = process.env.OFM_DIR ?? path.join(os.homedir(), '.dsh/profiles/desktop/node_modules/dsh-our-free-model')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-fix-eac-test-'))
const LIMIT = 8388608
let count = 0
function check(name, condition) { assert.ok(condition, name); count++; console.log('PASS ' + name) }
function cli(...args) {
  return spawnSync(process.execPath, [path.join(repo, 'scripts/patch-ofm.mjs'), '--dir', tmp, ...args], { encoding: 'utf8' })
}
const original = {}
for (const name of PATCHED_FILES) {
  original[name] = gunzipSync(fs.readFileSync(path.join(repo, 'baseline/ofm-2.5.3', name.replaceAll('/', '__') + '.gz'))).toString('utf8')
  fs.mkdirSync(path.dirname(path.join(tmp, name)), { recursive: true })
  fs.writeFileSync(path.join(tmp, name), original[name])
}
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module', version: '2.5.3' }))
const applied = applyPatchSet(original).files
const oldHttp = http.request, oldHttps = https.request, oldFetch = globalThis.fetch
let networkAttempts = 0
const forbidden = () => { networkAttempts++; throw Error('测试禁止真实出网') }
http.request = https.request = globalThis.fetch = forbidden
try {
  check('CLI dry-run 不写盘', cli('--dry-run').status === 0 && PATCHED_FILES.every(n => fs.readFileSync(path.join(tmp, n), 'utf8') === original[n]))
  check('CLI 应用成功', cli().status === 0)
  check('CLI verify 按干净基线逐字节重放', cli('--verify').status === 0)
  check('CLI 第二次应用幂等', cli().status === 0 && PATCHED_FILES.every(n => fs.readFileSync(path.join(tmp, n), 'utf8') === applied[n]))
  const backup = path.join(tmp, '.lane-fix-orig', 'src__eac.js')
  check('EAC 备份逐字节等于干净基线', fs.readFileSync(backup, 'utf8') === original['src/eac.js'])
  fs.appendFileSync(path.join(tmp, 'src/eac.js'), '\n// tampered\n')
  check('verify 不再仅凭 marker 放行', cli('--verify').status !== 0)
  check('restore 恢复全部干净原文', cli('--restore').status === 0 && PATCHED_FILES.every(n => fs.readFileSync(path.join(tmp, n), 'utf8') === original[n]))
  fs.writeFileSync(backup, 'wrong-version')
  const before = PATCHED_FILES.map(n => fs.readFileSync(path.join(tmp, n), 'utf8'))
  check('错误/旧版备份让 restore 整批拒绝且零写入', cli('--restore').status !== 0 && PATCHED_FILES.every((n, i) => fs.readFileSync(path.join(tmp, n), 'utf8') === before[i]))
  let source = process.env.EAC_USE_INSTALLED === '1'
    ? fs.readFileSync(path.join(upstream, 'src/eac.js'), 'utf8')
    : applied['src/eac.js']
  for (const name of ['http.js', 'eac-user.js']) source = source.replace(`'./${name}'`, JSON.stringify(pathToFileURL(path.join(upstream, 'src', name)).href))
  const { postSealedStreamed, lane, laneUser, signSealedRequest } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  const { CODE, UpstreamError } = await import(pathToFileURL(path.join(upstream, 'src/http.js')).href)
  laneUser.token = null
  const adapter = fs.readFileSync(path.join(upstream, 'src/adapter.js'), 'utf8')
  const retryMatch = adapter.match(/retryableCodes: Object\.freeze\((\[[^\]]*\])/)
  assert.ok(retryMatch, '真实 adapter retry policy 存在')
  const retryable = [...retryMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  const credential = { mode: 'worker', base: 'https://offline.invalid/eac/v1', signingSecret: 'offline-test-not-a-credential', userToken: null }
  let sends = 0, wire
  lane.fetch = async (url, request) => { sends++; wire = request; return new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', { status: 200 }) }
  const makeBody = (size, chinese) => {
    const budget = size - Buffer.byteLength(JSON.stringify({ content: '' }), 'utf8')
    return { content: chinese ? '中'.repeat(Math.floor(budget / 3)) + 'x'.repeat(budget % 3) : 'a'.repeat(budget) }
  }
  for (const chinese of [false, true]) for (const size of [LIMIT - 1, LIMIT, LIMIT + 1]) {
    const body = makeBody(size, chinese), frames = [], previous = sends
    check(`${chinese ? '中文' : 'ASCII'} 用例精确 ${size} 字节`, Buffer.byteLength(JSON.stringify(body), 'utf8') === size)
    if (size > LIMIT) {
      let error
      try { await postSealedStreamed({ credential, body, onData: x => frames.push(x) }) } catch (e) { error = e }
      check('超限本地 CLIENT_ERROR，不调用 transport、不出帧', error instanceof UpstreamError && error.code === CODE.client && sends === previous && frames.length === 0)
      check('本地报错包含实际大小、上限及处理建议，不可重试', error.message.includes(String(size)) && error.message.includes(String(LIMIT)) && /未发送.*缩短会话.*附件.*新会话/.test(error.message) && !retryable.includes(error.code))
    } else {
      const result = await postSealedStreamed({ credential, body, onData: x => frames.push(x) })
      check('不超限仅发送一次且保留 SSE 行为', sends === previous + 1 && result.status === 200 && frames.join() === '{"ok":true}')
      check('线上字节与签名字节完全一致', wire.body === JSON.stringify(body) && wire.headers['x-ofm-signature'] === signSealedRequest(credential.signingSecret, { method: 'POST', path: '/eac/v1/chat/completions', body: wire.body }, Number(wire.headers['x-ofm-timestamp']))['x-ofm-signature'])
    }
  }
  lane.fetch = async () => { sends++; return new Response('{"choices":[]}', { status: 200 }) }
  const frames = []
  await postSealedStreamed({ credential, body: { content: '正常中文' }, onData: x => frames.push(x) })
  check('正常 JSON 非 SSE 返回行为无回归', frames.join() === '{"choices":[]}')
  for (const responseBody of ['request body too large', '{"error":{"message":"private upstream detail"}}', '<html>413</html>']) {
    lane.fetch = async () => { sends++; return new Response(responseBody, { status: 413, headers: { 'retry-after': '60' } }) }
    const previous = sends
    let error
    try { await postSealedStreamed({ credential, body: {}, onData() {} }) } catch (e) { error = e }
    check('上游 413 中文友好说明，CLIENT_ERROR，不采纳 Retry-After、不泄露原文', error instanceof UpstreamError && error.code === CODE.client && error.status === 413 && sends === previous + 1 && /HTTP 413.*8388608.*8 MiB.*缩短会话/.test(error.message) && !error.message.includes('private upstream detail') && error.providerRetryAfterMs === undefined && !retryable.includes(error.code))
  }
  lane.fetch = async () => new Response('{"error":{"message":"temporary"}}', { status: 500 })
  await assert.rejects(postSealedStreamed({ credential, body: {}, onData() {} }), e => e.code === CODE.server)
  check('非 413 上游错误分类不回归', true)
  check('全套测试真实出网次数为零', networkAttempts === 0)
  console.log(`\n${count} PASS / 0 FAIL`)
} finally {
  http.request = oldHttp; https.request = oldHttps; globalThis.fetch = oldFetch
  // tmp 是本次 mkdtemp 返回的绝对目录；校验后才清理，绝不碰现役安装。
  assert.equal(path.dirname(tmp), os.tmpdir())
  assert.ok(path.basename(tmp).startsWith('lane-fix-eac-test-'))
  fs.rmSync(tmp, { recursive: true, force: true })
}
