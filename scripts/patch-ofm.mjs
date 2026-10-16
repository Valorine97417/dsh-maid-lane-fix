#!/usr/bin/env node
/**
 * 把 `lib/ofm-patch.js` 的四处补丁落到上游 `dsh-our-free-model` 包上。
 *
 * 用法：
 *   node scripts/patch-ofm.mjs                    # 自动找包，体检 + 落盘
 *   node scripts/patch-ofm.mjs --dry-run          # 只体检
 *   node scripts/patch-ofm.mjs --dir <path>       # 指定包目录
 *   node scripts/patch-ofm.mjs --restore          # 从 .lane-fix-orig/ 回滚
 *   node scripts/patch-ofm.mjs --verify           # 逐字节核对落盘结果（改完必跑）
 *
 * 为什么是"脚本改文件"而不是"运行时包一层"：这四处毛病在**上游的解析与账本**
 * 里，不在出网层——中间层能规范化请求，却改不了"错误 JSON 被静默丢弃"。
 * 所以这里直接改字节，但把幂等、体检、备份、回滚、逐字节校验都做齐，
 * 让它跟"手改 node_modules"区分开：可重复、可审计、可撤销。
 *
 * 上游更新会覆盖掉这些改动——这是设计上的取舍（改法有据可查，比运行时代码
 * 注入透明），升级后重跑一次即可。锚点失配时会明确报错而不是改错地方。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { applyPatchSet, inspectPatchSet, PATCHED_FILES, PATCH_SET_VERSION } from '../lib/ofm-patch.js'

// fileURLToPath 会解码 percent-encoding（路径带空格时 .pathname 是坏的），盘符也一并处理。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const BACKUP_DIR = '.lane-fix-orig'

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}
const has = flag => process.argv.includes(flag)

/**
 * 参数白名单校验。**任何不认识的参数都直接报错退出，绝不落到默认动作。**
 *
 * 为什么非要有这一道：本脚本的默认动作是「体检 + 落盘」。过去它不校验参数，
 * `--help` / `--h` / 打错一个字母（`--dryrun`）都会被静默忽略、一路走到写盘——
 * 2026-10-17 小困就是这样把 `--help` 当成查用法，结果真把 7 处补丁写进了运行包。
 * 「想知道这脚本怎么用」居然会改文件，这个失败模式必须从根上掐掉。
 */
const USAGE = `用法：node scripts/patch-ofm.mjs [选项]

  （无参数）            体检 + 落盘（默认动作，会改文件）
  --dry-run             只体检，不写盘
  --verify              逐字节核对落盘结果（改完必跑）
  --restore             从 ${BACKUP_DIR}/ 回滚
  --dir <path>          指定上游包目录（默认从 profile 的 node_modules 找）
  -h, --help            显示本用法（不写盘）`

const KNOWN_FLAGS = new Set(['--dry-run', '--verify', '--restore', '--dir', '-h', '--help'])
{
  const unknown = process.argv.slice(2).filter(arg => !KNOWN_FLAGS.has(arg))
  // --dir 的值是裸路径、不在白名单里，把它从待检列表里摘掉。
  const dirValue = argValue('--dir')
  const offending = unknown.filter(arg => arg !== dirValue)
  if (offending.length > 0) {
    console.error(`未知参数：${offending.join(' ')}\n`)
    console.error(USAGE)
    process.exit(2)
  }
  if (has('-h') || has('--help')) {
    console.log(USAGE)
    process.exit(0)
  }
}

/** 找上游包：先看 profile 的 node_modules，再退到几个常见落点。 */
function findPackage() {
  const explicit = argValue('--dir')
  if (explicit !== undefined) return path.resolve(explicit)
  const home = os.homedir()
  const candidates = [
    path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-our-free-model'),
    path.join(home, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-our-free-model'),
  ]
  for (const candidate of candidates) {
    try {
      // junction 也认：realpath 后仍是目录即可。
      if (fs.statSync(candidate).isDirectory()) return fs.realpathSync(candidate)
    } catch { /* 下一个 */ }
  }
  throw new Error('找不到 dsh-our-free-model，请用 --dir 指定包目录')
}

function readFiles(root) {
  const files = {}
  for (const name of PATCHED_FILES) {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) throw new Error(`包里缺少文件：${name}`)
    files[name] = fs.readFileSync(file, 'utf8')
  }
  return files
}

/**
 * 加载仓内的干净原文基线（baseline/ofm-<包版本>），回答一个问题：
 * 「现在这份文件，还是打补丁之前的样子吗？」
 *
 * 为什么备份前非要问这一句：备份只在缺失时创建，若文件曾被手改（补丁已应用、
 * 或被改成未知状态），直接把现状存成备份，--restore 就会把文件换回一个错误
 * 状态——备份语义失真。所以备份落盘前先与基线比对，对得上才配叫「原文备份」。
 *
 * 基线自身先过 SHA256SUMS 清单：基线损坏或被换过时宁可报错，不能拿一份不可信
 * 的基线把脏文件判成干净。没有与包版本匹配的基线时返回 null（上游升版后、
 * 基线还没重导），调用方按「无法证明干净」处理。
 */
