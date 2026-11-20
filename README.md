# dsh-subagent-model-switch

一个插件，两个宿主：让「用户点名模型 → 子代理就跑在那个模型上」这件事在 **DSH（DeepSeekRuntime）** 和 **ZCode（智谱 Z.ai）** 里都成立。

```
说一句「用 GLM-5.3 开个子代理，思考开高一点」
        │
        ├─ DSH   ：AI 调 subagent_model(prompt, model, reasoning_effort)
        │          → 校验模型/思考强度 → startActivation({ agentOptions })
        │          → 子代理真的跑在 wb/cn:glm-5.3-flash（或你点的那个）上
        │
        └─ ZCode ：UserPromptSubmit hook 认出模型 → 自动生成 ~/.zcode/agents/sm-glm-5-3.md
                   → PreToolUse hook 把 Agent 调用的 subagent_type 换掉
                   → 子智能体按 agents 定义里的 model/thoughtLevel 启动
```

## 为什么需要它

| 宿主 | 原生限制 | 本插件怎么绕 |
|---|---|---|
| DSH | 官方 `subagent` 工具只有在 Session 带 model-selection policy 时才允许传 `provider`/`model`，而 policy 只在新会话创建时采样一次 | 不走工具层的 policy 校验，插件直接调 `ctx.subagents.startActivation({ agentOptions })` |
| ZCode | 子智能体的模型写死在 `agents/*.md` 或设置页里，运行中无法改；改完要新建会话 | hook 在调用发生的那一刻改写 `subagent_type`，指向按需生成、钉死某个模型的适配器定义 |

两边共同的天花板（宿主层面，插件不假装能突破）：**子代理的模型在创建时固定，运行中不能换**；要换只能重新派一个。

## 目录

```
dsh-subagent-model-switch/
├── index.js                       # DSH 半身（cordis 插件入口，注册两个工具）
├── lib/resolve.js                 # 模型名解析：别名 / 显示名 / provider：model / @effort
├── cordis.patch.yml               # bundle 补丁：insert 本插件
├── package.json                   # dsh.bundle 指向 cordis.patch.yml
├── test/selftest.mjs              # 不碰真机配置的自检（27 项）
├── zcode/
│   ├── .zcode-plugin/plugin.json   # ZCode 插件清单
│   ├── commands/zmodel.md          # /zmodel <模型> [effort=…] / /zmodel off
│   ├── hooks/
│   │   ├── hooks.json             # SessionStart / UserPromptSubmit / PreToolUse
│   │   ├── _shared.mjs            # 状态、模型名识别、适配器生成
│   │   ├── session-start.mjs
│   │   ├── user-prompt-submit.mjs
│   │   └── pre-tool-use.mjs
│   ├── models.json                # 预生成适配器用的模型清单（按你的账号改）
│   └── bin/install-zcode.mjs      # ZCode 侧安装器 / 卸载器
└── README.md
```

## DSH 侧

### 已在本机做过的事

```bash
# 1. 装进 desktop profile（bundle 安装）
#    经 plugin_manager install_bundle，包目录：
#    E:\Develop\Project\test1\dsh-subagent-model-switch
# 2. 修好 output.schema 后重新启用：
#    plugin_manager set_plugin include:subagent-model-switch enabled=true
#    → application: applied，fiberPhase: active
```

装好后 profile 里多了一行 `subagent-model-switch`，重启后依旧生效。

### 两个工具

`subagent_model` —— 带模型派发子代理：

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | ✓ | 给子代理的任务（spawn 后端不继承父对话，写自包含） |
| `description` | ✓ | 短标签，用于列表和完成通知 |
| `model` | ✓ | `provider/model`、模型 id、显示名或别名（glm / kimi / deepseek / flash / sonnet …） |
| `reasoning_effort` | | 该模型支持时给（low/medium/high 或自定义档位），模型不支持会直接报可用档位 |
| `provider` | | 与不带 `/` 的 `model` 搭配，显式指定 provider |
| `name` / `cwd` | | 子代理名字 / 工作目录 |

执行链：`listProviders()`+`listModels()` 拿本机真实清单 → `matchRoute()`（精确 100 / 归一化 95 / 显示名 90 / 前缀 70 / 包含 60 …，同分且要求精确时列出候选而不是瞎选）→ `resolveModelInfo()` 校验存在性与思考强度 → `resolveCallConfig()` 让 LLM 适配器自己过一遍 → 检查后端 `capabilities.agentOptions === true` → `resolveMaxDepth()` → `startActivation({ agentOptions: { provider, model, reasoningEffort } })`。

`subagent_models` —— 先查再派：无参列全部 provider/模型；给 `provider` 列该 provider；给 `provider`+`model` 列思考强度与默认值；给 `query` 走模糊匹配。

另外插件会往 system prompt 里注入一段规则（order 取自 `SUBAGENT_DELEGATION`）：用户点名模型时必须用 `subagent_model`，没点名就用默认 `subagent`。注入失败的宿主环境会静默跳过，工具本身照常可用。

