#!/usr/bin/env node
/**
 * 自检脚本：不碰真机配置，全部在临时目录里跑。
 *   node test/selftest.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const hooks = join(root, 'zcode', 'hooks')

const home = mkdtempSync(join(tmpdir(), 'smsw-home-'))
const data = join(home, 'plugin-data', 'subagent-model-switch')
const env = { ...process.env, ZCODE_HOME: home, ZCODE_PLUGIN_DATA: data }

let failures = 0
function check(label, condition, extra = '') {
  const ok = Boolean(condition)
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || extra === '' ? '' : `  <- ${extra}`}\n`)
}

function runHook(file, payload) {
  const out = execFileSync(process.execPath, [join(hooks, file)], {
    input: JSON.stringify(payload) + '\n',
    env,
    encoding: 'utf8',
  })
  const text = out.trim()
  return text === '' ? undefined : JSON.parse(text)
}

// ---------- 1. resolve.js ----------
const resolveModule = await import(pathToFileURL(join(root, 'lib', 'resolve.js')).href)
const rows = [
  { provider: 'wb', model: 'cn:glm-5.3-flash', name: 'GLM-5.3 Flash' },
  { provider: 'wb', model: 'cn:kimi-k3.1-pro', name: 'Kimi K3.1 Pro' },
  { provider: 'wb', model: 'cn:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  { provider: 'ali', model: 'deepseek-v4.1-flash-1017', name: 'deepseek-v4.1-flash-1017' },
  { provider: 'xiaomi', model: 'kimi-k3', name: 'kimi-k3' },
]
const r1 = resolveModule.matchRoute('glm', rows)
check('matchRoute 别名 glm', r1.route?.model === 'cn:glm-5.3-flash', JSON.stringify(r1))
const r2 = resolveModule.matchRoute('wb/cn:kimi-k3.1-pro', rows)
check('matchRoute provider/model 精确', r2.route?.provider === 'wb' && r2.route?.model === 'cn:kimi-k3.1-pro', JSON.stringify(r2))
const r3 = resolveModule.matchRoute('kimi', rows)
check('matchRoute 别名命中 kimi 系模型', /kimi/i.test(r3.route?.model ?? ''), JSON.stringify(r3))
const r3b = resolveModule.matchRoute('flash', rows)
check('同分多候选要求精确指定而不是瞎选', typeof r3b.error === 'string', JSON.stringify(r3b))
const r4 = resolveModule.matchRoute('deepseek@high', rows)
check('matchRoute @effort 拆分', r4.effort === 'high' && typeof r4.route?.model === 'string', JSON.stringify(r4))
const r5 = resolveModule.matchRoute('不存在的模型xyz', rows)
check('matchRoute 未命中给错', typeof r5.error === 'string', JSON.stringify(r5))
check('adapterName 合规', /^[a-z][a-z0-9-]{0,31}$/.test(resolveModule.adapterName('wb', 'cn:glm-5.3-flash')),
  resolveModule.adapterName('wb', 'cn:glm-5.3-flash'))

// ---------- 2. ZCode hooks ----------
const started = runHook('session-start.mjs', { session_id: 's1', source: 'startup', hook_event_name: 'SessionStart' })
check('SessionStart 无输出且不崩', started === undefined)

const submitted = runHook('user-prompt-submit.mjs', {
  session_id: 's1',
  hook_event_name: 'UserPromptSubmit',
  prompt: '用 glm-5.3 开个子代理去查一下这个目录结构',
})
const context = submitted?.hookSpecificOutput?.additionalContext ?? ''
check('UserPromptSubmit 认出模型并注入提醒', /glm-5\.3/.test(context) && /sm-glm-5-3/.test(context), context)
const statePath = join(data, 'state.json')
check('状态落盘含 model/adapter', existsSync(statePath) && JSON.parse(readFileSync(statePath, 'utf8')).model === 'glm-5.3')
check('适配器文件已生成', existsSync(join(home, 'agents', 'sm-glm-5-3.md')))

const rewritten = runHook('pre-tool-use.mjs', {
  session_id: 's1',
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: { description: '查目录', prompt: '列出目录', subagent_type: 'general-purpose' },
})
const updated = rewritten?.hookSpecificOutput?.updatedInput ?? {}
check('PreToolUse 把 subagent_type 换成适配器', updated.subagent_type === 'sm-glm-5-3', JSON.stringify(rewritten))
check('PreToolUse 保留其它参数', updated.prompt === '列出目录' && updated.description === '查目录')

const exploreCall = runHook('pre-tool-use.mjs', {
  session_id: 's1',
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: { description: '搜索', prompt: '找一下', subagent_type: 'Explore' },
})
check('Explore 走只读适配器', exploreCall?.hookSpecificOutput?.updatedInput?.subagent_type === 'sm-glm-5-3-ro',
  JSON.stringify(exploreCall))
const roFile = join(home, 'agents', 'sm-glm-5-3-ro.md')
check('只读适配器带 tools 白名单', existsSync(roFile) && /tools: Read, Grep, Glob/.test(readFileSync(roFile, 'utf8')))

const cleared = runHook('user-prompt-submit.mjs', {
  session_id: 's1',
  hook_event_name: 'UserPromptSubmit',
  prompt: '[[zmodel:off]]',
})
check('/zmodel off 清空偏好', /取消/.test(cleared?.hookSpecificOutput?.additionalContext ?? ''),
  JSON.stringify(cleared))
const afterOff = runHook('pre-tool-use.mjs', {
  session_id: 's1',
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: { subagent_type: 'general-purpose' },
})
check('清空后不再改写', afterOff === undefined, JSON.stringify(afterOff))

const marker = runHook('user-prompt-submit.mjs', {
  session_id: 's2',
  hook_event_name: 'UserPromptSubmit',
  prompt: '[[zmodel:glm-4.6 effort=high]]',
})
check('确定式标记也能设模型', /glm-4\.6/.test(marker?.hookSpecificOutput?.additionalContext ?? ''),
  JSON.stringify(marker))
check('标记里的 effort 写进适配器', /thoughtLevel: high/.test(readFileSync(join(home, 'agents', 'sm-glm-4-6.md'), 'utf8')))

const plain = runHook('user-prompt-submit.mjs', {
  session_id: 's3',
  hook_event_name: 'UserPromptSubmit',
  prompt: '帮我把这个函数重命名一下',
})
check('没提子代理的普通请求不动状态', plain === undefined, JSON.stringify(plain))

// ---------- 3. 安装器 dry-run ----------
const dryHome = mkdtempSync(join(tmpdir(), 'smsw-dry-'))
const dryEnv = { ...process.env, ZCODE_HOME: dryHome }
const dryOut = execFileSync(process.execPath, [join(root, 'zcode', 'bin', 'install-zcode.mjs'), '--dry-run'], {
  env: dryEnv,
  encoding: 'utf8',
})
check('installer dry-run 正常退出并打印计划', /\[dry-run\]/.test(dryOut) && /hooks\.enabled/.test(dryOut))

execFileSync(process.execPath, [join(root, 'zcode', 'bin', 'install-zcode.mjs')], {
  env: dryEnv,
  encoding: 'utf8',
})
const dryConfig = JSON.parse(readFileSync(join(dryHome, 'cli', 'config.json'), 'utf8'))
check('installer 写入 hooks.enabled=true', dryConfig.hooks?.enabled === true, JSON.stringify(dryConfig.hooks?.enabled))
check('installer 写入三个事件', ['SessionStart', 'UserPromptSubmit', 'PreToolUse'].every(event => Array.isArray(dryConfig.hooks?.[event])))
check('installer 复制了插件目录', existsSync(join(dryHome, 'plugins', 'subagent-model-switch', '.zcode-plugin', 'plugin.json')))
check('installer 预生成适配器', existsSync(join(dryHome, 'agents', 'sm-glm-5-3.md')))

execFileSync(process.execPath, [join(root, 'zcode', 'bin', 'install-zcode.mjs')], { env: dryEnv, encoding: 'utf8' })
const twice = JSON.parse(readFileSync(join(dryHome, 'cli', 'config.json'), 'utf8'))
check('重复安装不产生重复 hook 条目', twice.hooks.PreToolUse.length === 1, JSON.stringify(twice.hooks.PreToolUse.length))

execFileSync(process.execPath, [join(root, 'zcode', 'bin', 'install-zcode.mjs'), '--uninstall'], { env: dryEnv, encoding: 'utf8' })
const afterUninstall = JSON.parse(readFileSync(join(dryHome, 'cli', 'config.json'), 'utf8'))
check('卸载移除 hook 条目', (afterUninstall.hooks?.PreToolUse ?? []).length === 0 || afterUninstall.hooks?.PreToolUse === undefined,
  JSON.stringify(afterUninstall.hooks))
check('卸载删除插件目录', !existsSync(join(dryHome, 'plugins', 'subagent-model-switch')))

rmSync(home, { recursive: true, force: true })
rmSync(dryHome, { recursive: true, force: true })

process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
