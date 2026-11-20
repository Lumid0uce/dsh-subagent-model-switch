/**
 * ZCode 侧 hook 公共层：读写状态、生成/覆盖子智能体适配器、模型名识别。
 * 全部同步、零依赖 —— hook 是本地子进程，一行 JSON 进、退出码 + JSON 出。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function zcodeHome() {
  return process.env.ZCODE_HOME ?? join(homedir(), '.zcode')
}

export function dataDir() {
  const dir = process.env.ZCODE_PLUGIN_DATA ?? join(zcodeHome(), 'plugin-data', 'subagent-model-switch')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function stateFile() {
  return join(dataDir(), 'state.json')
}

export function readState() {
  try {
    const raw = readFileSync(stateFile(), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

export function writeState(state) {
  writeFileSync(stateFile(), JSON.stringify(state, null, 2) + '\n', 'utf8')
  return state
}

export function clearState() {
  try {
    unlinkSync(stateFile())
  } catch {
    // 不存在即已清空
  }
}

export function log(message) {
  try {
    const dir = join(dataDir(), 'log')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'hooks.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    // 日志失败不影响 hook 结果
  }
}

/** 读完 stdin 并把一行/多行 JSON 解出来；失败返回 {}。 */
export async function readHookInput() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch (error) {
    log(`stdin parse failed: ${error?.message ?? error}`)
    return {}
  }
}

/** 输出 hook 结果对象（没有内容就不输出，靠退出码表达成功）。 */
export function emit(payload) {
  if (payload === undefined || payload === null) return
  process.stdout.write(JSON.stringify(payload))
}

export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/**
 * 生成 ZCode 子智能体适配器名：1–32 字符、字母开头、小写/数字/连字符。
 * @param {string} model
 * @param {{ readOnly?: boolean }} [options]
 */
export function adapterName(model, options = {}) {
  const raw = `sm-${slugify(model)}${options.readOnly === true ? '-ro' : ''}`
  return raw.slice(0, 32).replace(/-+$/, '')
}

export function agentsDir() {
  const dir = join(zcodeHome(), 'agents')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 确保某个模型的适配器定义文件存在（不存在才写，内容由模型名决定）。
 * @param {string} model
 * @param {{ readOnly?: boolean, effort?: string }} [options]
 * @returns {{ name: string, file: string, created: boolean }}
 */
export function ensureAdapter(model, options = {}) {
  const name = adapterName(model, options)
  const file = join(agentsDir(), `${name}.md`)
  if (existsSync(file)) return { name, file, created: false }
  const readOnly = options.readOnly === true
  const lines = [
    '---',
    `name: ${name}`,
    `description: 由 subagent-model-switch 生成：固定运行在 ${model} 上的${readOnly ? '只读调查' : '通用'}子智能体；请勿手改，插件会按需重建。`,
    `model: ${model}`,
  ]
  if (options.effort !== undefined && options.effort !== '') lines.push(`thoughtLevel: ${options.effort}`)
  lines.push(`color: ${readOnly ? 'blue' : 'cyan'}`)
  if (readOnly) lines.push('tools: Read, Grep, Glob, WebFetch, WebSearch')
  lines.push('---')
  lines.push('')
  lines.push(`你是本次会话的子智能体，固定运行在模型 \`${model}\` 上。`)
  lines.push('')
  if (readOnly) {
    lines.push('你只做只读调查：定位文件、读代码、查文档、比对事实，不要修改任何文件，也不要执行会改变系统状态的命令。')
  } else {
    lines.push('按主智能体交下来的任务独立完成，动手前先确认范围。')
  }
  lines.push('结尾直接给出结果与关键证据（文件路径 + 行号、命令输出要点），主智能体看不到你的中间过程。')
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  return { name, file, created: true }
}

/** 已知模型前缀：这些开头的 token 才当成模型名候选。 */
const MODEL_PREFIX = /^(glm|kimi|deepseek|gpt|claude|sonnet|opus|haiku|qwen|gemini|gemma|llama|minimax|vanchin|siliconflow|o[1-4])/i

/** 一句话里是否在说子智能体的事。 */
export function mentionsSubagent(prompt) {
  return /子代理|子智能体|子agent|subagent|agent\b|派一个|派生|delegate/i.test(prompt)
}

/**
 * 从自然语言里抓模型名与思考强度。
 * @param {string} prompt
 * @returns {{ model?: string, effort?: string }}
 */
export function detectPreference(prompt) {
  const text = String(prompt ?? '')
  const marker = text.match(/\[\[zmodel:([^\]\n]*)\]\]/i)
  if (marker !== null) {
    const body = marker[1].trim()
    if (/^(off|clear|reset|none)$/i.test(body)) return { model: '__off__' }
    const parts = body.split(/[\s,]+/).filter(Boolean)
    const model = parts.find(part => !/^(effort|think|思考)=/i.test(part)) ?? ''
    const effortPart = parts.find(part => /^(effort|think|思考)=/i.test(part))
    return {
      model: model === '' ? undefined : model,
      effort: effortPart === undefined ? undefined : effortPart.split('=')[1],
    }
  }
  if (!mentionsSubagent(text)) return {}
  // glm-5.3 / kimi-k3 / deepseek-v4.1-flash-1017 / claude-sonnet-4.5 …
  const tokens = text.match(/[a-z][a-z0-9]*(?:[.\-_][a-z0-9]+)*/gi) ?? []
  const models = tokens
    .map(token => token.replace(/[.,;:]+$/, ''))
    .filter(token => MODEL_PREFIX.test(token) && token.length >= 3 && token.length <= 48)
  const model = models.length === 0 ? undefined : models[models.length - 1]
  const effortMatch = text.match(/(?:思考(?:强度|等级|档位)?|thinking|effort|thoughtLevel)\s*[:：=]?\s*(off|low|medium|high|max|minimal|\u4f4e|\u4e2d|\u9ad8)/i)
  const effort = effortMatch === null ? undefined : normalizeEffort(effortMatch[1])
  return {
    model,
    effort,
  }
}

function normalizeEffort(value) {
  const map = { '低': 'low', '中': 'medium', '高': 'high' }
  const lower = String(value ?? '').toLowerCase()
  return map[lower] ?? lower
}
