# Agent 架构设计

Society 的运行形态：一名参与者 = 一个标准 SDK Agent，房间调度激活，世界确定性结算，
观战投影呈现。全链路**零运行时落盘**。

## 1. 一名参与者 = 一个 Agent

每个席位一个 `@openai/agents` 的 `Agent` 实例 + 一个 `MemorySession`（SDK 内置、纯内存）。
会话只存在于本局进程内，不写文件、不跨局、无赛季、无恢复——重启即清零。

每个激活回合内，`Runner.run` 以 模型→工具→模型 的标准 agent 循环执行（`maxTurns` 上限
10/24），允许一个回合内多步思考与行动。

## 2. 工具面（全部平铺参数，无表单）

- `communicate`：`{ text, channel, recipientIds?, replyTo?, socialActs? }`；
- 领域行动工具（每场景）：`{ targetId? / choice? / amount? , reason }`，与领域结算 payload 同形；
- 认知工具（可选、轻量）：`update_inner_state`、`read_the_room`、`log_deception_plan`。

**禁止**在工具 schema 里塞思考产物（候选意图、预测后果、引用数组、审计表单）。思考发生在
agent 循环的上下文里；行动只提交结果。模型坏 JSON 概率由此降到平铺工具的量级；线上修复
（wire-json：语法修复 + 毒化调用剔除）作为最后防线保留。

## 3. 世界层（确定性、与 agent 解耦）

场景 reducer 维护规则、阶段、合法行动、密封同时行动与结算。绑定行动走
`typed tool → 校验 → 领域事件 → 确定性结算`。世界不为模型代打、不注入越权信息。

## 4. 社会因果账本（纯内存）

propositions / socialActs / evidence / beliefs / actorModels / relationships /
commitments / deceptions / outcomeReconciliations 全部保存在内存账本中，承诺对账
（fulfilled/violated/void）与身份主张对账驱动观战因果页。消息旁路提取（SocialAct）继续
为因果页提供内容。**不落盘、不做检索、不做赛季存档。**

## 5. 观战

- 投影：public / agent-pov / omniscient，服务端硬边界；
- 私聊、心智、欺骗计划不进 public 投影；密封阶段隐藏 token 流；
- 呈现层（tension/cue）只读事件流，不改世界。

## 6. 零落盘不变量

运行时唯一允许的磁盘写入——均为用户配置数据或显式调试：
- 模型配置 `data/model-settings.json`、人物库 `data/characters.json`、房间模板
  `data/room-templates.json`、环境密钥文件（用户数据）；
- `SOCIETY_DEBUG_PROVIDER=1` 时的失败交换 dump（显式调试开关）。

房间状态、会话历史、心智、账本、检查点、赛季档案一律只存在于进程内存。

## 7. 指标与验证

- `GET /api/rooms/:id/metrics`：内存计数器（有效行动率、迟到/无效拒绝、幂等命中、
  压力采样、turn 耗时、承诺分布、notice 码），供 smoke 与观测使用；
- 门禁：lint + typecheck + 单元/契约/集成/安全/重放/混沌测试 + build；
- 真实模型 smoke：开一局、拉 `/metrics`、人工抽检提取样本与强标签。

## 8. 明确删除

决策表单（candidateIntents/strategy selection/DecisionRecord/strategy profile）、
影响链卡片、赛季（跨局会话复用、dossier）、会话文件、房间检查点/归档/启动恢复、
export/restore 机制。决策理由只存在于当时对话中，不再结构化落账。