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
import { applyPatchSet, inspectPatchSet, PATCHED_FILES, PATCH_SET_VERSION } from '../lib/ofm-patch.js'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const BACKUP_DIR = '.lane-fix-orig'

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}
const has = flag => process.argv.includes(flag)

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

// 首次落盘前留一份原文件，回滚才有依据。
const backupDir = path.join(root, BACKUP_DIR)
fs.mkdirSync(backupDir, { recursive: true })
for (const name of changed) {
  const backup = path.join(backupDir, name.replace(/\//g, '__'))
  if (!fs.existsSync(backup)) fs.copyFileSync(path.join(root, name), backup)
}
for (const name of changed) {
  const target = path.join(root, name)
  fs.writeFileSync(target, result.files[name], 'utf8')
  console.log(`  写入 ${name}（${fs.statSync(target).size} 字节）`)
}
console.log(`\n完成。原文件在 ${BACKUP_DIR}/，回滚：node scripts/patch-ofm.mjs --restore`)
console.log('**改动要重启 DSH 才生效。**')
