# API 调用型博弈 Agent 的欺骗、信念建模、策略搜索与评测

> Society 的前沿设计说明。本文讨论如何使用冻结的 OpenAI-compatible API 模型构建可审计的社会博弈 Agent，不讨论训练或修改模型权重。

## 0. 文档定位

本文以以下基线为准：

- 工程宪章：`AGENTS.md`；
- 代码基线：`main @ 0af7a6a`；
- 审计日期：2026-08-20；
- 产品对象：Society 多 Agent 社会世界；
- 模型形态：远程 OpenAI-compatible API；
- 规则：当前事实、目标设计与研究启发必须分开。

本文使用四种状态标记：

| 标记 | 含义 |
| --- | --- |
| **当前已验证** | 已能从当前源码和现有门禁直接确认 |
| **当前部分实现** | 已有类型或纵向切片，但尚未形成完整、跨场景、可恢复的闭环 |
| **目标设计** | 与 `AGENTS.md` 一致，尚需后续实现和验收 |
| **研究启发** | 只用于帮助设计，不代表仓库已经实现，也不构成训练路线 |

如果本文与 `AGENTS.md` 冲突，以 `AGENTS.md` 的不可破坏不变量为准。如果本文的“当前状态”与后续代码不一致，以代码、迁移和可重复门禁结果为准，并应更新本文的审计基线。

---

## 1. 摘要

Society 不需要训练一个“更会说谎”的模型。它需要把多个冻结的 API 模型放进一个边界清楚、状态可恢复、因果可追溯的社会世界，使每名参与者都能基于自己的合法观察、人物身份、信念、关系、承诺和记忆独立行动。

推荐主线是：

```text
Authorized Observation
→ Proposition / Evidence
→ Belief / ActorModel
→ Candidate Intent
→ Strategy Selector / Search
→ API Language Realization
→ Typed Command
→ Domain Result
→ Outcome Reconciliation
→ Relationship / Memory / Future Context
```

核心约束是：

1. API 模型负责理解、预测、提出候选意图和实现语言；
2. 确定性系统负责权限、规则、命令、密封行动、幂等、结算、恢复和来源；
3. 自然语言可以表达承诺、虚张声势或谎言，但不能直接改变权威世界；
4. 欺骗是否发生、是否被相信、是否改变行动，必须由社会因果链证明；
5. CFR、PSRO 和 MCTS 只用于运行时策略选择、有限搜索或评测，不更新模型权重；
6. 所有策略和评测都绑定不可变配置快照，而不是所谓“模型 checkpoint”；
7. 不保存或展示原始 chain-of-thought；
8. 不以单局胜率、精彩台词或模型自述证明机制有效。

---

## 2. 产品身份、边界与非目标

### 2.1 Society 的目标

Society 是一个面向观众的、可观察的多 Agent 社会世界。游戏是社会压力场景，不是产品本体。系统的价值在于让观众能够回答：

- 一名 Agent 当时合法看到了什么；
- 它把什么视为事实、主张、传闻或推断；
- 哪条证据改变了它的信念；
- 它如何理解其他人物的目标、知识和风险偏好；
- 它为何选择说话、私聊、沉默、承诺或执行绑定行动；
- 谁接收并相信了信息；
- 哪次信念变化可能影响了后续行动；
- 世界实际结算了什么；
- 承诺、欺骗、关系和记忆如何进入下一次互动。

### 2.2 明确非目标

本文不提出以下工作：

- SFT、DPO、KTO、PPO、GRPO 或任何权重微调；
- 训练 Belief Critic、奖励模型或价值网络；
- 蒸馏搜索轨迹到另一个模型；
- 建设 GPU 训练集群或模型 checkpoint 服务；
- 针对特定供应商、模型名称或私有字段写分支；
- 用一个中央模型读取全桌私密状态并模拟所有人物；
- 为每个人物创建会独立行动的 planner、critic 或 memory 子 Agent；
- 建设通用桌游插件平台或外部游戏 DSL；
- 从模型台词解析投票、出价、投资、返还或技能目标；
- 用更长的隐藏推理替代结构化、可审计的决策记录；
- 将现实用户、金融行为或非自愿参与者作为欺骗实验对象。

### 2.3 安全与推理隐私

允许记录：

- 观察、消息、命题和证据引用；
- 有限的一阶与二阶信念；
- 候选意图摘要和最终选择；
- 概率预测、风险估计和行动收据；
- provider 返回的安全 reasoning summary；
- 结果对账和有来源的经验。

禁止记录：

- 原始隐藏 chain-of-thought；
- Chat Completions 的 `reasoning_content`；
- 未授权人物的私有心智；
- 把模型自由文本当作世界事实；
- 把导演标题或 UI 标签反写到规范历史。

---

## 3. 当前仓库真实基线

### 3.1 当前已验证

| 能力 | 当前证据 | 边界 |
| --- | --- | --- |
| 13 个确定性场景 | `src/society/contracts.ts`、`src/society/scenarios/metadata.ts`、`src/society/scenarios/index.ts` | 场景数量不等于社会因果成熟度 |
| 每席位独立 Agent、session 和 mind | `src/society/participant.ts`、`src/society/room.ts` | 不应拆成人物内部的多个社会主体 |
| 文本通信与绑定行动分离 | 各场景 typed tools、`src/society/world.ts` | 只有合法命令和 reducer 可改变世界 |
| 稳定 `characterId` | `src/society/contracts.ts`、`profiles.ts`、`participant.ts`、`season.ts`、`room.ts` | 房间内仍需区分 actor、seat、role 和 model binding |
| 同时行动密封与命令收据骨架 | `src/society/world.ts` 及同时行动场景 | 所有恢复和迟到路径仍需持续验证 |
| 基础会话、房间归档和恢复 | `src/society/persistence/`、恢复/重放门禁 | 归档写入仍存在静默吞错风险 |
| OpenAI-compatible 模型注册与能力探测 | `src/society/models/`、`src/server/routes/rooms.ts` | 不应演变为供应商特判矩阵 |
| 当前 `xhigh` fallback | `src/society/models/reasoning-fallback.ts` | 当前是不支持时直接省略 effort；目标行为改为 `xhigh → high → provider default` 并通知用户 |
| 三栏观战工作台和 shadcn 风格组件 | `src/components/society/` | 当前仍不是完整 Social Observer |
| 正式门禁脚本 | `package.json`、`tests/` | 当前门禁尚未全绿 |

