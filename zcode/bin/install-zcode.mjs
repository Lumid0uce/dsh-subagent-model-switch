#!/usr/bin/env node
/**
 * ZCode 侧安装器：把 zcode/ 这半个插件装到本机。
 *
 * 做四件事（都可单独关掉）：
 *   1. 复制插件目录到 ~/.zcode/plugins/subagent-model-switch
 *   2. 生成子智能体适配器 ~/.zcode/agents/sm-<model>.md（可从 models.json 预生成）
 *   3. 往 ~/.zcode/cli/config.json 写入 hooks 条目（绝对 node 路径，不依赖 PATH）
 *   4. 打开 config.hooks.enabled
 *
 * 用法：
 *   node zcode/bin/install-zcode.mjs                # 安装 / 覆盖
 *   node zcode/bin/install-zcode.mjs --dry-run      # 只看会改什么
 *   node zcode/bin/install-zcode.mjs --no-user-hooks   # 只装插件本体，不写用户级 hooks
 *   node zcode/bin/install-zcode.mjs --no-agents       # 不预生成适配器
 *   node zcode/bin/install-zcode.mjs --uninstall        # 移除 hook 条目与插件目录
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginSource = resolve(here, '..')
const argv = process.argv.slice(2)
const has = name => argv.includes(`--${name}`)
const argOf = name => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

const dryRun = has('dry-run')
const uninstall = has('uninstall')
const withAgents = !has('no-agents')
const withUserHooks = !has('no-user-hooks')
const withReadOnly = !has('no-readonly')

const zcodeHome = process.env.ZCODE_HOME ?? join(homedir(), '.zcode')
const pluginDir = argOf('plugin-dir') === undefined
  ? join(zcodeHome, 'plugins', 'subagent-model-switch')
  : resolve(argOf('plugin-dir'))
const configPath = join(zcodeHome, 'cli', 'config.json')
const nodePath = process.execPath
const HOOK_MARK = 'subagent-model-switch'
const STATUS_PREFIX = '子智能体模型偏好'

function say(line) {
  process.stdout.write(`${line}\n`)
}

function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function writeConfig(config) {
  if (dryRun) return
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
}

function hookEntries() {
  const entry = (file, statusMessage) => ({
    type: 'process',
    command: nodePath,
    args: [join(pluginDir, 'hooks', file)],
    statusMessage,
    enabled: true,
  })
  return {
    SessionStart: [{
      matcher: 'startup|clear|resume|compact',
      hooks: [entry('session-start.mjs', `${STATUS_PREFIX}：初始化`)],
    }],
    UserPromptSubmit: [{
      hooks: [entry('user-prompt-submit.mjs', `${STATUS_PREFIX}：解析`)],
    }],
    PreToolUse: [{
      matcher: 'Agent|Task',
      hooks: [entry('pre-tool-use.mjs', `${STATUS_PREFIX}：应用`)],
    }],
  }
}

function isOurs(group) {
  const hooks = Array.isArray(group?.hooks) ? group.hooks : []
  return hooks.some(item => {
    const args = Array.isArray(item?.args) ? item.args.join(' ') : ''
    return args.includes(HOOK_MARK) || String(item?.statusMessage ?? '').startsWith(STATUS_PREFIX)
  })
}

function patchHooks(config, entries) {
  const hooks = typeof config.hooks === 'object' && config.hooks !== null ? { ...config.hooks } : {}
  for (const event of Object.keys(entries)) {
    const kept = Array.isArray(hooks[event]) ? hooks[event].filter(group => !isOurs(group)) : []
    hooks[event] = [...kept, ...entries[event]]
  }
  hooks.enabled = true
  return { ...config, hooks }
}

function stripHooks(config) {
  if (typeof config.hooks !== 'object' || config.hooks === null) return config
  const hooks = { ...config.hooks }
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue
    hooks[event] = hooks[event].filter(group => !isOurs(group))
    if (hooks[event].length === 0) delete hooks[event]
  }
  return { ...config, hooks }
}

function copyPlugin() {
  if (dryRun) {
    say(`[dry-run] 复制 ${pluginSource} -> ${pluginDir}`)
    return
  }
  rmSync(pluginDir, { recursive: true, force: true })
  mkdirSync(dirname(pluginDir), { recursive: true })
  cpSync(pluginSource, pluginDir, { recursive: true })
}

async function generateAdapters() {
  const shared = await import(pathToFileURL(join(pluginDir, 'hooks', '_shared.mjs')).href)
  const manifestPath = join(pluginDir, 'models.json')
  let models = []
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    models = Array.isArray(parsed.models) ? parsed.models.map(item => (typeof item === 'string' ? { id: item } : item)).filter(item => item?.id) : []
  } catch {
    models = []
  }
  if (models.length === 0) {
    say('  没有可预生成的模型（models.json 为空）')
    return
  }
  for (const model of models) {
    const main = shared.ensureAdapter(model.id, {})
    const extra = withReadOnly ? shared.ensureAdapter(model.id, { readOnly: true }) : undefined
    say(`  适配器 ${main.name}${extra === undefined ? '' : ` / ${extra.name}`}${main.created ? '（新建）' : '（已存在）'}  ← ${model.id}`)
  }
}

function listAdapters() {
  try {
    return readdirSync(join(zcodeHome, 'agents')).filter(file => file.startsWith('sm-')).length
  } catch {
    return 0
  }
}

async function main() {
  say(`ZCode 主目录：${zcodeHome}`)
  say(`插件目录：${pluginDir}`)
  say(`node：${nodePath}`)

  if (uninstall) {
    const config = readConfig()
    writeConfig(stripHooks(config))
    if (!dryRun && existsSync(pluginDir)) rmSync(pluginDir, { recursive: true, force: true })
    say(`已移除用户级 hooks 条目${dryRun ? '（dry-run）' : ''}与插件目录。~/.zcode/agents/sm-*.md 保留，需要时手动删。`)
    return
  }

  say('')
  say('1) 复制插件')
  copyPlugin()

  if (withUserHooks) {
    say('2) 写入用户级 hooks（~/.zcode/cli/config.json）')
    const config = readConfig()
    const patched = patchHooks(config, hookEntries())
    writeConfig(patched)
    say(`  SessionStart / UserPromptSubmit / PreToolUse(Agent|Task) 已就绪，hooks.enabled=true`)
    say(`  ${dryRun ? '[dry-run] 未写入 ' : '已写入 '}${configPath}`)
  } else {
    say('2) 跳过用户级 hooks（--no-user-hooks）')
  }

  if (withAgents) {
    say('3) 生成子智能体适配器（~/.zcode/agents）')
    if (dryRun) say('  [dry-run] 跳过实际写入')
    else await generateAdapters()
    if (!dryRun) say(`  当前 sm-* 适配器共 ${listAdapters()} 个`)
  } else {
    say('3) 跳过适配器预生成（--no-agents）')
  }

  say('')
  say('完成。注意事项：')
  say('  · 适配器定义与 hooks 都在 session 启动时快照 —— 装完要新建一个 ZCode 会话才生效。')
  say('  · 插件本体（.zcode-plugin/plugin.json）也在这份目录里，若你走 ZCode 插件市场/插件目录安装，直接指向本目录即可。')
  say('  · 对话里说「用 glm-5.3 开个子代理」或执行 /zmodel glm-5.3 即可；/zmodel off 取消。')
}

main().catch(error => {
  process.stderr.write(`安装失败：${error?.stack ?? error}\n`)
  process.exit(1)
})
