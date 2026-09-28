// Real host ToolRuntime pipeline: this is the code path that emitted
// "value is not lossless JSON" (packages/core/tools/src/index.ts:547).
const H = '/home/administrator/deepseek-harness'
const N = `${H}/packages/core/tools/node_modules/@deepseek-ai`
const { Context } = await import(`${N}/cordis/lib/index.js`)
const SystemPrompt = (await import(`${N}/dsh-system-prompt/lib/index.js`)).default
const ToolRuntime = (await import(`${H}/packages/core/tools/lib/index.js`)).default
const { CallId } = await import(`${N}/dsh-llm/lib/index.js`)

const PKG = '/home/administrator/agent-workspace/dsh-custom/plugins/dsh-cortex'
const signal = new AbortController().signal

/** Boot one bundle in-process and grab the cortex_status definition it registers. */
async function captureDefinition(bundlePath, root) {
  const mod = await import(bundlePath)
  const tools = new Map()
  const ctx = {
    tools: { register: (d) => { tools.set(d.name, d) } },
    settings: { writable: false, register: (ns, _s, cfg) => ({ get: () => ({ stateRoot: root, ...cfg.base }) }) },
    agents: { get: () => undefined, roots: () => [] },
    get: (n) => (n === 'systemPrompt' ? { context: () => () => {} } : (n === 'dshHomePath' ? (...s) => [root, ...s].join('/') : undefined)),
    inject: (svcs, cb) => { if (svcs.includes('connection')) ctx.connection = { rpc: { handle: () => () => {} } }; cb(ctx) },
    on: () => () => {}, effect: () => () => {},
  }
  mod.apply(ctx, { stateRoot: root })
  return { def: tools.get('cortex_status'), modules: mod.cortexRuntime().modules }
}

for (const [label, bundle] of [
  ['PRE-FIX bundle', `${PKG}/.dev/probe-frozen/lib-index.pre-fix.js`],
  ['FIXED bundle  ', `${PKG}/lib/index.js`],
]) {
  const root = `${PKG}/.dev/probe-frozen/reg-${label.startsWith('PRE') ? 'pre' : 'post'}`
  const { def, modules } = await captureDefinition(bundle, root)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  let line
  try {
    ctx.tools.register(def)
    const result = await ctx.tools.execute({ signal, callId: CallId('probe-1'), name: 'cortex_status', arguments: {} })
    const text = result.content?.[0]?.text ?? ''
    line = result.isError
      ? `isError=TRUE  ${JSON.stringify(text).slice(0, 90)}`
      : `isError=FALSE value.error[0]=${JSON.stringify(result.value?.modules?.[0]?.error)} keys=${Object.keys(result.value?.modules?.[0] ?? {}).join(',')} textLen=${text.length}`
  } catch (error) { line = `THREW ${error.message.slice(0, 80)}` }
  console.log(`${label} | modules_ok=${modules.filter(m => m.state === 'ok').length}/${modules.length} | registry: ${line}`)
}