13 个场景为：

1. 囚徒困境；
2. 公共品；
3. 信任博弈；
4. 狼人杀；
5. 最后通牒；
6. 选美博弈；
7. 密封拍卖；
8. 阿瓦隆；
9. 蜈蚣博弈；
10. 胆小鬼博弈；
11. 猎鹿博弈；
12. 谈判博弈；
13. 吹牛骰。

### 3.2 当前部分实现

社会因果层已经不是空白。`src/society/social/contracts.ts` 和 `ledger.ts` 已包含：

- `Proposition`；
- `EvidenceRecord`；
- `SocialActRecord`；
- `BeliefUpdateRecord`；
- `CommitmentRecord`；
- `SocialDecisionRecord`；
- `DeceptionEpisode`；
- 带逻辑序列、可见性和来源的事件信封；
- 社会账本导出、恢复和 viewer projection。

信任博弈已经提供 Commitment 与 DecisionRecord 的初步纵向切片。部分消息可以生成结构化社会行为，欺骗计划可以进入 `planned → attempted → received → believed` 的早期状态。

这些实现仍不能被描述为“完整社会因果系统”，原因包括：

- `SocialDecisionRecord` 尚未覆盖完整候选意图、ActorModel 引用、预测与结果对账；
- `DeceptionEpisode` 类型比实际结算逻辑更完整，行为有效、识破、修复和长期后果尚未形成通用闭环；
- ActorModel 与 InfluenceLink 尚无完整单写入服务；
- belief update 主要依赖 Agent 自述，缺少系统化证据融合与校准；
- 纵向切片集中在少数场景，未覆盖全部 13 个场景；
- 社会事件、运行 trace 与 presentation 的物理边界仍需继续收窄。

### 3.3 当前尚缺失的关键能力

- 完整 ActorModel；
- 完整 InfluenceLink；
- 通用 OutcomeReconciliation；
- 跨场景 DeceptionEpisode 生命周期结算；
- 历史 Agent POV replay；
- Public / Private / Action 三角；
- 保留方向和来源的关系网络展示；
- 版本化 Candidate Intent 与策略选择器；
- CFR/PSRO/MCTS 运行时适配层；
- cross-play、冻结配置池、Brier/ECE 与反事实评测；
- API-first Social Truth Lab。

### 3.4 当前已确认的风险与审计校正

| 问题 | 当前事实 | 必须达到的状态 |
| --- | --- | --- |
| 最终输出污染长期记忆 | `participant.ts` 仍把每个非空 `finalOutput` 以固定 salience 写入 memory | 仅由 OutcomeReconciliation 与 MemoryWritePolicy 决定写入 |
| Public Archive 泄漏 | public projection 过滤了 minds 和私聊，但未正向重建 `world.details`；安全门禁要求其为空 | public/forensic archive 分层并使用 allow-list projection |
| query token | `tokenFromRequest()` 仍保留 `?token=` 兼容入口 | 只使用 Bearer、专用 header 或 HttpOnly cookie |
| 控制权限过宽 | participant token 可通过通用 `requireRoomControl()` 进入 pause/resume 等控制路径 | participant 只操作自己的合法玩家动作；room control 属于 owner/operator |
| 全局权限回退 | 未配置 operator token 时，任意有效 room owner token 可获得全局 operator 能力 | 明确部署模式；生产模式必须使用独立 operator |
| 归档失败吞错 | `RoomArchiveStore.save/load` 对异常静默返回 | 写入失败可观测、dirty 不清除、损坏状态可诊断 |
| 关系图无向合并 | `network.tsx` 使用两侧关系的 `Math.max` 合并边 | 展示 A→B 与 B→A 两条独立关系 |
| reasoning 语义 | 当前代码不会转发 Chat Completions 原始 `reasoning_content`，只接收 Responses reasoning summary；但事件仍命名为 `agent.reasoning` | 重命名或显式标记为 summary，并持续验证 SSE、归档和 POV 权限 |

最后一项是对旧审计表述的重要修正：**“当前仍暴露原始 reasoning”不是 `0af7a6a` 可由源码证实的事实。** 当前风险是命名、权限和持久化语义可能使安全摘要被误认作原始推理，而不是已经确认的原始 CoT 泄漏。

### 3.5 当前门禁状态

本次文档改写不重新运行测试，也不新增测试文件。基线审计记录为：

- 已通过：typecheck、build、contract、integration、recovery、replay、chaos；
- lint 未通过：`scripts/ui-shots.mjs` 中浏览器上下文的 `document` 被 ESLint 视为未定义；
- unit 未通过：prompt policy 用例仍期待 `log_deception_plan`；
- security 未通过：public archive 的 `world.details` 未清空。

因此，本文不得声称 CI 已全绿、公开归档已经安全或 Phase 0 已完成。

---

## 4. 欺骗必须是一条社会因果链

### 4.1 定义

欺骗不是一句错误的话，也不是模型“表现得可疑”。一次可成立的欺骗至少需要：

1. 欺骗者掌握或相信一个真实状态；
2. 欺骗者希望特定受众形成不同信念；
3. 欺骗者执行消息、隐瞒、选择性真话、虚假暗示或欺骗性承诺；
4. 目标受众实际接收到相关内容；
5. 系统能引用该内容、目标命题和受众；
6. 若宣称“成功”，还必须有受众信念或行为改变的证据。

必须区分：

- 诚实但错误；
- 猜测失败；
- 记忆错误；
- 无意含糊；
- 战略性沉默；
- 选择性真话；
- 直接说谎；
- 虚假暗示；
- 虚假承诺；
- 承诺后因新信息改变计划；
- 从承诺时就准备违约。

### 4.2 生命周期

目标生命周期为：