### 验证

```
subagent_models                        # 应列出 wb / ali / xiaomi 等 provider 下的模型
subagent_models provider=wb query=glm   # 最佳匹配 wb/cn:glm-5.3-flash
subagent_model model=glm description=冒烟 prompt=回一句 ok   # 后台子代理跑在 glm 上
```

## ZCode 侧

### 安装

```bash
node zcode/bin/install-zcode.mjs            # 装到 ~/.zcode（本机已执行）
node zcode/bin/install-zcode.mjs --dry-run  # 只看会改什么
node zcode/bin/install-zcode.mjs --uninstall
```

安装器做四件事，全部幂等：

1. 复制插件到 `~/.zcode/plugins/subagent-model-switch`
2. 往 `~/.zcode/cli/config.json` 写三条 hook（`command` 用 `process.execPath` 绝对路径，不依赖 PATH），并把 `hooks.enabled` 置 true
3. 按 `models.json` 预生成 `~/.zcode/agents/sm-<model>.md` 与 `-ro` 只读变体
4. 重装不产生重复条目；卸载只撤 hook 条目与插件目录，`agents/sm-*.md` 保留

本机当前状态：ZCode 尚未安装（`~/.zcode` 原本不存在），所以脚本先把 `~/.zcode` 树和配置种好了 —— ZCode 一装上就带着这套 hook 跑。

### 三条 hook 的职责

| 事件 | 脚本 | 行为 |
|---|---|---|
| `SessionStart` | session-start.mjs | `startup`/`clear` → 清空偏好；`resume`/`compact` → 保留并补齐适配器文件 |
| `UserPromptSubmit` | user-prompt-submit.mjs | 认出模型 → 生成适配器 + 落状态 → 注入「派子智能体时把 subagent_type 设为 sm-xxx」 |
| `PreToolUse`（matcher `Agent\|Task`） | pre-tool-use.mjs | 把 `subagent_type` 换成 `sm-<model>`（原值是 Explore 类就用 `-ro` 只读变体），其余参数原样保留 |

模型识别两种来源：确定式标记 `[[zmodel:glm-5.3 effort=high]]`（`/zmodel` 命令用它，`off` 取消），或自然语言「用 GLM-5.3 开个子代理」（要求句子提到子代理/agent，再取最后一个像模型名的 token，避免「帮我重命名这个函数」这种普通请求被误伤）。

### 适配器长这样

```markdown
---
name: sm-glm-5-3
description: 由 subagent-model-switch 生成：固定运行在 glm-5.3 上的通用子智能体；请勿手改，插件会按需重建。
model: glm-5.3
thoughtLevel: high        # 仅在指定了思考强度时出现
color: cyan
---
你是本次会话的子智能体，固定运行在模型 `glm-5.3` 上。
…
```

只读变体额外带 `tools: Read, Grep, Glob, WebFetch, WebSearch`。

### ZCode 侧已知边界

- 适配器与 hooks 都在 **session 启动时快照**，改完要新建会话；只有「主会话换模型 → 未指定 model 的子智能体跟随」是即时生效的。
- 子智能体内部不能再派子智能体；子智能体只看到会话启动时已连的 MCP。
- `models.json` 里的 id 是示例（`glm-5.3` / `glm-5.3-flash` / `glm-4.6`）。换成你账号里真实可用的 id 再重跑安装器；对话里出现表外的 id 也会在派发时按需生成。

## 自检

```bash
node test/selftest.mjs      # 27 项，全在临时目录里跑，不碰真机配置
```

覆盖：模型名解析（别名/精确/同分报错/@effort/未命中）、三条 hook 的正常路径与清理路径、适配器生成（含只读白名单与 thoughtLevel 落盘）、安装器的 dry-run / 幂等重装 / 卸载。

## 已知风险（如实标注）

1. **ZCode hooks.json 的嵌套写法**（`hooks.{事件:[{matcher, hooks:[{type:'process',…}]}]}`）是按官方 hooks 文档推断的；本机没有 ZCode，未在真机日志里验证过。首次跑起来先看 `~/.zcode/cli/log/zcode-<date>.jsonl` 有没有 `hook.run.failed`。
2. **Agent 工具的类型字段名**可能是 `subagent_type` 也可能是 `agent_type`；hook 会优先改已有的那个，都没有才新建 `subagent_type`。若真机字段名不同，`updatedInput` 会被 schema 重新校验并报错 —— 这时改 `zcode/hooks/pre-tool-use.mjs` 里 `typeKey` 的兜底值即可。
3. **DSH 侧依赖 `ctx.subagents.getProvider('spawn').capabilities.agentOptions === true`**。本机 spawn 后端满足；若换成 ACP / Codex / Claude Code 后端，该能力为 false，插件会明确报错而不是静默降级。
4. DSH profile 里官方 `tool-subagent`（名字 `subagent`）当前是停用状态，所以本次只有本插件提供的 `subagent_model` 这一条派发通道；若你重新启用官方工具，两者并存、互不冲突。
