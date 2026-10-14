/**
 * 对上游 `dsh-our-free-model` 的四处补丁 —— 纯数据 + 纯函数。
 *
 * 为什么要有这一层：`dsh-maid-lane-fix` 原本只修**免费车道**（opencode.ai）的
 * 两道指纹门，那是靠包 `globalThis.fetch` 做的中间层，不动上游一个字节。
 * 但共付车道（EAC）暴露的是另一种毛病——**它自己不会喊疼**：网关把错误
 * JSON 裸写进 SSE、`keepalive` 注释帧给空闲超时无限续命、EAC 行从不进探测轮，
 * 三件事叠在一起，面板上表现为「这个模型测不出首字延迟」，而任何一处单看
 * 都像是「模型慢」。
 *
 * 这类毛病改不了中间层：它不在出网层，在上游的解析与账本里。所以这一份
 * 用**锚点替换**——按语义锚点定位、逐处替换、每处都带 `why`，并且：
 *
 * - **幂等**：目标文本已在场就跳过，重复跑不叠补丁；
 * - **保守**：锚点找不到就报错停下，绝不"就近猜一行"改错地方；
 * - **可回滚**：`applyPatchSet` 之外配 `restore`，原文件落在 `.lane-fix-orig/`。
 *
 * 上游哪天自己修好了，锚点会失配、补丁器会**明确报错**而不是静默重复——
 * 这正是我们要的信号：该退休了。
 *
 * @module lib/ofm-patch
 */

/** 补丁集版本：上游结构变了就升它，好让人一眼看出补丁器跟的是哪一版。 */
export const PATCH_SET_VERSION = '1'

/**
 * 每处补丁：一个语义锚点 + 一段替换。
 *
 * `id` 只用于报告；`file` 是相对上游包根的文件名；`marker` 是"已应用"的
 * 判据——取替换文本里最独特的一小段，比整段比对更耐注释微调。
 */