```text
planned? → attempted → received → believed?
                         ↓
                 behaviorally-effective?
                         ↓
              maintained / contradicted
                         ↓
                detected / failed
                         ↓
                  repaired / settled
                         ↓
           relationship + reputation + memory
```

`planned` 是可选状态。没有事先调用“欺骗计划工具”，不代表后续行为一定诚实；有计划也不代表执行、接收或成功。

### 4.3 成功分级

| 等级 | 可声称内容 | 最低证据 |
| --- | --- | --- |
| 0 | 计划过 | Agent self-report，只有计划者可见 |
| 1 | 尝试过 | 消息或行为引用 |
| 2 | 目标收到 | channel 与 audience projection |
| 3 | 目标相信 | 目标的 belief update 或高置信系统推断 |
| 4 | 改变了行动 | DecisionRecord/ActionReceipt 引用或有置信度的 InfluenceLink |
| 5 | 产生长期效果 | 关系、声誉、记忆和后续决策引用 |

只有第 4 级及以上才可使用“行为上有效”。仅发生身份揭晓不能自动叫作“某个谎言被揭穿”。

### 4.4 欺骗与承诺

承诺必须有：

- promisor；
- promisee 或 audience；
- 可引用命题；
- 绑定或非绑定行动；
- 条件与截止逻辑时间；
- 提出、接受、撤回、履约、违约或失效状态；
- 结算命令和事件来源。

没有明确承诺时：

- 零返还不自动等于背叛；
- 不合作不自动等于违约；
- 成交不自动等于联盟；
- 高返还不自动等于守约。

“欺骗性承诺”还需要证明承诺时的意图，而不是仅根据事后违约倒推。

---

## 5. 七层真相、命题、证据与信念

### 5.1 七层真相不能混用

系统必须区分：

1. World Truth；
2. Authorized Observation；
3. Communicated Claim；
4. Subjective Belief；
5. Agent Self-report；
6. Observer Inference；
7. Presentation Classification。

每个关键对象都应带 provenance：来源种类、来源 ID、逻辑时间、schema version，以及在适用时的置信度。

### 5.2 Proposition

Proposition 是可以被相信、否定、承诺或用于欺骗的稳定语义对象，例如：

- “叶澄是狼人”；
- “周岚本轮会合作”；
- “陈策的私密保底至少为 5”；
- “苏遥承诺返还至少 10”；
- “当前群体认为林默最可疑”。

不同措辞如果表达同一语义，应尽量复用相同 `propositionId`。ID 不应由完整自然语言原样拼接，也不能因为 UI 改写标题而变化。

### 5.3 Evidence

Evidence 记录“谁基于什么来源更新了哪个命题”，来源可以是：

- direct observation；
- public/private/team message；
- domain result；
- memory；
- inference；
- rumor。

证据强度与来源可靠性必须分开。Agent 可以认为某条消息强烈支持命题，同时认为说话者并不可靠。

### 5.4 BeliefState

信念是主观概率，不是世界状态副本：

\[
B_i^t(p)=
\left(
P_i^t(p),
C_i^t(p),
E_i^+(p),
E_i^-(p)
\right)
\]

其中：

- \(P_i^t(p)\) 是 Agent \(i\) 在时刻 \(t\) 对命题 \(p\) 为真的概率；
- \(C_i^t(p)\) 是对该概率稳定性的置信度；
- \(E_i^+(p)\) 与 \(E_i^-(p)\) 是支持和反对证据引用。

基础更新可以使用带来源可靠性的对数赔率：

\[
\operatorname{logit} P_{t+1}(p)
=
\operatorname{logit} P_t(p)
+
w(e)\log \Lambda(e,p)
\]

这里 \(w(e)\) 由来源可靠性、观察直接性、时间衰减和反证决定。公式是目标设计的一个候选实现，不要求所有场景共享相同更新器。

信念被证伪后不能删除，应标记为 `resolved` 或 `superseded`，保留 before/after 和触发证据。

### 5.5 ActorModel

ActorModel 表示“我认为你怎样”，不是复制目标人物真实 mind：

```ts
interface ActorModel {
  modelId: string;
  ownerCharacterId: string;
  targetCharacterId: string;
  inferredGoals: Array<{ summary: string; probability: number }>;
  inferredKnowledge: Array<{ propositionId: string; probability: number }>;
  predictedActions: Array<{ actionKey: string; probability: number }>;
  perceivedHonesty: number;
  perceivedRiskTolerance: number;
  evidenceIds: string[];
  lastUpdatedLogicalTime: number;
  schemaVersion: number;
}
```

这属于**目标设计**。二阶信念只在确有价值时维护，例如“我认为对方相信我会合作”。禁止无限递归 Theory of Mind，也禁止读取其他 Agent 的私有 ActorModel。

---

## 6. DecisionRecord 与运行时潜在策略

### 6.1 为什么需要潜在策略

API 模型的文本空间几乎无限，但可解释的社会意图相对有限：

- 提出主张；
- 温和质疑；
- 请求证据；
- 公开承诺；
- 私下协调；
- 试探联盟；
- 延迟披露；
- 防御；
- 修复关系；
- 选择性沉默；
- 误导；
- 执行场景绑定行动。

Society 不应在 token 空间中优化，也不应维护一个覆盖所有游戏的巨大中央枚举。正确做法是：

1. 由当前场景暴露合法行动和社会机会；
2. 由同一人物生成少量 Candidate Intent；
3. 用规则、统计策略、有限搜索或 API 结构化调用选择；
4. 让 API 模型将选定意图实现为语言或 typed tool call；
5. 所有绑定行动再次经过权限、阶段和合法性验证。

“latent”在本文中表示结构化、有限、可版本化的意图层，不要求它来自训练出的神经 embedding。

### 6.2 Public / Private / Action

每次重要激活都要显式区分：

| 层 | 内容 | 权威性 |
| --- | --- | --- |
| Private Intent | Agent 的目标、预测、候选策略和风险 | 主体私有自述/系统结构化记录 |
| Public or Private Message | Agent 对别人说了什么 | 真实发生的通信，但内容不一定为真 |
| Bound Action | Agent 通过 typed command 实际做了什么 | 经过验证后可改变世界 |

