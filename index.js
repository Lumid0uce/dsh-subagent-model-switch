/**
 * dsh-subagent-model-switch —— Host 半身（Node / cordis 插件）
 *
 * 作用：把「用户口头点名的模型」变成一个能真正生效的子代理。
 * DSH 官方的 `subagent` 工具只有在 Session 里带 model-selection policy 时才允许
 * 传 `provider` / `model`（policy 只在新建会话时采样一次，老会话改不动）；
 * 本插件不走那条路，而是直接调 `ctx.subagents.startActivation({ agentOptions })`，
 * 因此任何会话、任何时刻都能给子代理指定模型与思考强度。
 *
 * 注册两个工具：
 *   subagent_model   —— 带模型派发子代理（替代默认 subagent 工具）
 *   subagent_models  —— 列出本机已配置的 provider / model / 思考强度
 */

import { matchRoute, normalizeEffort } from './lib/resolve.js'

/** defineTool 拿不到时退化成恒等函数：普通对象同样能被 ctx.tools.register 接受。 */
let defineTool = definition => definition
try {
  const tools = await import('@deepseek-ai/dsh-tools')
  if (typeof tools.defineTool === 'function') defineTool = tools.defineTool
} catch {
  // 依赖未落地时保持恒等实现，插件仍可注册。
}

export const name = 'subagent-model-switch'
export const inject = ['tools', 'subagents']

const DEFAULT_SETTINGS = {
  provider: 'spawn',
  toolName: 'subagent_model',
  discoveryToolName: 'subagent_models',
  injectPrompt: true,
  maxDepth: undefined,
}

/** 往 system prompt 里注入的规则文本。 */
const POLICY_TEXT = `## 子代理模型指定（插件 subagent-model-switch）

派发子代理时，如果用户在当前请求里点名了子代理要用的模型（例如「用 GLM-5.3 开个子代理」「让负责搜索的那个用 kimi」「子代理换成 deepseek-v4.1-flash，思考开高一点」），必须用 \`subagent_model\` 工具发起这次委派：

- \`model\` 填用户说的那个模型（写成 \`provider/model\` 最稳，也接受模型 id 或显示名/别名）。
- 用户说了思考强度（高/中/低、thinking、effort）或需要更强推理时填 \`reasoning_effort\`。
- 不确定模型 id 或该模型支持哪些思考强度时，先调 \`subagent_models\` 查，不要猜。

用户没有点名模型时，照常使用默认的 \`subagent\` 工具即可。子代理的模型在创建时固定，运行中不能改；要换模型只能重新派发一个子代理。`

/**
 * 读取本机全部 provider → model 清单。
 * @param {any} llm
 * @returns {Promise<Array<{ provider: string, providerName?: string, model: string, name?: string, description?: string }>>}
 */
async function listRoutes(llm) {
  const rows = []
  let providers = []
  try {
    providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
  } catch {
    providers = []
  }
  for (const provider of providers) {
    let models = []
    try {
      models = await llm.listModels(provider.id)
    } catch {
      models = []
    }
    for (const model of Array.isArray(models) ? models : []) {
      rows.push({
        provider: provider.id,
        providerName: provider.name,
        model: model.id,
        name: model.name,
        description: model.description,
      })
    }
  }
  return rows
}

/**
 * 把候选清单渲染成给人/AI 看的文本。
 * @param {Array<{ provider: string, model: string, name?: string }>} rows
 * @param {number} [limit]
 * @returns {string}
 */
function renderRoutes(rows, limit = 240) {
  const byProvider = new Map()
  for (const row of rows) {
    const list = byProvider.get(row.provider) ?? []
    list.push(row)
    byProvider.set(row.provider, list)
  }
  const lines = []
  for (const [provider, list] of byProvider) {
    lines.push(`${provider}（${list.length} 个模型）`)
    for (const row of list.slice(0, limit)) {
      const label = row.name && row.name !== row.model ? `  — ${row.name}` : ''
      lines.push(`  ${provider}/${row.model}${label}`)
    }
    if (list.length > limit) lines.push(`  …另有 ${list.length - limit} 个`)
  }
  return lines.join('\n')
}