export const PATCHES = Object.freeze([
  {
    id: 'bench-deadline',
    file: 'client.js',
    title: '测速按钮的超时要压过后端，不能先于它放弃',
    why: [
      '后端给共付车道的一轮留了 300s 的**空闲**预算，而它的网关每 ~15s 发一个',
      '`: keepalive` 注释帧——正好把那个空闲时钟无限续命。于是"上游永不出字"的',
      '模型会让后端一直等下去，而前端 240s 先到，按钮报失败、后端还在烧。',
      '前端必须是最后放弃的那个。',
    ],
    marker: '330_000)',
    from: `          const result = await post('/bench', { model: model.id }, 240_000)`,
    to: [
      `          // The co-paid lane's poster gives a turn 300s of *idle* budget, and its`,
      `          // gateway keeps the socket warm with a \`: keepalive\` comment every ~15s`,
      `          // — which resets that idle clock forever. A model whose upstream never`,
      `          // produces a token therefore holds the backend open past any client`,
      `          // deadline. Sit above the poster's 300s instead of below it: the front`,
      `          // end must be the last to give up, or the button reports a failure the`,
      `          // server is still working on.`,
      `          const result = await post('/bench', { model: model.id }, 330_000)`,
    ].join('\n'),
  },
  {
    id: 'idle-clock-comment',
    file: 'src/http.js',
    title: '把空闲时钟的语义写在它旁边',
    why: [
      '`deadline` 从"每收到 chunk 就上弦"改成"只有真帧能上弦"之后，光看一行代码',
      '已经读不出它为什么这么做——留下判据，免得下一个人"顺手修回去"。',
    ],
    marker: 'only real frames may wind it',
    from: `  let deadline = Date.now() + timeoutMs`,
    to: [
      `  // One clock, but only real frames may wind it. \`timeoutMs\` is an idle budget:`,
      `  // the gateway's \`: keepalive\` comment every ~15s used to reset it, so a model`,
      `  // whose upstream never produced a token held the turn open indefinitely.`,
      `  let deadline = Date.now() + timeoutMs`,
    ].join('\n'),
  },
  {
    id: 'idle-clock-progress',
    file: 'src/http.js',
    title: '只有真帧能上弦：注释帧不许给空闲超时续命',
    why: [
      '`timeoutMs` 是空闲预算，可原来的代码每收到一个 chunk 就重置 deadline。',
      '网关的 `: keepalive` 是心跳、不是进展，让它上弦等于把"上游没应答"',
      '伪装成"连接很健康"。',
    ],
    marker: 'let carried = false',
    from: [
      `      let newline = buffer.indexOf('\\n')`,
      `      while (newline !== -1) {`,
      `        const line = buffer.slice(0, newline)`,
      `        buffer = buffer.slice(newline + 1)`,
      `        emit(line, onData)`,
      `        newline = buffer.indexOf('\\n')`,
      `      }`,
      `      deadline = Date.now() + timeoutMs`,
    ].join('\n'),
    to: [
      `      let newline = buffer.indexOf('\\n')`,
      `      let carried = false`,
      `      while (newline !== -1) {`,
      `        const line = buffer.slice(0, newline)`,
      `        buffer = buffer.slice(newline + 1)`,
      `        // A comment line (\`: keepalive\`, \`: channel open\`) is transport noise, not`,
      `        // evidence of progress: it must not buy the stream another idle window.`,
      `        // Anything else — data or a bare body — is the server speaking.`,
      `        if (emit(line, onData)) carried = true`,
      `        newline = buffer.indexOf('\\n')`,
      `      }`,
      `      if (carried) deadline = Date.now() + timeoutMs`,
    ].join('\n'),
  },
  {
    id: 'bare-json-is-a-failure',
    file: 'src/http.js',
    title: '裸 JSON 错误体是失败，不是"空流正常结束"',
    why: [
      '网关会先开一条 SSE 流，然后把错误 JSON **不带 `data:` 前缀**直接写进去。',
      '原来的 `emit` 只认 `data:` 行，于是那一段被静默丢弃，表现为「0 帧、流正常',
      '结束、ok: true、ttft ≈ 总耗时」——看着像测出来了，其实是个洞。',
      '下游的 `src/stream.js` 本来就认裸 JSON（`payload.error` → `classifyFailure`），',
      '所以只要把它送出去，分类是现成的。',
    ],
    marker: 'bare JSON body instead of an SSE frame',
    from: [
      `function emit(line, onData) {`,
      `  const text = line.trim()`,
      `  if (text === '' || text.startsWith(':')) return`,
      `  if (text.startsWith('data:')) {`,
      `    const payload = text.slice(5).trim()`,
      `    if (payload === '' || payload === '[DONE]') return`,
      `    onData(payload)`,
      `  }`,
      `}`,
    ].join('\n'),
    to: [
      `/**`,
      ` * Emit one SSE line; report whether the server said anything.`,
      ` *`,
      ` * The boolean is the idle clock's input, so the distinction that matters here is`,
      ` * "progress" versus "heartbeat": a comment line proves the socket is alive and`,
      ` * nothing more, and letting it refresh the deadline is how a model that never`,
      ` * answers keeps a turn open until the caller gives up.`,
      ` */`,
      `function emit(line, onData) {`,
      `  const text = line.trim()`,
      `  if (text === '') return false`,
      `  if (text.startsWith(':')) return false`,
      `  if (text.startsWith('data:')) {`,
      `    const payload = text.slice(5).trim()`,
      `    if (payload === '' || payload === '[DONE]') return false`,
      `    onData(payload)`,
      `    return true`,
      `  }`,
      `  // A relay that opens an SSE stream and then writes a bare JSON document has`,
      `  // answered with an error page rather than a frame. Skipping it silently — the`,
      `  // old behaviour — turned exactly that into a "stream finished, zero tokens,`,
      `  // ok: true" verdict, which is worse than a failure: it looks like a result.`,
      `  if (text.startsWith('{') || text.startsWith('[')) {`,
      `    let detail`,
      `    try {`,
      `      const parsed = JSON.parse(text)`,
      `      detail = parsed?.error?.message ?? parsed?.message ?? text.slice(0, 200)`,
      `    } catch { detail = text.slice(0, 200) }`,
      `    throw new UpstreamError(\`our-free-model: upstream answered the stream with a bare JSON body instead of an SSE frame: \${detail}\`, CODE.server)`,
      `  }`,
      `  return true`,
      `}`,
    ].join('\n'),
  },
  {
    id: 'bench-records-a-verdict',
    file: 'index.js',
    title: '测速就是一次探测：结果要写进账本，且零帧不算成功',
    why: [
      '共付车道的行从不进探测轮（`src/core/runtime.js` 把它排除在外），所以',
      '面板没有数可显示，卡片只能一直写"尚无结论"。可测速按钮**就是**一次',
      '探测——测完写进同一个 store，读数才能活得比按钮久。',
      '顺带：干净结束却一帧没出，不是"快"，是没答。原来记成 `ttftMs === 总耗时`',
      '加 `0 tok/s`，读起来像一次测量结果。',
    ],
    marker: 'availability.flush()',
    from: [
      `      const ms = Date.now() - started`,
      `      // Same rule as the recorded calls: the rate divides only by a window that`,
      `      // actually covers the tokens in its numerator.`,
      `      const measured = decodeWindow(firstFrame === undefined ? 0 : ms - firstFrame, windowTokens(usage, sawReasoning), true)`,
    ].join('\n'),
    to: [
      `      const ms = Date.now() - started`,
      `      // A stream that ended cleanly without ever producing a frame is not a fast`,
      `      // model, it is an unanswered request. Reporting it as a success with`,
      `      // \`ttftMs === totalMs\` and \`0 tok/s\` reads as a measurement; it is a hole.`,
      `      if (firstFrame === undefined) throw new UpstreamError('the lane closed the stream without sending a single frame', CODE.empty)`,
      `      const ttftMs = firstFrame - started`,
      `      // Same rule as the recorded calls: the rate divides only by a window that`,
      `      // actually covers the tokens in its numerator.`,
      `      const measured = decodeWindow(ms - firstFrame, windowTokens(usage, sawReasoning), true)`,
      `      // Co-paid-lane rows are never probed (\`src/core/runtime.js\` excludes them`,
      `      // from the round), so without this write the panel has no number to show`,
      `      // and the card can only ever say "no verdict yet". A bench *is* a probe:`,
      `      // record it where the panel reads, so the reading outlives the button.`,
      `      availability.edit(value => ({`,
      `        ...value,`,
      `        results: {`,
      `          ...value.results,`,
      `          [entry.id]: { state: STATE.available, ttftMs, latencyMs: ms, at: Date.now() },`,
      `        },`,
      `      }))`,
      `      availability.flush()`,
    ].join('\n'),
  },
  {
    id: 'bench-ttft-from-measured',
    file: 'index.js',
    title: '返回值用上面那份已经校验过的 ttft',
    why: ['零帧的情形已经在上面抛掉了，这里不再需要三元表达式兜底。'],
    marker: '        ttftMs,',
    from: `        ttftMs: firstFrame === undefined ? ms : firstFrame - started,`,
    to: `        ttftMs,`,
  },
  {
    id: 'verdict-outlives-the-round',
    file: 'index.js',
    title: '有记录的行走记录，别把刚测到的数扔掉',
    why: [
      '"从没探测过"是**探测轮**的属性，不是车道的属性。共付车道被轮次跳过，',
      '但按钮按需测过它、并写进了同一个 store——有记录的行必须读记录，',
      '否则用户刚花掉的那一次读数被扔了。',
    ],
    marker: 'const skipped = entry =>',
    from: [
      `  const unprobed = entry => isEacEntry(entry) || isKiloEntry(entry) || isAggregateEntry(entry) || isComboEntry(entry)`,
      `  return {`,
      `    catalog: state.catalog.map(entry => ({`,
      `      ...entry,`,
      `      availability: unprobed(entry) ? STATE.available : (snapshot.results?.[entry.id]?.state ?? STATE.unknown),`,
      `      detail: unprobed(entry) ? '' : (snapshot.results?.[entry.id]?.detail ?? ''),`,
      `      probedAt: unprobed(entry) ? 0 : (snapshot.results?.[entry.id]?.at ?? 0),`,
      `      ttftMs: unprobed(entry) ? undefined : snapshot.results?.[entry.id]?.ttftMs,`,
      `      latencyMs: unprobed(entry) ? undefined : snapshot.results?.[entry.id]?.latencyMs,`,
    ].join('\n'),
    to: [
      `  const unprobed = entry => isEacEntry(entry) || isKiloEntry(entry) || isAggregateEntry(entry) || isComboEntry(entry)`,
      `  // "Never probed" is a property of the *round*, not of the lane. A co-paid row`,
      `  // is skipped by the round, but the bench button measures it on demand and`,
      `  // writes the verdict into the same store — so a lane with a recorded row must`,
      `  // read from it, or the one number the user just paid for is thrown away.`,
      `  const skipped = entry => unprobed(entry) && snapshot.results?.[entry.id] === undefined`,
      `  return {`,
      `    catalog: state.catalog.map(entry => ({`,
      `      ...entry,`,
      `      availability: skipped(entry) ? STATE.available : (snapshot.results?.[entry.id]?.state ?? STATE.unknown),`,
      `      detail: skipped(entry) ? '' : (snapshot.results?.[entry.id]?.detail ?? ''),`,
      `      probedAt: skipped(entry) ? 0 : (snapshot.results?.[entry.id]?.at ?? 0),`,
      `      ttftMs: skipped(entry) ? undefined : snapshot.results?.[entry.id]?.ttftMs,`,
      `      latencyMs: skipped(entry) ? undefined : snapshot.results?.[entry.id]?.latencyMs,`,
    ].join('\n'),
  },
])