“我会合作”不能代替合作命令；“我不会投你”也不能阻止之后合法投票。这种不一致正是承诺、欺骗和信誉机制的输入。

### 6.3 DecisionRecord

当前仓库已有精简 `SocialDecisionRecord` 和信任博弈 `DecisionRecord`。目标版本还需要：

- observation/evidence 引用；
- ActorModel、关系、承诺、欺骗和记忆引用；
- 少量 Candidate Intent；
- 被选意图和选择器版本；
- 预测后果与概率；
- typed action receipt；
- resulting domain/social event；
- outcome reconciliation。

DecisionRecord 是安全决策摘要，不是隐藏思维链。自由文本只能补充说明，不能替代引用。

---

## 7. OpenAI-compatible API 运行模型

### 7.1 一个参与者，一个持续运行主体

每个席位拥有独立：

- character identity；
- actor/seat/role binding；
- model profile；
- session；
- mind；
- memory；
- context compiler 输入；
- API 请求生命周期；
- typed tools。

房间协调器只负责调度、barrier、权限、事件和恢复，不替任何人物选择策略。

### 7.2 Provider-neutral 请求

目标接口只依赖 OpenAI-compatible 能力：

- model ID；
- messages/input；
- tool schema 与 tool choice；
- streaming；
- usage；
- 可选 reasoning effort；
- 可选结构化输出；
- cancellation signal。

不按供应商名称或模型名称写分支。能力差异通过 profile、probe 和 allow-list 表达。

### 7.3 推理强度自动降级

推理强度遵循：

1. 默认优先发送 `xhigh`；
2. provider 明确返回“不支持 `xhigh`”时，立即向用户发出非阻塞降级通知，并使用 `high` 重试；
3. provider 也不支持 `high` 时，再次通知用户并完全省略 reasoning effort，使用 provider 默认推理强度；
4. 不继续自动降到 `medium` 或 `low`，避免制造无法解释的多级策略漂移；
5. 降级成功后房间可以继续运行，不需要用户手工重试；
6. 成功能力结果按 endpoint/model capability scope 缓存；后续请求可以直接使用已知可用级别，但 UI 必须持续显示当前生效级别；
7. 缓存是能力记录，不是供应商或模型名称特判；
8. 与推理强度无关的 400/422、鉴权、限流、超时和服务端错误不得被 fallback 掩盖，必须进入正常失败路径。

用户通知至少包含：

- model profile 和请求对应的 Agent；
- 请求级别与实际降级后的级别；
- provider 返回的脱敏错误码与错误消息；
- 是否已经自动重试、重试是否成功；
- 最终失败时可以采取的操作。

通知不得包含 API key、Authorization header、完整私密 prompt、工具参数中的私密世界状态或原始推理。自动降级是恢复机制，不是静默吞错机制。

当前 `reasoningFallbackFetch()` 只实现了“`xhigh` → 省略”的基础行为，也没有完整的用户可见降级通知。目标实现需要改成“`xhigh` → `high` → provider default”，并且只对明确的 capability error 降级，避免把无关错误误判为不支持。

### 7.4 请求生命周期

并发 permit 必须覆盖真实 provider 请求：

```text
acquire permit
→ start request
→ stream / tool calls
→ completed | provider abort confirmed | terminal failure
→ clear timers
→ release permit
```

本地 `Promise.race` 超时不是 provider 已停止的证明。迟到响应不得重复执行命令；所有命令使用稳定 `commandId`。

### 7.5 失败策略

- API 不可用：激活明确失败，不能伪造台词或认知更新；
- 结构化输出无效：有限次数修复，之后记录失败；
- 未调用必要工具：场景返回可诊断的 no-action/timeout 结果；
- 重复工具调用：command idempotency 返回已有收据；
- 请求取消但 provider 未确认：permit 继续占用或由隔离 worker 持有；
- 上下文超限：按 ContextCompiler 策略压缩，不把摘要伪装成普通 user 消息；
- reasoning level 不支持：按 `xhigh → high → provider default` 自动降级并通知用户，不切换供应商特有参数；
- 自动降级后仍失败：向用户显示脱敏后的最终错误，并将激活标记为失败，不伪造成功输出。

---

## 8. 目标接口

本节全部是**目标设计**，不是当前公开 API。接口名称表达需要稳定持久化和评测的对象；实现时应放入社会因果或评测域，而不是继续扩大单一中央联合类型。

### 8.1 StrategyProfileSnapshot

```ts
interface StrategyProfileSnapshot {
  strategyProfileId: string;
  modelProfileId: string;
  promptPolicyVersion: string;
  personaVersion: string;
  contextPolicyVersion: string;
  toolSchemaVersion: string;
  selectorPolicyVersion: string;
  reasoningPolicy: {
    preferred: "xhigh";
    fallbackOrder: ["high", "provider-default"];
    notifyOnDowngrade: true;
  };
  tuning: Record<string, number | string | boolean>;
  contentHash: string;
  createdAt: string;
  schemaVersion: number;
}
```

它是不可变的运行配置快照。它不包含模型权重，也不保存 API key。

需要区分：

- `RoomCheckpoint`：用于恢复世界、密封行动和社会历史；
- `StrategyProfileSnapshot`：用于复现实验中的 Agent 策略配置；
- 远程模型版本：只能记录 API 返回或配置声明的标识，不能假设供应商权重永远不变。

### 8.2 CandidateIntent

```ts
interface CandidateIntent {
  intentId: string;
  strategyKey: string;
  summary: string;
  targetCharacterIds: string[];
  propositionIds: string[];
  compatibleActionKeys: string[];
  predictedConsequences: Array<{
    propositionId?: string;
    summary: string;
    probability: number;
    horizon: "immediate" | "round" | "game" | "future-game";
  }>;
  expectedUtility?: number;
  exposureRisk?: number;
  relationshipRisk?: number;
  provenance: Provenance;
}
```

`strategyKey` 是内部、版本化的策略标签，不是面向第三方的游戏 DSL。

### 8.3 StrategySelection

