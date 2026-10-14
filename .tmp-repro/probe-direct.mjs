// 直接调用安装版 probeModel，看真实判决
import { probeModel } from 'file:///C:/Users/Administrator/.dsh/profiles/desktop/node_modules/dsh-our-free-model/src/probe.js'

for (const id of ['space-bunny-free', 'mimo-v2.6-flash-free']) {
  const r = await probeModel({ id }, {})
  console.log(id, '=>', JSON.stringify(r))
}
