/**
 * 对上游 `dsh-our-free-model` 的补丁集 —— 纯数据 + 纯函数。
 *
 * 为什么要有这一层：`dsh-maid-lane-fix` 原本只修**免费车道**（opencode.ai）的
 * 两道指纹门，那是靠包 `globalThis.fetch` 做的中间层，不动上游一个字节。
 * 但共付车道（EAC）暴露的是另一种毛病——**它自己不会喊疼**：网关的 `keepalive`
 * 注释帧给空闲超时无限续命、EAC 行从不进探测轮、测速按钮的结果活不过按钮，
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
 * ## v2 的重设计（对齐上游 2.5.2）
 *
 * 补丁集跟着上游 2.5.2 重新核过一遍，三件事变了：
 *
 * 1. **`bare-json-is-a-failure` 退休**：上游自己在 `src/http.js` 的 `line()`
 *    里加了裸 JSON 聚合（`rawJson`），非 2xx 语义的 error 体会抛 `classifyFailure`。
 *    原来的活代码价值归零，留着只会锚点失配。
 * 2. **空闲时钟的判据整个换了**：上游把 `emit(line, onData)` 换成了
 *    `line(value)`，**返回值语义翻转**——旧的 emit 返回"服务器说话了吗"，
 *    新的 line 返回"这条流该终止了吗"（`[DONE]` 与错误命中时 `return true`）。
 *    注释帧 `return false`、真数据帧也 `return false`：**光看返回值，心跳和
 *    进展分不开**。所以不再复用它的返回值，改为在 `onData` 调用处置一个
 *    自己的 `progressed` 见证位（3 处补丁：声明、dispatch、裸 JSON 分支），
 *    循环尾部据此决定要不要上弦。
 * 3. **`verdict-outlives-the-round` 挪锚点**：上游在 summary 的 map 里插了
 *    `hiddenByUser` / `hiddenByGroup` 两行，锚点整段后移，逐字对齐新原文。
 *
 * ## v4 的退休（对齐上游 2.5.7）
 *
 * 上游 2.5.7 把 `index.js` 里的 bench 整块重构进了 `src/core/runtime.js` +
 * `src/model-test.js`，三处 index.js 补丁的功能**已被上游原生化**，硬塞只会
 * 打错地方，故整条注释作废（原文留在注释块里备查，上游哪天回退再按注释重锚）：
 *
 * - `bench-records-a-verdict`：`runtime.testModel` 现在自己
 *   `availability.edit(… manualResults …)` + `flush()`；空答案/无正常收尾在
 *   `measureModelTest` 里抛 `CODE.empty`，零帧不再是"成功"。
 * - `bench-ttft-from-measured`：返回值直接铺 `measured.ttftMs`（实测值），
 *   三元兜底随旧代码一起消失了。
 * - `verdict-outlives-the-round`：summary 改用 `modelAvailability(id, snapshot,
 *   listed)`，有 `manualResults` 记录的行原生读记录。
 *
 * 另外 `bench-deadline` 在 2.5.7 上实际也是上游自己改的（发布原文里就是
 * `330_000`，注释是上游措辞），marker 恰好命中所以仍显示"已应用"——保留条目
 * 只为兼容 2.5.3 基线的重放，不必动。
 *
 * ## v5 的复核（对齐上游 2.5.9，2026-10-23）
 *
 * 上游 auto-update 把现役包从 2.5.7 顶到 2.5.9，整包覆盖把 v4 落盘的七处改动
 * **全冲掉了**（`--verify` 逐条报 `待应用`）。复核结论是 **零重锚、零新作废**：
 *
 * - `src/http.js` 与 `src/eac.js` 在 2.5.9 里与 2.5.7 基线**逐字节相同**
 *   （sha256 一致、gz 体积一致），七处锚点逐字仍在，原样重放即可；
 * - 2.5.9 真正的改动只在 `client.js`（前端「视觉特效」开关：`effects.enabled`
 *   文案、`.ofm_navtools` 布局、`data-ofm-effects="off"` 降级样式）与 `index.js`
 *   （渠道精简：CodeArts/华为云移除、`outlet.fetchSigned` 收窄、挂载日志改口径），
 *   都不落在任何补丁锚点上，`client.js` 的 bench 超时仍是上游自己的 `330_000`；
 * - `index.js` 三处维持 v4 的 RETIRED，不动。
 *
 * 所以 v5 只做两件事：补 `baseline/ofm-2.5.9/`（`--verify` / `--restore` 需要与
 * 包版本匹配的干净对照），以及把这份复核结论落到版本号上——否则人看见
 * 「补丁集 v4」会以为只适配到 2.5.7，下次上游再动就会误判成还没核过。
 *
 * ## v6 的一处补回（2026-10-23：文档写了的，代码里没有）
 *
 * 事故单 2.15 那处「OFM Chat wire 遗漏 developer 角色」，`TROUBLESHOOTING.md`
 * 的 :300 / :302 / :360 / :544 都写着「已并入补丁集」，但 v4 → v5 重做时**实际漏掉了**：
 * 本文件里 `developer` 此前零命中，`PATCHED_FILES` 也从不含
 * `vendor/channel-pack/pack.js`。文档于是描述了一个并不存在的补丁——现役 pack.js
 * 里 `convertMessage` 的分派一个字没改，宿主一发 developer 角色照样 HTTP 400。
 *
 * v6 就这么一处：补回 `developer-role-on-chat-wire`，并把基线补齐
 * （`baseline/ofm-2.5.9/vendor__channel-pack__pack.js.gz`，原文 sha256
 * `0a70f2ab6396…20592c`，2592919 B）。基线不是可选项：`--verify` 要拿「干净基线
 * 重放一遍」和落盘字节比对，`loadBaseline()` 又要求每个 `PATCHED_FILES` 成员都有
 * 对应 .gz 与 SHA256SUMS 行，缺了它整批拒绝工作。
 *
 * @module lib/ofm-patch
 */