```ts
interface StrategySelection {
  selectionId: string;
  decisionId: string;
  strategyProfileId: string;
  candidateIntentIds: string[];
  selectedIntentId: string;
  distribution?: Array<{ intentId: string; probability: number }>;
  method: "policy" | "cfr" | "psro" | "mcts" | "api-structured";
  observationRefs: string[];
  evidenceRefs: string[];
  actorModelIds: string[];
  logicalTime: number;
  schemaVersion: number;
}
```

该对象只记录有限、可公开裁剪的选择依据，不记录逐 token 思考。

### 8.4 OpponentPoolEntry

```ts
interface OpponentPoolEntry {
  entryId: string;
  strategyProfileId: string;
  status: "baseline" | "candidate" | "frozen";
  supportedScenarioIds: string[];
  modelFamilyLabel?: string;
  addedAt: string;
  provenance: Provenance;
  schemaVersion: number;
}
```

`modelFamilyLabel` 仅用于评测分层，不得驱动 provider 特判。

### 8.5 CrossPlayEvaluation

```ts
interface CrossPlayEvaluation {
  evaluationId: string;
  scenarioId: string;
  strategyProfileIds: string[];
  opponentPoolVersion: string;
  runs: Array<{
    runId: string;
    seatBindings: Record<string, string>;
    roleBindings: Record<string, string>;
    worldSeed?: string;
    effectiveReasoningEffort?: "xhigh" | "high" | "provider-default";
    downgradeEventIds: string[];
    payoff: Record<string, number>;
    archiveRef: string;
  }>;
  aggregate: {
    payoffMatrix: number[][];
    confidenceIntervals: number[][];
    seatAdjustedScores: Record<string, number>;
  };
  createdAt: string;
  schemaVersion: number;
}
```

### 8.6 OutcomeReconciliation

```ts
interface OutcomeReconciliation {
  reconciliationId: string;
  decisionId: string;
  actionReceiptIds: string[];
  resultingEventIds: string[];
  predictions: Array<{
    summary: string;
    probability: number;
    outcome: "supported" | "contradicted" | "unresolved";
  }>;
  commitmentSettlementIds: string[];
  deceptionSettlementIds: string[];
  relationshipDeltaIds: string[];
  influenceIds: string[];
  memoryCandidates: Array<{
    summary: string;
    sourceIds: string[];
    salience: number;
  }>;
  completedAtLogical: number;
  schemaVersion: number;
}
```

`memoryCandidates` 仍需 MemoryWritePolicy 审批，不能自动进入长期记忆。

---

## 9. 不更新权重的策略选择与搜索

### 9.1 基线策略选择器

最先实现的选择器不需要复杂博弈算法：

1. 过滤当前不可执行的意图；
2. 根据 active goals、关系、承诺、风险和人物偏好打分；
3. 对高风险候选要求证据引用；
4. 保留少量随机性，避免所有人物使用同一套路；
5. 输出概率分布和选择记录；
6. 由 API 模型实现语言，由世界验证行动。

这已经能比“统一 prompt 要求经常欺骗”更可靠地制造人物差异。

### 9.2 CFR

Counterfactual Regret Minimization 适用于可枚举的小型抽象子博弈，例如：

- 本轮合作/不合作；
- 公开承诺/保持沉默；
- 有限出价区间；
- 狼人杀某个简化投票子局；
- 信任博弈的有限投资与返还档位。

CFR 的输出是候选意图或 typed action 的概率分布。它不直接生成语言，不读取当前人物无权看到的世界真相，也不更新 API 模型。

完整自然语言社会世界不能被错误宣称为“已由 CFR 求得均衡”。抽象映射、信息集和误差都必须记录。

### 9.3 PSRO

Policy-Space Response Oracles 在本项目中的含义是**配置空间的种群评测与元策略选择**：

```text
冻结 StrategyProfileSnapshot 池
→ 运行多座位、多角色 cross-play
→ 建立 payoff matrix
→ 计算 meta-strategy
→ 搜索新的 prompt/context/selector/persona 配置
→ 作为 candidate 加入
→ 通过冻结池验证后晋升
```

这里的 response oracle 可以是：

- 人工提出的新策略配置；
- 网格或贝叶斯配置搜索；
- API 模型提出、由评测器验证的候选策略；
- CFR 或规则选择器产生的候选；
- 针对当前种群的有限 MCTS 策略。

它不是模型权重训练。

### 9.4 MCTS 与有限 rollout

MCTS 可以用于单次决策时的有限搜索：

1. 从当前 Agent 的 Authorized Observation 建立信息集；
2. 对隐藏状态按该 Agent 的 BeliefState 采样；
3. 对对手按冻结策略配置或 ActorModel 采样；
4. 在世界副本中执行合法 typed action；
5. 使用确定性结算和有限 horizon utility；
6. 汇总到 Candidate Intent 分布。

硬约束：

- rollout 不得读取真实隐藏状态作为当前 Agent 的输入；
- 世界副本不能写入真实房间；
- rollout 消息不能进入规范历史；
- API rollout 有明确调用预算、并发预算和缓存策略；
- 近似价值只能标成估计，不能冒充因果事实；
- 搜索失败时回到基线选择器，而不是绕过合法性验证。

### 9.5 “均衡”与“利用”

面对未知对手时，meta-strategy 应偏向冻结池中稳定、低可利用的配置。积累足够 ActorModel 证据后，可以提高针对性策略权重：

\[
\pi_t
=
(1-\alpha_t)\pi_{\mathrm{robust}}
+
\alpha_t\pi_{\mathrm{exploit}}
\]

\[
\alpha_t
=
f(
\text{opponent evidence},
\text{model confidence},
\text{estimated regret},
\text{relationship risk}
)
\]

这只是策略混合，不是把策略蒸馏进模型。证据不足时必须降低 \(\alpha_t\)。

---

## 10. 推荐运行时架构