/**
 * @param {any} ctx
 * @param {Record<string, any>} [config]
 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(config ?? {}) }

  /** 派发工具 */
  const delegate = defineTool({
    name: settings.toolName,
    description:
      '派发一个后台子代理，并指定它运行在哪个模型上。用户点名了子代理要用的模型（例如「用 GLM-5.3 开个子代理」）时必须用本工具，而不是默认的 subagent 工具。'
      + 'model 接受 `provider/model`、模型 id、显示名或别名；reasoning_effort 填该模型支持的思考强度。',
    parameters: {
      prompt: { type: 'string', required: true, description: '交给子代理的完整任务说明。子代理看不到当前对话历史（spawn 后端），请自包含。' },
      description: { type: 'string', required: true, description: '这次派发的短标签，用于列表与完成通知。' },
      model: { type: 'string', required: true, description: '子代理使用的模型：`provider/model`、模型 id、显示名或别名（aliases: glm、kimi、deepseek、sonnet…）。' },
      reasoning_effort: { type: 'string', description: '思考强度（如 low/medium/high 或该模型自定义档位）。需要与 model 同一次调用给出。' },
      provider: { type: 'string', description: '可选：显式指定 provider，与不带 / 的 model 搭配使用。' },
      name: { type: 'string', description: '可选：子代理名字（1–32 小写字母/数字/连字符，字母开头）。' },
      cwd: { type: 'string', description: '可选：子代理的工作目录，默认继承父代理当前目录。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
      if (!llm) throw new Error('llm 服务不可用，无法解析模型路由')
      const parent = exec?.agent
      if (!parent) throw new Error('当前没有父 Agent，无法派发子代理')
      exec.signal?.throwIfAborted?.()

      const rows = await listRoutes(llm)
      let route
      let effort = normalizeEffort(args.reasoning_effort)
      const wantsPair = typeof args.provider === 'string' && args.provider !== '' && !String(args.model).includes('/')
      if (wantsPair) {
        route = { provider: args.provider, model: String(args.model).trim() }
      } else {
        const matched = matchRoute(args.model, rows)
        if (matched.error) {
          throw new Error(`${matched.error}\n\n本机可用模型：\n${renderRoutes(rows, 60)}`)
        }
        route = matched.route
        effort = effort ?? matched.effort
      }

      // 1) 路由必须真实存在，并校验思考强度是否被该模型支持
      let info
      try {
        info = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
      } catch (error) {
        throw new Error(`模型 "${route.provider}/${route.model}" 不可用：${error?.message ?? error}\n\n本机可用模型：\n${renderRoutes(rows, 60)}`)
      }
      const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts.map(item => item.id) : []
      if (effort !== undefined && efforts.length > 0 && !efforts.includes(effort)) {
        throw new Error(`模型 ${route.provider}/${route.model} 不支持思考强度 "${effort}"；可选：${efforts.join(' / ')}`)
      }
      if (effort === undefined && typeof info?.reasoning?.defaultEffort === 'string') {
        effort = info.reasoning.defaultEffort
      }

      // 2) 让 LLM 适配器自己过一遍调用配置（未知模型/强度会在这里报真错）
      await llm.resolveCallConfig(
        effort === undefined
          ? { provider: route.provider, model: route.model }
          : { provider: route.provider, model: route.model, reasoningEffort: effort },
        exec.signal,
      )

      // 3) 后端能力校验：只有 advertise agentOptions 的后端能换模型
      const getProvider = typeof ctx.subagents.getProvider === 'function'
        ? providerName => ctx.subagents.getProvider(providerName)
        : undefined
      const backend = getProvider === undefined ? undefined : getProvider(settings.provider)
      if (backend === undefined) {
        throw new Error(`subagent 后端 "${settings.provider}" 没有注册；请检查 profile 里 dsh-subagent-${settings.provider}-in-process 是否启用`)
      }
      if (backend.capabilities?.agentOptions !== true) {
        throw new Error(`subagent 后端 "${settings.provider}" 不支持给子代理指定模型（agentOptions=false）`)
      }

      const maxDepth = typeof ctx.subagents.resolveMaxDepth === 'function'
        ? ctx.subagents.resolveMaxDepth(settings.maxDepth)
        : undefined

      const started = await ctx.subagents.startActivation({
        provider: settings.provider,
        label: args.description,
        ...args.name === undefined ? {} : { name: args.name },
        ...args.cwd === undefined ? {} : { cwd: args.cwd },
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        agentOptions: {
          provider: route.provider,
          model: route.model,
          ...effort === undefined ? {} : { reasoningEffort: effort },
        },
        ...maxDepth === undefined ? {} : { maxDepth },
        signal: exec.signal,
        delivery: 'parent',
      })

      const effortNote = effort === undefined ? '' : `，思考强度 ${effort}`
      return `已派发子代理 ${started.name}，模型 ${route.provider}/${route.model}${effortNote}。它会在后台运行，完成后把结果回报到这里。`
    },
  })

  /** 发现工具 */
  const discover = defineTool({
    name: settings.discoveryToolName,
    description:
      '列出本机已配置的 provider / 模型 / 思考强度，用于在派发子代理前确认模型 id。'
      + '不给参数列全部的 provider；给 provider 列该 provider 的模型；给 provider+model 列该模型支持的思考强度；给 query 按模糊/别名匹配候选。',
    parameters: {
      provider: { type: 'string', description: '可选：provider id，例如 wb、ali、xiaomi。' },
      model: { type: 'string', description: '可选：模型 id，与 provider 一起给出时列出该模型支持的思考强度。' },
      query: { type: 'string', description: '可选：模糊查询串（支持 glm/kimi/高 这类别名）。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
      if (!llm) throw new Error('llm 服务不可用')
      const rows = await listRoutes(llm)
      if (rows.length === 0) return '当前没有任何已配置的模型（profile 里没有可用的 llm provider）。'

      if (typeof args.provider === 'string' && args.provider !== '') {
        const scoped = rows.filter(row => row.provider === args.provider)
        if (scoped.length === 0) {
          const providers = [...new Set(rows.map(row => row.provider))].join('、')
          return `provider "${args.provider}" 下没有模型；可用的 provider：${providers}`
        }
        if (typeof args.model === 'string' && args.model !== '') {
          const hit = matchRoute(`${args.provider}/${args.model}`, scoped)
          if (hit.error) return `${hit.error}\n\n${renderRoutes(scoped, 80)}`
          const info = await llm.resolveModelInfo(hit.route.provider, hit.route.model, exec.signal)
          const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : []
          const suffix = efforts.length === 0
            ? '该模型不支持思考强度。'
            : `思考强度：${efforts.map(item => `${item.id}${item.name && item.name !== item.id ? `（${item.name}）` : ''}`).join('、')}；默认 ${info.reasoning.defaultEffort}`
          return `${hit.route.provider}/${hit.route.model}\n${String(info?.description ?? '').trim()}\n${suffix}`.trim()
        }
        return renderRoutes(scoped, 400)
      }

      if (typeof args.query === 'string' && args.query !== '') {
        const hit = matchRoute(args.query, rows)
        if (hit.error) return `${hit.error}\n\n${renderRoutes(rows, 40)}`
        return `最佳匹配：${hit.route.provider}/${hit.route.model}`
      }
      return renderRoutes(rows, 400)
    },
  })

  ctx.effect(() => {
    const disposers = [ctx.tools.register(delegate), ctx.tools.register(discover)].filter(item => typeof item === 'function')
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  // system prompt 规则：可选服务，注入失败不影响工具注册
  if (settings.injectPrompt) {
    try {
      const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
      if (systemPrompt && typeof systemPrompt.context === 'function') {
        let order = 0
        try {
          if (typeof systemPrompt.getContextOrder === 'function') {
            order = systemPrompt.getContextOrder('SUBAGENT_DELEGATION')
          }
        } catch {
          order = 0
        }
        ctx.effect(() => {
          const dispose = systemPrompt.context({
            name: 'subagent-model-switch',
            order,
            text: () => POLICY_TEXT,
          })
          return () => {
            if (typeof dispose === 'function') dispose()
          }
        })
      }
    } catch {
      // 注入失败时静默降级：工具本事仍然可用
    }
  }
}