function loadBaseline(root) {
  let version
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  } catch {
    return null
  }
  const dir = path.join(HERE, '..', 'baseline', `ofm-${version}`)
  if (!fs.existsSync(dir)) return null
  const sums = new Map(
    fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8')
      .trim().split('\n')
      .map(line => { const [hash, name] = line.trim().split(/\s+/); return [name, hash] }),
  )
  const files = {}
  for (const name of PATCHED_FILES) {
    const expected = sums.get(name)
    if (expected === undefined) {
      throw new Error(`baseline/ofm-${version}/SHA256SUMS 缺 ${name}：基线与补丁集不同步，先补基线再落盘`)
    }
    let raw
    try {
      raw = gunzipSync(fs.readFileSync(path.join(dir, `${name.replace(/\//g, '__')}.gz`)))
    } catch {
      throw new Error(`baseline/ofm-${version} 缺 ${name.replace(/\//g, '__')}.gz（或解不开），先补基线再落盘`)
    }
    const actual = createHash('sha256').update(raw).digest('hex')
    if (actual !== expected) {
      throw new Error(`baseline/ofm-${version} 的 ${name} sha256 与清单不符——基线已损坏，拒绝据此判定「干净」`)
    }
    files[name] = raw.toString('utf8')
  }
  return { dir, version, files }
}

const GLYPH = { applied: '✓ 已应用', ready: '· 待应用', 'anchor-lost': '✗ 锚点失配', 'missing-file': '✗ 文件缺失' }

function printReport(rows) {
  for (const row of rows) {
    console.log(`  ${GLYPH[row.status] ?? row.status}  ${row.file.padEnd(11)} ${row.id.padEnd(24)} ${row.title}`)
  }
}

const root = findPackage()
console.log(`补丁集 v${PATCH_SET_VERSION} → ${root}\n`)

if (has('--restore')) {
  const backups = PATCHED_FILES.map(name => ({
    name,
    from: path.join(root, BACKUP_DIR, name.replace(/\//g, '__')),
    to: path.join(root, name),
  }))
  const missing = backups.filter(row => !fs.existsSync(row.from))
  if (missing.length > 0) {
    console.error(`没有备份，无法回滚：${missing.map(row => row.name).join('、')}`)
    process.exit(1)
  }
  for (const row of backups) fs.copyFileSync(row.from, row.to)
  console.log(`已从 ${BACKUP_DIR}/ 回滚 ${backups.length} 个文件。`)
  process.exit(0)
}

const files = readFiles(root)

if (has('--verify')) {
  const { report } = applyPatchSet(files)
  const stale = report.filter(row => row.status !== 'applied')
  printReport(report)
  if (stale.length > 0) {
    console.error(`\n有 ${stale.length} 处不是"已应用"状态——落盘结果与补丁集不一致。`)
    process.exit(1)
  }
  console.log('\n全部已应用，且落盘字节与补丁集完全一致。')
  process.exit(0)
}

// 体检 + 落盘（--dry-run 只到体检为止）。
let result
try {
  result = applyPatchSet(files)
} catch (error) {
  console.error(String(error.message))
  process.exit(1)
}
printReport(result.report)

const changed = PATCHED_FILES.filter(name => result.files[name] !== files[name])
const already = result.report.filter(row => row.status === 'applied').length
console.log(`\n体检：${already} 处已应用，${changed.length} 个文件待改。`)

if (has('--dry-run')) {
  console.log('（--dry-run，未写盘）')
  process.exit(0)
}
if (changed.length === 0) {
  console.log('无需改动，收工。')
  process.exit(0)
}

// 首次落盘前留一份原文件，回滚才有依据。备份只在「当前内容 == 干净基线」时
// 才按常规名落盘：文件曾被手改（补丁已应用/被改成未知状态）时，把现状存成
// 常规备份，之后 --restore 会把文件换回这个错误状态——语义失真。那种情况
// 落 .patched-<时间戳> 后缀留给人工核对，--restore 不碰它。
const baseline = loadBaseline(root)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = path.join(root, BACKUP_DIR)
fs.mkdirSync(backupDir, { recursive: true })
let patchedBackups = 0
for (const name of changed) {
  const backupName = name.replace(/\//g, '__')
  const backup = path.join(backupDir, backupName)
  if (fs.existsSync(backup)) continue
  if (baseline !== null && files[name] === baseline.files[name]) {
    fs.copyFileSync(path.join(root, name), backup)
    continue
  }
  const patched = `${backup}.patched-${stamp}`
  fs.copyFileSync(path.join(root, name), patched)
  patchedBackups += 1
  const why = baseline === null
    ? '仓内没有与包版本匹配的干净基线（baseline/），无法证明当前内容是打补丁前的原文'
    : `与 ${path.relative(HERE, baseline.dir).replaceAll('\\', '/')} 的干净基线不一致`
  console.error(`  ⚠ 检测到文件已被修改，本次备份的是已改状态，--restore 前请确认：${name}`)
  console.error(`    判定依据：${why}。`)
  console.error(`    已改状态备份在 ${BACKUP_DIR}/${backupName}.patched-${stamp}；--restore 只认常规备份，不会动这份，也就意味着 ${name} 无法用 --restore 回滚。`)
}
for (const name of changed) {
  const target = path.join(root, name)
  fs.writeFileSync(target, result.files[name], 'utf8')
  console.log(`  写入 ${name}（${fs.statSync(target).size} 字节）`)
}
console.log(`\n完成。原文件在 ${BACKUP_DIR}/，回滚：node scripts/patch-ofm.mjs --restore`)
if (patchedBackups > 0) {
  console.log(`⚠ 其中 ${patchedBackups} 份备份是已改状态（.patched-* 后缀），--restore 不会恢复它们——回滚前先人工确认。`)
}
console.log('**改动要重启 DSH 才生效。**')