```text
┌────────────────────────────────────────────┐
│ Deterministic World                        │
│ rules · phases · sealed commands · replay  │
└───────────────────┬────────────────────────┘
                    │ positive projection
                    ▼
┌────────────────────────────────────────────┐
│ Authorized Observation                    │
│ public facts · private facts · legal tools │
└───────────────────┬────────────────────────┘
                    ▼
┌────────────────────────────────────────────┐
│ Social Causality Spine                     │
│ proposition · evidence · belief · actor    │
│ model · commitment · deception · relation  │
└───────────────────┬────────────────────────┘
                    ▼
┌────────────────────────────────────────────┐
│ One Persistent Agent                      │
│ goals · memory · candidate intents         │
│ response prediction · decision record      │
└───────────────────┬────────────────────────┘
                    ▼
┌────────────────────────────────────────────┐
│ Strategy Selector                         │
│ baseline policy · CFR · PSRO · MCTS        │
└───────────────────┬────────────────────────┘
                    ▼
┌────────────────────────────────────────────┐
│ OpenAI-compatible API                     │
│ language realization · structured tools    │
└───────────────────┬────────────────────────┘
                    ▼
┌────────────────────────────────────────────┐
│ Command Gateway                           │
│ auth · phase · legality · idempotency      │
└───────────────────┬────────────────────────┘
                    ▼
┌────────────────────────────────────────────┐
│ Domain + Social Events                    │
│ result · reconciliation · future context   │
└────────────────────────────────────────────┘
```

### 10.1 写入权

| 状态 | 唯一写入者 |
| --- | --- |
| 权威世界 | Domain reducer |
| 命令收据 | Command gateway/world |
| Proposition/Evidence | Social causality service |
| Belief/ActorModel | 每名 Agent 自己的认知服务 |
| Commitment/Deception | 专用生命周期服务 |
| Relationship | 每名关系源人物自己的有向状态服务 |
| Long-term memory | MemoryWritePolicy |
| 镜头与标题 | Presentation/director |

UI、导演、评测器和模型自由文本都不能成为世界写入者。

### 10.2 事件流

至少逻辑分为：

- DomainEvent：权威、确定性、可重放；
- SocialCausalityEvent：引用消息、观察或 DomainEvent 的社会语义；
- AgentTraceEvent：请求、工具、延迟、usage 和安全摘要；
- PresentationEvent：镜头、动画、标题和布局。

PresentationEvent 永远不能驱动前三类状态。

---

## 11. 异构 API 配置池与 Cross-play

### 11.1 配置池组成

推荐 population：

- 当前候选 StrategyProfileSnapshot；
- 历史冻结策略配置；
- 不同模型 profile；
- 不同人物与风险偏好；
- 中性规则基线；
- CFR 抽象策略；
- MCTS 有限搜索策略；
- 保留不参与策略搜索的冻结对手池。

异构的目的是减少模型方言、镜像自洽和循环克制，不是针对每个模型写适配代码。

### 11.2 公平比较

每个 cross-play 批次至少平衡：

- 场景；
- 座位；
- 隐藏角色；
- 首发顺序；
- 人物；
- 对手组合；
- reasoning capability；
- API 超时和失败；
- 世界随机种子（适用时）。

远程 API 可能漂移，因此必须保存：

- model profile ID；
- provider-neutral model ID；
- StrategyProfileSnapshot hash；
- prompt/context/tool schema version；
- 运行时间；
- usage、延迟、失败类型；
- 完整规范归档引用。

不能假设同一 model ID 在几个月后仍对应完全相同权重。

### 11.3 Frozen Opponent Pool

冻结池：

- 不参与候选配置搜索；
- 版本化并不可变；
- 包含简单诚实、合作、机会主义、随机和稳健基线；
- 包含多个 API 模型配置；
- 定期扩展，但旧版本不原地修改；
- 结果按 seat、role 和 scenario 分层。

新策略只有在冻结池、cross-play 和安全指标上同时改善，才可晋升。

---

## 12. API-first Social Truth Lab

Social Truth Lab 是开发侧评测能力，不是用户产品首页。它使用真实 API 模型运行可复现批次，同时用确定性世界和结构化社会账本提供证据。

### 12.1 基础设施指标

- API 成功率、超时率和取消完成时间；
- tool-call 合法率；
- command 重复与幂等命中；
- token、成本与墙钟延迟；
- barrier 等待时间；
- checkpoint 成功率；
- replay hash 一致性；
- public/private projection 泄漏数；
- context pressure 与压缩次数。

### 12.2 信念质量

对有可解析真值的命题计算：

\[
\operatorname{Brier}
=
\frac{1}{N}\sum_{n=1}^{N}(p_n-y_n)^2
\]

以及：

- log loss；
- Expected Calibration Error；
- 证据到达前后的更新方向；
- 反证到达后的修正速度；
- probability 与 confidence 的区分；
- 不同角色、座位和场景的校准曲线。

主观命题和未来条件命题不能强行赋予客观真值。

### 12.3 社会因果完整度

- 高影响 belief update 的 evidence coverage；
- DecisionRecord 的 observation/evidence coverage；
- commitment settlement 的 source coverage；
- deception 各生命周期阶段的证据覆盖；
- relationship delta 的 causation coverage；
- memory record 的 source coverage；
- Presentation 标签误报率。

### 12.4 欺骗指标

分别评估：

- 计划、尝试、接收、相信、行为有效、识破和修复数量；
- direct lie、omission、misdirection、selective truth、false implication、feigned commitment；
- 欺骗识别 precision/recall；
- 诚实错误被误标为欺骗的比例；
- 未承诺行动被误标为违约的比例；
- 仅身份揭晓被误标为具体谎言揭穿的比例。

这些是诊断指标，不是奖励模型。

### 12.5 Cross-play 与稳健性

收益矩阵：

\[
M_{ij}^{s,r,k}
=
\mathbb{E}
\left[
U_i
\mid
\pi_i,\pi_j,\text{scenario}=s,\text{role}=r,\text{seat}=k
\right]
\]

报告：

- 分场景、角色、座位收益；
- bootstrap 置信区间；
- 循环克制；
- 冻结池相对收益；
- 配置成本归一化收益；
- 近似 exploitability；
- 模型或 prompt 变化后的退化。