/** 补丁涉及的文件名（去重，保持稳定顺序）。 */
export const PATCHED_FILES = Object.freeze([...new Set(PATCHES.map(p => p.file))])

/** 判断一处补丁在给定文本里的状态。 */
export function patchStatus(patch, text) {
  if (typeof text !== 'string') return 'missing-file'
  if (text.includes(patch.marker)) return 'applied'
  if (text.includes(patch.from)) return 'ready'
  return 'anchor-lost'
}

/**
 * 对一组文件应用整个补丁集。
 *
 * 先全量体检、再统一落盘：任何一处 `anchor-lost` 都会让整批中止，
 * 不留"改了一半"的中间态。
 *
 * @param {Record<string, string>} files 文件名 → 文本。
 * @returns {{ files: Record<string, string>, report: Array<{id: string, file: string, status: string, title: string}> }}
 */
export function applyPatchSet(files) {
  const report = PATCHES.map(patch => ({
    id: patch.id,
    file: patch.file,
    title: patch.title,
    status: patchStatus(patch, files[patch.file]),
  }))

  const lost = report.filter(row => row.status === 'anchor-lost' || row.status === 'missing-file')
  if (lost.length > 0) {
    const detail = lost.map(row => `  - ${row.file} · ${row.id}（${row.title}）`).join('\n')
    throw new Error(
      `补丁锚点失配，整批中止（上游大概已经改过这些地方，请重新核对）：\n${detail}`,
    )
  }

  const next = { ...files }
  for (const patch of PATCHES) {
    const status = patchStatus(patch, next[patch.file])
    if (status !== 'ready') continue
    next[patch.file] = next[patch.file].replace(patch.from, patch.to)
  }
  return { files: next, report }
}

/** 只体检、不落盘：给 CLI 的 `--dry-run` 与启动自检用。 */
export function inspectPatchSet(files) {
  return PATCHES.map(patch => ({
    id: patch.id,
    file: patch.file,
    title: patch.title,
    status: patchStatus(patch, files[patch.file]),
  }))
}
