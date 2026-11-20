/**
 * UserPromptSubmit hook：从用户这句话里认出「子代理要用哪个模型」，
 * 存进状态并注入一条模型可见的提醒（UserPromptSubmit 不能改写原始 prompt，
 * 所以真正的替换在 PreToolUse 里做）。
 *
 * 支持两种来源：
 *   1. 确定式标记 `[[zmodel:glm-5.3]]` / `[[zmodel:off]]`（斜杠命令 /zmodel 用它）
 *   2. 自然语言「用 GLM-5.3 开个子代理」这类句子
 */

import { emit, ensureAdapter, log, readHookInput, readState, writeState } from './_shared.mjs'

try {
  const input = await readHookInput()
  const prompt = String(input.prompt ?? '')
  // 动态 import，保证 _shared.mjs 的解析失败不会让 hook 崩掉
  const { detectPreference } = await import('./_shared.mjs')
  const detected = detectPreference(prompt)

  if (detected.model === '__off__') {
    writeState({ model: undefined, effort: undefined, cleared: true, at: new Date().toISOString() })
    log('user-prompt-submit model=off (cleared)')
    emit({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: '用户取消了子智能体的指定模型：本次及之后派发的子智能体回到跟随主会话模型。',
      },
    })
    process.exit(0)
  }

  if (detected.model === undefined) {
    log('user-prompt-submit model=<none>')
    emit(undefined)
    process.exit(0)
  }

  const state = {
    model: detected.model,
    effort: detected.effort,
    at: new Date().toISOString(),
    session_id: input.session_id,
  }
  const adapter = ensureAdapter(detected.model, { effort: detected.effort })
  state.adapter = adapter.name
  state.adapterFile = adapter.file
  writeState(state)
  log(`user-prompt-submit model=${detected.model} effort=${detected.effort ?? '-'} adapter=${adapter.name} created=${adapter.created}`)

  emit({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: [
        `【子智能体模型偏好】用户这次要求子智能体运行在模型 \`${detected.model}\`${detected.effort === undefined ? '' : `，思考强度 \`${detected.effort}\``}。`,
        `本会话已准备好对应子智能体类型 \`${adapter.name}\`（定义文件 ${adapter.file}）。`,
        `派发子智能体时把 subagent_type 设为 \`${adapter.name}\`（Explore 类的只读调查用 \`${adapter.name}-ro\`）；` +
          '如果工具参数支持直接写 model，也可以填该模型。子智能体的模型在创建时固定，运行中不能换。',
      ].join(''),
    },
  })
} catch (error) {
  log(`user-prompt-submit failed: ${error?.message ?? error}`)
}
process.exit(0)