完整 Society 世界通常无法精确求 exploitability，只能把多个受限 best-response 配置的最高收益报告为近似指标，不能称为严格下界或 Nash 证明。

### 12.6 反事实与消融

建议的反事实：

- 删除某条消息后重复对手决策；
- 替换社会意图但保持世界观察一致；
- 移除 commitment 引用；
- 移除 ActorModel；
- 隐去长期记忆；
- 将有向关系恢复到中性；
- 使用同一模型但替换 StrategyProfileSnapshot。

远程 API 具有随机性。反事实必须：

- 多次采样；
- 记录相同 observation 和配置；
- 报告效应分布与置信区间；
- 将 `agent-cited`、`temporal-association`、`observer-inferred` 与真正可控重放分开。

没有干预证据时只说“可能影响”，不说“导致”。

### 12.7 真实 API 运行纪律

- 显式 opt-in；
- 调用和费用上限；
- 记录模型与策略配置；
- 密钥只从安全配置读取；
- 不把真实调用作为确定性 CI 的唯一证明；
- 不用一局随机对战作稳定断言；
- 不保存原始 chain-of-thought；
- 失败样本不静默从统计中删除。

---

## 13. 与 `AGENTS.md` 对齐的工程路线

### Phase 0：关闭当前可信度缺口

优先完成：

- public archive 正向投影，清除 `world.details` 等私密状态；
- 删除 query token；
- participant、owner、operator 权限彻底分离；
- archive 写入失败可观测且可恢复；
- 停止把每个 `finalOutput` 自动写入长期记忆；
- 将 `agent.reasoning` 收口为明确的 reasoning-summary 语义；
- 修复 lint、unit、security 门禁，使 CI 全绿。

退出标准：安全、恢复、权限和推理隐私没有已知 P0 失败。

### Phase 1：完成最小社会因果纵向切片

以信任博弈为第一切片，补齐：

```text
message
→ social act
→ proposition/evidence
→ belief update
→ decision record
→ typed action
→ domain result
→ outcome reconciliation
→ relationship/memory candidate
```

然后接入囚徒困境和狼人杀。新增 ActorModel、InfluenceLink、OutcomeReconciliation，并为每个对象建立单写入者和 viewer projection。

### Phase 2：完成欺骗与承诺闭环

- 欺骗计划保持可选；
- 记录按受众接收；
- 建立相信与反证；
- 追踪行为有效、维护、矛盾、识破和修复；
- 将承诺、欺骗、关系和记忆后果带入未来 context；
- 所有展示标签引用规范对象。

### Phase 3：引入版本化运行时策略层

- StrategyProfileSnapshot；
- Candidate Intent schema；
- 基线 selector；
- DecisionRecord 完整化；
- response prediction；
- `xhigh → high → provider default` capability policy 与用户可见降级通知；
- 失败、取消、迟到和幂等处理。

先用简单规则和 API structured selection，不能因算法尚未接入而阻塞社会因果主线。

### Phase 4：引入有限 CFR/PSRO/MCTS

- 在信任、囚徒困境、谈判等可抽象场景验证 CFR；
- 建立冻结配置池和 cross-play matrix；
- 用 PSRO 选择 meta-strategy 和候选配置；
- 用 MCTS 处理少量高价值决策；
- 所有搜索受 observation、预算和 typed command 约束。

### Phase 5：建立 Social Truth Lab

- Brier、ECE、log loss；
- 社会因果 coverage；
- 欺骗误报/漏报；
- seat/role/scenario 分层 cross-play；
- 冻结对手池；
- 反事实与消融；
- 成本、延迟和失败率。

### Phase 6：重做 Social Observer

用户界面优先展示：

- Public / Private / Action；
- Belief Timeline；
- Commitment Ledger；
- Deception Lifecycle；
- Directed Relationship Graph；
- Influence Chain；
- Agent POV Replay；
- 来源、置信度和权限标签。

三栏布局继续作为基础，避免整个页面纵向滚动；导演只选择镜头，不生成社会事实。

### Phase 7：扩展到全部精选场景

所有 13 个场景都应接入统一来源、策略快照和评测接口，但成熟度按社会研究价值推进：

1. 信任博弈；
2. 囚徒困境；
3. 狼人杀；
4. 谈判；
5. 公共品；
6. 阿瓦隆；
7. 其余精选场景。

这里的优先级不是放弃其他场景，而是防止“每个场景都有浅层标签、没有任何场景形成可信闭环”。

---

## 14. 常见失败模式

### 14.1 把目标设计写成当前事实

类型存在不等于生命周期完成，UI 有字段不等于因果链成立，单局看起来合理不等于系统可验证。

### 14.2 用统一 prompt 制造多疑和背叛

中性协议 prompt 只规定身份、边界、工具和记录要求。行为差异必须来自人物、信息、关系、经历、风险和目标冲突。

### 14.3 从台词解析绑定行动

自然语言是可欺骗层。投票、出价、投资、返还和目标选择必须使用 typed command。

### 14.4 用结果反推社会语义

零返还、低贡献、单边不合作、交易成功和身份揭晓都不足以单独证明背叛、违约、联盟或欺骗揭穿。

### 14.5 用模型自述冒充事实

`log_deception_plan`、belief self-report 和 DecisionRecord 都是主体报告。它们需要来源，并与世界事实和系统推断分层。

### 14.6 把长推理当作可观测性

原始 CoT 既不安全也不可作为稳定接口。应展示有限 ThoughtBeat、证据、候选意图和结果对账。

### 14.7 在真实隐藏状态上做搜索

如果 rollout 使用了 Agent 本不应知道的角色或私密数值，它得到的是作弊策略，不是信息集策略。

### 14.8 把 API 失败当作沉默或策略选择

沉默必须是 Agent 的合法意图。超时、取消、解析失败和 provider 错误必须作为运行失败单独记录。

### 14.9 用同一模型镜像对局证明泛化

必须使用异构配置、冻结池、座位轮换和 cross-play，防止模型方言和循环克制。

### 14.10 把配置搜索叫作模型训练

本文中的策略探索只改变 prompt、persona、context、selector 或采样配置，不修改远程模型权重。

