/**
 * PreToolUse hook（matcher: Agent|Task）：真正把子智能体换成指定模型的适配器。
 * 只改 subagent_type / agent_type，其余参数原样保留（updatedInput 是整对象替代，
 * ZCode 会按工具 schema 重新校验，所以这里只动一个字段）。
 */

import { emit, ensureAdapter, log, readHookInput, readState } from './_shared.mjs'

try {
  const input = await readHookInput()
  const state = readState()
  const model = typeof state.model === 'string' ? state.model : ''
  if (model === '' || model === '__off__') {
    log(`pre-tool-use passthrough (no model) tool=${String(input.tool_name ?? '')}`)
    process.exit(0)
  }

  const toolInput = input.tool_input !== null && typeof input.tool_input === 'object' ? { ...input.tool_input } : {}

  // 调用方自己已经指了具体模型 → 尊重它，不再改写
  const explicitModel = typeof toolInput.model === 'string' ? toolInput.model.trim() : ''
  if (explicitModel !== '' && explicitModel !== 'inherit') {
    log(`pre-tool-use passthrough (explicit model=${explicitModel})`)
    process.exit(0)
  }

  const typeKey = Object.prototype.hasOwnProperty.call(toolInput, 'subagent_type')
    ? 'subagent_type'
    : Object.prototype.hasOwnProperty.call(toolInput, 'agent_type')
      ? 'agent_type'
      : 'subagent_type'
  const original = String(toolInput[typeKey] ?? '')
  if (original.startsWith('sm-')) {
    log(`pre-tool-use passthrough (already adapter ${original})`)
    process.exit(0)
  }
  const readOnly = /explore/i.test(original)
  const adapter = ensureAdapter(model, { effort: state.effort, readOnly })
  toolInput[typeKey] = adapter.name

  log(`pre-tool-use rewrite ${original === '' ? '<default>' : original} -> ${adapter.name} (model=${model})`)
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: toolInput,
      permissionDecisionReason: `子智能体按用户指定运行在模型 ${model} 上（${adapter.name}）`,
    },
  })
} catch (error) {
  log(`pre-tool-use failed: ${error?.message ?? error}`)
}
process.exit(0)
