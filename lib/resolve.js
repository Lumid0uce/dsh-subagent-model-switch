/**
 * 共享的模型名解析层 —— dsh 插件与 ZCode hooks 都用这一个文件。
 * 纯 ESM、零依赖：宿主里被 import，ZCode 的 hook 子进程里被 node 直接跑。
 */

/** 口语 → 模型 id 片段的别名表（key 必须是 normalizeToken 之后的形式）。 */
export const ALIASES = {
  glm: 'glm',
  zhipu: 'glm',
  '智谱': 'glm',
  kimi: 'kimi',
  moonshot: 'kimi',
  '月之暗面': 'kimi',
  deepseek: 'deepseek',
  ds: 'deepseek',
  '深度求索': 'deepseek',
  reasoner: 'r1',
  r1: 'r1',
  flash: 'flash',
  pro: 'pro',
  mini: 'mini',
  max: 'max',
  sonnet: 'sonnet',
  opus: 'opus',
  haiku: 'haiku',
  claude: 'claude',
  gpt: 'gpt',
  openai: 'gpt',
  qwen: 'qwen',
  '通义': 'qwen',
  gemini: 'gemini',
  llama: 'llama',
  minimax: 'minimax',
  vanchin: 'vanchin',
  siliconflow: 'siliconflow',
}

/** 思考强度口语 → 规范 effort id。 */
const EFFORT_WORDS = {
  '高': 'high', '中': 'medium', '低': 'low',
  high: 'high', medium: 'medium', low: 'low',
  xhigh: 'xhigh', max: 'max', minimal: 'minimal',
  '强': 'high', '深': 'high', '快': 'low', '省': 'low',
}

/**
 * 归一化一个 token 用于模糊比较：小写、去掉分隔符与空白。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeToken(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s_\-.:/|]+/g, '')
}

/**
 * 把「高/中/低、high、强」之类映射成 effort id；认不出就原样返回。
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
export function normalizeEffort(value) {
  if (value === undefined || value === null) return undefined
  const raw = String(value).trim()
  if (raw === '') return undefined
  const hit = EFFORT_WORDS[raw] ?? EFFORT_WORDS[raw.toLowerCase()]
  return hit ?? raw
}

/**
 * 拆出 "model@effort" 形式里的 effort。
 * @param {string} query
 * @returns {{ body: string, effort?: string }}
 */
export function splitEffort(query) {
  const raw = String(query ?? '').trim()
  const at = raw.lastIndexOf('@')
  if (at > 0) {
    const effort = normalizeEffort(raw.slice(at + 1))
    if (effort !== undefined) return { body: raw.slice(0, at).trim(), effort }
  }
  return { body: raw }
}

/**
 * 从别名表里取候选片段。
 * @param {string} normalizedQuery
 * @returns {string | undefined}
 */
function aliasTarget(normalizedQuery) {
  if (ALIASES[normalizedQuery] !== undefined) return ALIASES[normalizedQuery]
  for (const [key, target] of Object.entries(ALIASES)) {
    if (key.length >= 2 && normalizedQuery.includes(key)) return target
  }
  return undefined
}

/**
 * 在一组 { provider, model, name } 行里给查询串打分。
 * @param {string} query
 * @param {ReadonlyArray<{ provider: string, model: string, name?: string, providerName?: string }>} rows
 * @returns {{ route?: { provider: string, model: string }, effort?: string, note?: string, error?: string }}
 */
export function matchRoute(query, rows) {
  const { body, effort } = splitEffort(query)
  if (body === '') return { error: '没有给出模型名' }
  const list = Array.isArray(rows) ? rows.filter(row => row && row.provider && row.model) : []
  if (list.length === 0) return { error: '当前没有可用的模型清单（provider 未配置或未加载）' }

  // 1) provider/model 精确形式
  const slash = body.indexOf('/')
  if (slash > 0) {
    const providerPart = body.slice(0, slash).trim()
    const modelPart = body.slice(slash + 1).trim()
    const exact = list.find(row => normalizeToken(row.provider) === normalizeToken(providerPart)
      && (row.model === modelPart || normalizeToken(row.model) === normalizeToken(modelPart)))
    if (exact !== undefined) return { route: { provider: exact.provider, model: exact.model }, effort }
  }

  const nq = normalizeToken(body)
  if (nq === '') return { error: '没有给出模型名' }
  /** @type {Array<{ row: { provider: string, model: string, name?: string }, score: number }>} */
  const scored = []
  for (const row of list) {
    const nm = normalizeToken(row.model)
    const nn = normalizeToken(row.name ?? '')
    let score = 0
    if (row.model === body) score = 100
    else if (nm === nq) score = 95
    else if (nn !== '' && nn === nq) score = 90
    else if (nm.startsWith(nq)) score = 70
    else if (nm.includes(nq)) score = 60
    else if (nq.includes(nm)) score = 55
    else if (nn.includes(nq) || (nn !== '' && nq.includes(nn))) score = 50
    else {
      const alias = aliasTarget(nq)
      if (alias !== undefined && nm.includes(alias)) score = 45
    }
    if (score > 0) scored.push({ row, score })
  }
  if (scored.length === 0) {
    return { error: `没有匹配到模型 "${body}"；先列一下可用模型再重试` }
  }
  scored.sort((a, b) => b.score - a.score || a.row.model.length - b.row.model.length)
  const top = scored[0]
  const best = scored.filter(item => item.score === top.score)
  const distinctModels = [...new Set(best.map(item => item.row.model))]
  if (best.length > 1 && top.score < 90 && distinctModels.length > 1) {
    const shown = best.slice(0, 8).map(item => `${item.row.provider}/${item.row.model}`).join('、')
    return { error: `"${body}" 有多个候选，请用 provider/model 精确指定：${shown}` }
  }
  return {
    route: { provider: top.row.provider, model: top.row.model },
    effort,
    note: `${top.row.provider}/${top.row.model}`,
  }
}

/**
 * 模型名 → 文件名安全的 slug（ZCode 适配器名用）。
 * @param {string} value
 * @returns {string}
 */
export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'model'
}

/**
 * 生成 ZCode 子智能体适配器名（必须 1–32 字符、字母开头、小写/数字/连字符）。
 * @param {string} provider
 * @param {string} model
 * @param {{ readOnly?: boolean }} [options]
 * @returns {string}
 */
export function adapterName(provider, model, options = {}) {
  const tail = options.readOnly === true ? '-ro' : ''
  const raw = `sm-${slugify(provider)}-${slugify(model)}${tail}`
  return raw.slice(0, 32).replace(/-+$/, '')
}