### 14.11 针对供应商堆特判

能力探测和 profile allow-list 可以存在；`if provider === ...` 或 `if model.includes(...)` 不应进入核心策略和社会因果代码。

### 14.12 让导演修复逻辑

导演不能把“高返还”改名为“守约”，也不能为了戏剧性安排谁撒谎。它只能高亮已经有证据的规范事件。

---

## 15. 最小可行闭环与完成标准

### 15.1 最小可行闭环

第一版 API 策略系统应只在信任博弈形成完整闭环：

1. 正向 Authorized Observation；
2. Proposition、Evidence 和 Belief；
3. 至少一个 ActorModel；
4. 4–8 个 Candidate Intent；
5. 基线 Strategy Selector；
6. OpenAI-compatible API 语言实现；
7. typed investment/return command；
8. commitment 与 deception 生命周期；
9. OutcomeReconciliation；
10. 有来源的关系与记忆写入；
11. StrategyProfileSnapshot；
12. public、POV、operator 三种投影；
13. 真实 API 对局归档；
14. 冻结配置 cross-play。

### 15.2 工程完成标准

一个阶段只有同时满足以下条件才完成：

- 当前/目标状态文档没有混写；
- 权威世界只由 typed command 改变；
- 所有私密字段使用正向投影；
- 同时行动密封且恢复后不泄漏；
- 关键对象有稳定 ID、逻辑时间、schema 和 provenance；
- DecisionRecord 可引用真实 observation/evidence；
- OutcomeReconciliation 引用实际结果；
- memory 由 policy 写入，不由 `finalOutput` 自动写入；
- 欺骗、承诺和关系标签符合语义门槛；
- API 调用使用 provider-neutral profile；
- 推理强度按 `xhigh → high → provider default` 自动降级，每次降级和最终错误均向用户提供脱敏通知；
- 不存储原始 chain-of-thought；
- deterministic gates 全绿；
- 真实 API 评测显式 opt-in、受预算约束并保存配置；
- UI 能让观众区分事实、自述、推断和展示标签。

### 15.3 不足以证明完成的材料

- 一张漂亮截图；
- 一局精彩狼人杀；
- 一段模型说“我欺骗成功了”的文本；
- 一个存在但没有结算逻辑的 TypeScript interface；
- 新策略与自己对战的胜率；
- typecheck 和 build；
- 没有 source refs 的关系图；
- 没有置信区间的反事实单样本。

---

## 16. 研究参考与使用方式

以下工作只提供设计启发。它们不代表当前仓库已经实现相应算法，也不意味着 Society 应复制其训练流程。

### 16.1 欺骗定义

- [Honesty Is the Best Policy: Defining and Mitigating AI Deception](https://arxiv.org/abs/2312.01350)

启发：区分错误输出与具有目标、信息优势和诱导效果的欺骗。

### 16.2 不完全信息搜索

- [ReBeL: Combining Deep Reinforcement Learning and Search for Imperfect-Information Games](https://arxiv.org/abs/2007.13544)
- [DeepStack: Expert-Level Artificial Intelligence in No-Limit Poker](https://arxiv.org/abs/1701.01724)

启发：使用公共信念、信息集和受限搜索；Society 只借鉴运行时表示与搜索约束，不采用权重训练路线。

### 16.3 CFR 与 PSRO

- [Regret Minimization in Games with Incomplete Information](https://proceedings.neurips.cc/paper/2007/hash/08d98638c6fcd194a4b1e6992063e944-Abstract.html)
- [A Unified Game-Theoretic Approach to Multiagent Reinforcement Learning](https://arxiv.org/abs/1711.00832)

启发：在有限抽象博弈中计算策略分布，并通过种群收益矩阵选择 meta-strategy。

### 16.4 语言策略与狼人杀环境

- [Learning Strategic Language Agents in the Werewolf Game with Iterative Latent Space Policy Optimization](https://arxiv.org/abs/2502.04686)
- [Werewolf Arena](https://arxiv.org/abs/2407.13943)

启发：把无限语言表面形式映射到较小策略空间，并使用异构对手评测。本文不采用其模型优化步骤。

### 16.5 概率校准

- [On Calibration of Modern Neural Networks](https://proceedings.mlr.press/v70/guo17a.html)

启发：准确率不能替代概率校准；BeliefState 应同时报告 Brier、ECE 和分层曲线。

### 16.6 对手建模

- [Efficient Adaptation in Mixed-Motive Environments via Hierarchical Opponent Modeling and Planning](https://proceedings.mlr.press/v235/huang24p.html)

启发：把对手类型置信度和规划分开。Society 的 ActorModel 必须保持主观、有来源且受 viewer 权限约束。

研究条目进入正式实现决策前，还必须回答：

1. 它是否需要训练权重；
2. 它是否假设可访问全局隐藏状态；
3. 它的 action space 能否映射到 typed command；
4. 它的评测是否能在远程 API 漂移下复现；
5. 它是否违反一名参与者一个持续主体；
6. 它是否能保留 provenance、权限和恢复语义。

---

## 结论

Society 的前沿不在于把模型训练成统一的阴谋家，而在于建立一套可信运行时：

```text
独立 API Agent
+ 有限合法视角
+ 稳定人物身份
+ 可追溯命题与证据
+ 主观信念与 ActorModel
+ 有限候选意图
+ 可版本化策略选择
+ typed command 与确定性世界
+ 可结算的承诺和欺骗
+ OutcomeReconciliation
+ 有来源的关系与记忆
+ cross-play、校准与反事实评测
```

CFR、PSRO 和 MCTS 可以提升策略选择与评测质量，但它们不能替代社会因果主干，也不能绕过权限和世界规则。OpenAI-compatible API 模型可以提供强大的语言理解与策略生成能力，但“真实 social”最终取决于系统是否能证明：

> 谁看见了什么，基于什么改变了信念，为什么选择某个意图，实际做了什么，影响了谁，世界如何结算，以及这段经历怎样改变了未来。

如果这些问题没有来源化答案，就不能仅凭台词精彩、界面漂亮或一局胜率宣称完成了社会欺骗 Agent。
