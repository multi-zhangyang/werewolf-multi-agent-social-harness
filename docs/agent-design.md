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
- 认知工具（可选、轻量）：`recall_memory`（只读检索自己的承诺、见证的主张、信念与记忆）、
  `update_inner_state`、`read_the_room`、`log_deception_plan`。
  认知工具写下的反思笔记（cognitivePasses）每回合以 `[YOUR RECENT THINKING]` 回注到
  观察输入，并在压缩摘要提示词中明确保留——反思因此能跨回合存活，而不是被压缩抹掉；
  确定性 pinned facts 块保持纯事实，不混入模型自述文本。

**禁止**在工具 schema 里塞思考产物（候选意图、预测后果、引用数组、审计表单）。思考发生在
agent 循环的上下文里；行动只提交结果。模型坏 JSON 概率由此降到平铺工具的量级；线上修复
（wire-json：语法修复 + 毒化调用剔除）作为最后防线保留。

## 3. 世界层（确定性、与 agent 解耦）

场景 reducer 维护规则、阶段、合法行动、密封同时行动与结算。绑定行动走
`typed tool → 校验 → 领域事件 → 确定性结算`。世界不为模型代打、不注入越权信息。

## 4. 社会因果账本（纯内存）

propositions / socialActs / evidence / beliefs / actorModels / relationships /
commitments / deceptions / outcomeReconciliations 全部保存在内存账本中，承诺对账
（fulfilled/violated/void）与身份主张对账驱动观战因果页。消息旁路提取（SocialAct）除
为因果页提供内容外，高置信度（≥0.7）且不与说话者自己申报重复的提取结果会回流感知栈：
评价事件、场景怀疑钩子与对话响应压力——未申报的指控同样生效。
**不落盘、不做检索、不做赛季存档。**

## 5. 观战

- 投影：public / agent-pov / omniscient，服务端硬边界；
- 私聊、心智、欺骗计划不进 public 投影；密封阶段隐藏 token 流；
- 呈现层（tension/cue）只读事件流，不改世界；
- 主播广播面 `#/caster/:roomId`：整局只请求 public（终局后 postgame）投影，页面无视角
  切换、无返回入口（防止主播误点到全知视角）、运行状态 toast 静默。即使窗口骑乘车主
  凭证，服务端仍按请求的 mode 过滤——凭证只标记身份，不放宽数据边界。

## 6. 零落盘不变量（默认）

运行时默认零落盘：房间状态、会话历史、心智、账本、检查点、赛季档案一律只存在于进程内存。
唯一允许的磁盘写入——均为用户配置数据或显式 opt-in：
- 模型配置 `data/model-settings.json`、人物库 `data/characters.json`、房间模板
  `data/room-templates.json`、环境密钥文件（用户数据）；
- **显式 opt-in 的赛后归档**：创建房间时勾选「保存对局」，对局结束后整局
  （终局快照 + 展示事件流）写入 `data/archives/<roomId>.json`，供重启后复盘；
  归档含全知数据（含心智），鉴权以 owner token 的 sha256 比对。默认关闭，
  未开启则严格零落盘（`SOCIETY_ARCHIVE_DIR` 可改写目录）；
- `SOCIETY_DEBUG_PROVIDER=1` 时的失败交换 dump（显式调试开关）。

## 7. 指标与验证

- `GET /api/rooms/:id/metrics`（房主/操作员鉴权——含 ground truth）：内存计数器
  （有效行动率、迟到/无效拒绝、幂等命中、压力采样、turn 耗时、承诺分布、notice 率）
  与 Agent 质量信号（欺骗结局、信念校准 Brier、投票命中；`world.qualityMetrics()`，
  纯观察聚合，绝不回流 agent 上下文）；模型战绩在 `GET /api/leaderboard`；
- 门禁：lint + typecheck + 单元/契约/集成/安全/重放/混沌测试 + build；
- 真实模型 smoke：开一局、拉 `/metrics`、人工抽检提取样本与强标签。

## 8. 明确删除

决策表单（candidateIntents/strategy selection/DecisionRecord/strategy profile）、
影响链卡片、赛季（跨局会话复用、dossier）、会话文件、房间检查点/归档/启动恢复、
export/restore 机制。决策理由只存在于当时对话中，不再结构化落账。