/** 补丁集版本：上游结构变了就升它，好让人一眼看出补丁器跟的是哪一版。 */
export const PATCH_SET_VERSION = '6'

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
    id: 'idle-clock-witness',
    file: 'src/http.js',
    title: '给空闲时钟立一个"真帧"见证位，并把判据写在它旁边',
    why: [
      '`timeoutMs` 是**空闲**预算，原来的代码每收到一个 chunk 就重置 deadline。',
      '网关的 `: keepalive` 是心跳、不是进展，让它上弦等于把"上游没应答"',
      '伪装成"连接很健康"。',
      '',
      '为什么不复用 `line()` 的返回值：上游 2.5.2 把它改成了**终止信号**',
      '（`[DONE]`、错误命中时 true），而注释帧与真数据帧都返回 false——',
      '心跳与进展在那个返回值里是同一个值，用不了。所以自带一个见证位：',
      '只在"把载荷交给 `onData`"那一处置位，由循环尾部消费。',
    ],
    marker: 'let progressed = false',
    from: `  let deadline = Date.now() + timeoutMs`,
    to: [
      `  // One clock, but only real frames may wind it. \`timeoutMs\` is an idle budget:`,
      `  // the gateway's \`: keepalive\` comment every ~15s used to reset it, so a model`,
      `  // whose upstream never produced a token held the turn open indefinitely.`,
      `  //`,
      `  // \`progressed\` is set where a payload is handed to \`onData\` — the one event`,
      `  // that means the server spoke. Do *not* reuse \`line()\`'s return value for`,
      `  // this: upstream returns \`true\` there for the opposite fact (this stream is`,
      `  // done), and returns \`false\` both for a comment line and for a real frame,`,
      `  // so heartbeat and progress are indistinguishable in it.`,
      `  let progressed = false`,
      `  let deadline = Date.now() + timeoutMs`,
    ].join('\n'),
  },
  {
    id: 'idle-clock-dispatch',
    file: 'src/http.js',
    title: '分派出去的事件帧是进展',
    why: ['`dispatch()` 把攒够的 `data:` 载荷交给下游，那一刻就是"服务器说话了"。'],
    marker: `onData(payload)\n      progressed = true`,
    from: [
      `  const dispatch = () => {`,
      `    const payload = data.join('\\n')`,
      `    data = []`,
      `    if (payload.trim() === '[DONE]') return true`,
      `    if (payload !== '') onData(payload)`,
      `    return false`,
      `  }`,
    ].join('\n'),
    to: [
      `  const dispatch = () => {`,
      `    const payload = data.join('\\n')`,
      `    data = []`,
      `    if (payload.trim() === '[DONE]') return true`,
      `    if (payload !== '') {`,
      `      onData(payload)`,
      `      progressed = true`,
      `    }`,
      `    return false`,
      `  }`,
    ].join('\n'),
  },
  {
    id: 'idle-clock-rawjson',
    file: 'src/http.js',
    title: '裸 JSON 事件体也是进展',
    why: [
      '上游 2.5.2 起会在流里聚合裸 JSON 文档（`rawJson`）并把它当事件体转发。',
      '那条路径同样经过 `onData`，所以同样得上弦——否则一个只用裸 JSON 说话的',
      '中继会被自己的空闲超时掐掉。',
    ],
    marker: `onData(JSON.stringify(payload))\n      progressed = true`,
    from: [
      `      rawJson = ''`,
      `      if (payload?.error || payload?.type === 'error') throw classifyFailure(undefined, payload)`,
      `      onData(JSON.stringify(payload))`,
      `      return false`,
    ].join('\n'),
    to: [
      `      rawJson = ''`,
      `      if (payload?.error || payload?.type === 'error') throw classifyFailure(undefined, payload)`,
      `      onData(JSON.stringify(payload))`,
      `      progressed = true`,
      `      return false`,
    ].join('\n'),
  },
  {
    id: 'idle-clock-wind',
    file: 'src/http.js',
    title: '只有真帧能上弦：注释帧不许给空闲超时续命',
    why: [
      '循环尾部原来是无条件重置 deadline，于是"一屏 `: keepalive`"与',
      '"一屏真数据"对超时时钟的效果完全一样。改成消费见证位：本 chunk 里',
      '一帧真载荷都没有，deadline 就原地不动，上面那个竞速读超时照常发生。',
    ],
    marker: 'if (progressed) {',
    from: [
      `      let newline = buffer.indexOf('\\n')`,
      `      while (newline !== -1) {`,
      `        const row = buffer.slice(0, newline)`,
      `        buffer = buffer.slice(newline + 1)`,
      `        if (line(row)) return`,
      `        newline = buffer.indexOf('\\n')`,
      `      }`,
      `      deadline = Date.now() + timeoutMs`,
    ].join('\n'),
    to: [
      `      let newline = buffer.indexOf('\\n')`,
      `      while (newline !== -1) {`,
      `        const row = buffer.slice(0, newline)`,
      `        buffer = buffer.slice(newline + 1)`,
      `        if (line(row)) return`,
      `        newline = buffer.indexOf('\\n')`,
      `      }`,
      `      // Wind the idle clock only for a chunk that carried a real frame. A chunk`,
      `      // of nothing but \`: keepalive\` comments leaves \`progressed\` false, so the`,
      `      // deadline stands and the racing read above times out as it should.`,
      `      if (progressed) {`,
      `        progressed = false`,
      `        deadline = Date.now() + timeoutMs`,
      `      }`,
    ].join('\n'),
  },
  /* RETIRED（2.5.7 已原生化，2026-10-21 重锚时注释作废）：
     上游把 bench 重构进 src/core/runtime.js 的 testModel——成功路径自己
     availability.edit(manualResults) + flush()，空答案/无收尾在 measureModelTest
     里抛 CODE.empty，旧 index.js 内联实现整段消失、锚点不可能再命中。
     原文备查，上游若回退再按注释重锚：
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
  /* RETIRED（2.5.7 已原生化）：ttft 取实测值这点上游在 measureModelTest 里直接
     返回 measured.ttftMs 并整体铺进结果对象，旧的内联三元写法随 bench 重构
     （index.js → src/core/runtime.js + src/model-test.js）一起消失了。原文备查：
  {
    id: 'bench-ttft-from-measured',
    file: 'index.js',
    title: '返回值用上面那份已经校验过的 ttft',
    why: ['零帧的情形已经在上面抛掉了，这里不再需要三元表达式兜底。'],
    marker: '        ttftMs,',
    from: `        ttftMs: firstFrame === undefined ? ms : firstFrame - started,`,
    to: `        ttftMs,`,
  },
  */
  {
    id: 'eac-body-limit-constant',
    file: 'src/eac.js',
    title: '把网关的 8 MiB 请求体上限写成一个有名字的常量',
    why: [
      '共付车道的网关按**请求体字节**卡：实测 8388608 字节放行、8388609 字节回',
      '413——边界精确到字节，正好 8 MiB。而本地这条链路从头到尾**一处上限都没有**：',
      '`postSealedStreamed` 拿到什么 body 就 `JSON.stringify` 出去，话越长越危险。',
      '',
      '写成常量而不是散在判断里的字面量，是因为这个数**来自测量、不来自文档**：',
      '上游哪天放宽了，要改的是一行数字，而不是去 grep 每个分支。',
    ],
    marker: 'const EAC_BODY_LIMIT_BYTES = 8 * 1024 * 1024',
    from: [
      `const LISTING_TIMEOUT_MS = 15000`,
      `const TURN_TIMEOUT_MS = 300000`,
    ].join('\n'),
    to: [
      `const LISTING_TIMEOUT_MS = 15000`,
      `const TURN_TIMEOUT_MS = 300000`,
      `// The co-paid gateway refuses any request body above 8 MiB — measured at the`,
      `// byte: 8388608 passes, 8388609 comes back HTTP 413. Nothing on this side used`,
      `// to check, so a long conversation simply hit that wall upstream and the 413`,
      `// text surfaced in the UI as if it were the harness's own limit. Name the`,
      `// number once, so the refusal can be raised before the bytes leave the process.`,
      `const EAC_BODY_LIMIT_BYTES = 8 * 1024 * 1024`,
    ].join('\n'),
  },
  {
    id: 'eac-body-limit-before-send',
    file: 'src/eac.js',
    title: '超限的 body 在出网之前就拒掉，并把原因说成人话',
    why: [
      '上游的 413 只回一句 `request body too large`——不说是哪一轮、不说多大、',
      '不说怎么办。用户看到的就是输入框上方一行红字，查不出所以然（这次就是',
      '这么来的）。本地先量一遍，等于把「网关的拒绝」翻译成「你的这一轮多大、',
      '上限多少、有哪几个办法」。',
      '',
      '为什么归类成 `CLIENT_ERROR` 而不是可重试码：同样的 body 再发一次，得到的',
      '是同样的拒绝。让它留在可重试集合里，只会把一个必然失败的请求重放一遍。',
    ],
    marker: 'const bodyBytes = Buffer.byteLength(bodyText, \'utf8\')',
    from: [
      `  const bodyText = JSON.stringify(body)`,
      `  const turnUrl = \`\${credential.base}/chat/completions\``,
    ].join('\n'),
    to: [
      `  const bodyText = JSON.stringify(body)`,
      `  // Refuse an oversized turn here rather than at the gateway. The wire limit is`,
      `  // 8 MiB (measured: 8388608 bytes pass, 8388609 are answered 413) and a 413`,
      `  // from upstream is a bare "request body too large" — it names neither the`,
      `  // conversation that overflowed nor any way to fix it, and arriving as a`,
      `  // transport-shaped failure it invites a retry that cannot possibly succeed.`,
      `  const bodyBytes = Buffer.byteLength(bodyText, 'utf8')`,
      `  if (bodyBytes > EAC_BODY_LIMIT_BYTES) {`,
      `    throw new UpstreamError(`,
      `      \`本轮请求体为 \${bodyBytes} 字节，超过 EAC 共付网关的 \${EAC_BODY_LIMIT_BYTES} 字节（8 MiB）上限，已在本地拦截，未发送。请缩短会话、移除大附件或图片，或在新会话中继续；原样重试无效。\`,`,
      `      CODE.client,`,
      `    )`,
      `  }`,
      `  const turnUrl = \`\${credential.base}/chat/completions\``,
    ].join('\n'),
  },
  {
    id: 'eac-413-restated',
    file: 'src/eac.js',
    title: '网关自己回 413 时，补一句它没说的上限',
    why: [
      '本地那道前置检查挡不住两件事：body 在签名之后又变了，或者网关的算法与',
      '我们量的不同。那时 413 还是会回来，而它的原文案只有一个结论、没有数字。',
      '',
      '重新包装而不是原样透传，是因为**这句话必须以用户的处境结尾**：知道上限',
      '是 8 MiB，才知道该删附件还是该开新会话。',
    ],
    marker: 'if (response.status === 413) {',
    from: [
      `  if (!response.ok) {`,
      `    const text = await response.text().catch(() => '')`,
      `    let payload`,
      `    try { payload = JSON.parse(text) } catch { payload = { error: { message: errorPageMessage(text, response.status) } } }`,
      `    throw classifyFailure(response.status, payload, setRetry)`,
      `  }`,
    ].join('\n'),
    to: [
      `  if (!response.ok) {`,
      `    const text = await response.text().catch(() => '')`,
      `    let payload`,
      `    try { payload = JSON.parse(text) } catch { payload = { error: { message: errorPageMessage(text, response.status) } } }`,
      `    // A 413 that reaches this line was raised by the gateway itself — the body`,
      `    // grew after the local check, or its accounting differs from ours. Its own`,
      `    // wording is a bare "request body too large", which states a verdict and`,
      `    // nothing else; restate it around the number, because only the number says`,
      `    // whether to detach an attachment or start a fresh session.`,
      `    if (response.status === 413) {`,
      `      throw new UpstreamError(`,
      `        \`EAC 共付网关以 HTTP 413 拒绝了本轮请求：请求体过大；该网关实测上限为 \${EAC_BODY_LIMIT_BYTES} 字节（8 MiB），实际判定以上游为准。请缩短会话、移除大附件或图片，或在新会话中继续；原样重试无效。\`,`,
      `        CODE.client, { status: response.status },`,
      `      )`,
      `    }`,
      `    throw classifyFailure(response.status, payload, setRetry)`,
      `  }`,
    ].join('\n'),
  },
  {
    id: 'developer-role-on-chat-wire',
    file: 'vendor/channel-pack/pack.js',
    title: 'Chat wire 也要认 developer 角色，别让宿主的开发者指令整轮 400',
    why: [
      '`vendor/channel-pack/pack.js` 是**构建产物**：上游渠道适配器的运行时读它，',
      '改 `src/*.ts` 不生效，所以这一处只能落在 pack.js 上。',
      '',
      'Chat 入站的 `convertMessage()`（2.5.9 第 56153 行）只分派 system / user /',
      'assistant / tool，末尾 `throw unsupported message role`；而 `developer` 是',
      'DSH 宿主的标准合法角色（宿主内置 `createDeveloperMessage`）。同一个文件的',
      'Responses 侧（第 56723 行）与包根的 `src/messages.js`（`:196` 的 case、',
      '`:282` / `:363` 的判断）早就认 `system || developer`——Chat wire 是唯一',
      '遗漏的分支，于是整轮在出网之前就被 400 掐掉，报错文案还像是用户输入坏了。',
      '',
      '锚点为什么要带函数头：「`if (role === "system") {`」这种裸串在 2.6MB 的',
      '构建产物里指不出落点（全文件 8 处同形判断分布在不同函数里），而行号随上游',
      '每次打包都变。取「函数签名 + 四行前置校验 + 那一行判断」整段，实测全文',
      '**唯一命中 1 次**，替换不可能误伤。',
    ],
    marker: 'if (role === "system" || role === "developer") {',
    from: [
      `async function convertMessage(raw, provider, model, bridge, limits) {`,
      `  if (!raw || typeof raw !== "object") throw new OpenAiGatewayError("messages entries must be objects");`,
      `  const value = raw;`,
      `  const role = value.role;`,
      `  if (role === "system") {`,
    ].join('\n'),
    to: [
      `async function convertMessage(raw, provider, model, bridge, limits) {`,
      `  if (!raw || typeof raw !== "object") throw new OpenAiGatewayError("messages entries must be objects");`,
      `  const value = raw;`,
      `  const role = value.role;`,
      `  // \`developer\` is a legitimate host-side role, not a typo: it carries operator`,
      `  // instructions exactly like \`system\` does (the host's createDeveloperMessage`,
      `  // emits it). This branch used to accept only system/user/assistant/tool and`,
      `  // threw \`unsupported message role\` at the end, so a developer turn killed the`,
      `  // whole request with HTTP 400 before anything left the process. The Responses`,
      `  // sibling in this same file already accepts both roles; keep them in step.`,
      `  if (role === "system" || role === "developer") {`,
    ].join('\n'),
  },
  /* RETIRED（2.5.7 已原生化）：summary 的硬编码跳过逻辑上游已重构为
     `...modelAvailability(entry.id, snapshot, unprobed(entry))`（src/model-test.js），
     有 manualResults 记录的行原生读记录，旧锚点整段消失。原文备查：
  {
    id: 'verdict-outlives-the-round',
    file: 'index.js',
    title: '有记录的行走记录，别把刚测到的数扔掉',
    why: [
      '"从没探测过"是**探测轮**的属性，不是车道的属性。共付车道被轮次跳过，',
      '但按钮按需测过它、并写进了同一个 store——有记录的行必须读记录，',
      '否则用户刚花掉的那一次读数被扔了。',
      '（上游 2.5.2 在 map 里插了 `hiddenByUser` / `hiddenByGroup` 两行，',
      '锚点整段后移，此处按新原文逐字对齐。）',
    ],
    marker: 'const skipped = entry =>',
    from: [
      `  const unprobed = entry => isEacEntry(entry) || isKiloEntry(entry) || isAggregateEntry(entry) || isComboEntry(entry)`,
      `  return {`,
      `    catalog: state.catalog.map(entry => ({`,
      `      ...entry,`,
      `      hiddenByUser: isModelHidden(entry, state.settings),`,
      `      hiddenByGroup: isModelHidden(entry, { ...state.settings, hiddenModelIds: [] }),`,
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
      `      hiddenByUser: isModelHidden(entry, state.settings),`,
      `      hiddenByGroup: isModelHidden(entry, { ...state.settings, hiddenModelIds: [] }),`,
      `      availability: skipped(entry) ? STATE.available : (snapshot.results?.[entry.id]?.state ?? STATE.unknown),`,
      `      detail: skipped(entry) ? '' : (snapshot.results?.[entry.id]?.detail ?? ''),`,
      `      probedAt: skipped(entry) ? 0 : (snapshot.results?.[entry.id]?.at ?? 0),`,
      `      ttftMs: skipped(entry) ? undefined : snapshot.results?.[entry.id]?.ttftMs,`,
      `      latencyMs: skipped(entry) ? undefined : snapshot.results?.[entry.id]?.latencyMs,`,
    ].join('\n'),
  },
  */
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
