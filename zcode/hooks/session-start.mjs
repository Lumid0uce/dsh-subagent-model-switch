/**
 * SessionStart hook：会话开始/清空时重置子代理模型偏好，恢复会话时保留并补齐适配器。
 */

import { clearState, emit, ensureAdapter, log, readHookInput, readState, writeState } from './_shared.mjs'

let input = {}
try {
  input = await readHookInput()
  const source = String(input.source ?? 'startup')
  if (source === 'startup' || source === 'clear') {
    clearState()
    log(`session-start source=${source} state=reset session=${String(input.session_id ?? '')}`)
  } else {
    const state = readState()
    if (typeof state.model === 'string' && state.model !== '' && state.model !== '__off__') {
      const adapter = ensureAdapter(state.model, { effort: state.effort })
      state.adapter = adapter.name
      writeState(state)
      log(`session-start source=${source} state=kept model=${state.model} adapter=${adapter.name}`)
    } else {
      log(`session-start source=${source} state=empty`)
    }
  }
  emit(undefined)
} catch (error) {
  log(`session-start failed: ${error?.message ?? error}`)
}
process.exit(0)
