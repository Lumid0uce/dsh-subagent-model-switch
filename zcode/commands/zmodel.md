---
description: 指定子智能体使用的模型（本会话生效）。/zmodel glm-5.3、/zmodel glm-5.3 effort=high、/zmodel off
argument-hint: "<模型 id> [effort=low|medium|high] 或 off"
---

[[zmodel:$ARGUMENTS]]

已收到子智能体模型指定：`$ARGUMENTS`。

规则：接下来本会话里派发子智能体时，必须把 subagent_type 换成该模型对应的 `sm-*` 适配器（由 subagent-model-switch 插件生成），不要再用 general-purpose 默认模型跑。要取消就 `/zmodel off`。
