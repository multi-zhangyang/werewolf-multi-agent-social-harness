# AGENTS.md — Society 工程章程（API-only 务实版）

> 本文件适用于仓库根目录及其全部子目录。
>
> 审查基线：`main @ e466d00`，2026-08-22。
>
> 本章程**替代** 2026-08-18 版章程与已删除的 `game_agent_deception_strategy_frontier.md`（原文见 git 历史），是唯一的工程合同。旧版中不可实现或不可测量的内容已删除，仍然有效的工程约束已并入本文。

---

## 0. 硬约束：只调用 API，不训练模型

这是本项目的第一性约束。所有设计以此为前提推导，凡与它冲突的设想一律不进入路线图。

### 0.1 这条约束直接推掉什么

- **不能校准模型内部状态。** 模型自报的概率、情绪数值、信念置信度是 prompt 服从性的产物，不是可校准的心理状态。对它们计算 Brier / ECE / log loss、"校准曲线"是伪测量，禁止作为指标或验收标准。
- **不能验证"对方信了没有"。** "欺骗被相信（believed）"、"读心（ActorModel）准确性"、多阶 ToM（"我认为对方如何看我"）都无法获得真值，只能保留为带来源标签的自述数据，不得进入测量。
- **不能做需要大规模对局矩阵的结论。** cross-play 收益矩阵、exploitability、"均衡策略"需要 N 配置 × M 对手 × K 座位 × 多 seed 的真实调用矩阵，费用与研究成本都不属于本产品。CFR / PSRO / MCTS 策略搜索**全部不做**（见第十三部分不做清单）。
- **不能宣称长期人格演化。** 不训练模型就没有可控纵向实验。"人物成长"只能是跨局 dossier 带来的叙事连续性，不得作为可测工程目标。

### 0.2 我们能测量什么：三类硬数据

全部测量对象必须落在这三类之内，否则只能作为叙事展示（§0.3）：

| 类别 | 内容 | 数据来源 | 性质 |
|---|---|---|---|
| **工具合规** | valid action rate、必要行动完成率、超时/迟到/重复提交率、降级次数 | provider 响应与 command gateway 统计 | 纯统计，完全可测 |
| **承诺↔世界结果对账** | typed commitment 与结算行动的确定性比对；promise-kept / promise-broken 误报率（有承诺记录才允许发强标签） | 世界真相 + 承诺记录 | 确定性规则，完全可测 |
| **标注抽检精度** | 消息旁路提取的承诺/指控/结盟提议是否属实；story beat 强标签证据门槛违规 | 小样本人工核对（每局 10 条） | 抽检，可信度以样本量标注 |

### 0.3 其余一切都是带来源的叙事

自报信念、关系数值、欺骗计划、情绪——这些保留在系统里，因为它们驱动人物一致性和观战叙事，但必须满足：

- 每条数据带 `provenance`（agent-self-report / system-inference / message-claim / world-fact）；
- UI 一致标注来源，观众能区分"事实"与"角色自述"；
- **永远不作为验收指标、质量门或效果证明使用**。

### 0.4 规则优先级

冲突时按以下顺序执行：

1. 用户安全、隐私、数据边界和不可逆操作保护；
2. 本文件"不可破坏不变量"（第二部分）；
3. 世界规则和社会因果的正确性；
4. 可恢复性、可重放性和测试；
5. Agent 行为质量；
6. 观战表现与视觉体验；
7. 性能与代码整洁；
8. 新场景、新功能数量。

### 0.5 当前事实与目标状态必须分开

文档、注释、PR 和提交信息必须区分：**已实现并验证** / **存在但未充分验证** / **目标设计**。禁止把目标状态写成当前事实。

### 0.6 对 Coding Agent 的基本要求

修改代码前必须：阅读真实源码（不是只看文档）；说明改动触碰哪条社会因果链；说明哪些信息属于世界真相、谁可见；说明状态由谁写入、如何持久化与恢复；为确定性基础设施补充测试；不以"模型大概会处理"为正确性依据；不以一局精彩对局证明功能正确。

---

# 第一部分：项目身份

## 1. Society 是什么

Society 是一个面向观众的、可观察的多 Agent 社会世界。多个持续存在、信息受限的 Agent 在利益冲突、承诺、声誉和重复互动中自主形成合作、怀疑、试探、说服、承诺、欺骗、联盟、背叛、报复与宽恕。

产品核心不是"玩了多少种游戏"，而是让观众能理解：**一个 Agent 看到了什么、声称了什么、实际做了什么、世界结算了什么、后果如何进入下一次互动。**

## 2. 游戏在本项目中的位置

13 个精选场景（狼人杀、阿瓦隆、信任博弈、囚徒困境、谈判、公共品、最后通牒、蜈蚣、胆小鬼、猎鹿、选美、密封拍卖、吹牛骰）是**社会压力场景**，负责提供私有信息、冲突目标、承诺机会、欺骗收益与可验证结果。游戏规则服务于社会行为，不是产品本体。

## 3. 非目标

- 通用游戏平台 / 第三方插件市场 / 桌游规则 DSL / 为无限玩法设计的抽象层；
- 论文式实验平台作为产品主界面（开发侧仅有 §38 的轻量 smoke 门禁）；
- 策略搜索研究（CFR/PSRO/MCTS/cross-play/meta-strategy）；
- 信念校准、读心准确率等"心理状态测量"科学；
- Agent POV 历史回放产品功能（产品决策：不做回放 UI）；
- 追求所有模型最大化胜率、把 Agent 调成统一理性博弈机器人；
- 把每局导演成高潮不断的戏剧。

---

# 第二部分：不可破坏不变量

全部可由代码执行或审计。违反任何一条即为 P0 缺陷。

## 4. 主体不变量

- **一名参与者，一个持续主体。** 观察信念、关系、发言、行动、结果学习都属于同一主体。禁止把人物拆成会独立行动、独立承担社会身份的子 Agent（manager/planner/critic 委员会）。内部可以有确定性服务和结构化抽取阶段，但它们不拥有社会身份。
- **不允许中央战略控制器。** 房间协调器、导演、调度器不得：决定 Agent 应该相信谁、指定谁撒谎、修改发言、替 Agent 选择行动、注入越权信息、为场面精彩制造冲突。

## 5. 世界与行动不变量

- **只有合法命令可以改变权威世界。** 自然语言、ThoughtBeat、导演事件都不能。绑定行动必须走 `Typed Tool → Authorization + Phase + Legality → Domain Event → Deterministic Transition`。禁止从台词用正则推导绑定行动。
- **同时行动必须密封。** 未公开选择不可见、执行顺序不泄策略、barrier 满足后统一结算、重试不重复提交、恢复后保留已提交未结算的密封行动。
- **命令幂等。** 每个绑定命令有稳定 commandId；重复发送、迟到响应、恢复重放不得重复改变世界。

## 6. 信息边界不变量

- **所有观察通过正向投影产生**：`observe(worldState, viewerContext)`，白名单式列出可见字段。禁止"复制全状态再删私密字段"。新增私密状态默认不可见。
- **默认观察者是 public。** 全知、Agent POV、法证归档要求明确权限（owner/operator）。
- **不同信息层不得混用。** 世界真相 / 授权观察 / 主张 / 自述 / 系统推断 / 展示标签，任何层不得无来源冒充另一层。
- **私聊、心智、欺骗计划、关系是高敏感数据**，不得进入 public viewer、错误消息、URL 或日志。

## 7. 社会语义不变量

- **不合作 ≠ 背叛；成交 ≠ 联盟；身份揭晓 ≠ 谎言被识破。** 强标签（betrayal / promise-kept / promise-broken / deception-exposed / alliance）必须引用可查的承诺记录、欺骗记录或证据链，不得由数值阈值或世界结果启发式生成。无承诺时只用中性标签（cooperative-outcome / low-return / free-riding / agreement-reached / negotiation-failed / unilateral-defection）。
- **消息是主张不是事实。** 他人发言进入上下文时必须是"某人声称 X"，除非世界规则使其成为已验证事实。

## 8. 连续性不变量

- **赛季连续性来自 SDK Session。** 赛季模式下同一角色的持久会话跨局复用，模型凭自身上下文记得既往对局；**不做任何自建记忆系统**——没有检索、没有相关性评分、没有记忆写入策略、没有记忆归档。
- **人物身份绑定永久 `CharacterId`**，不绑定显示名、座位、`agent-XX` 临时编号、模型名或游戏角色。显示名可改、同名可共存、换座不转移关系、模型切换不创建新人物。
- **重启不改社会历史。** 消息、回复关系、已提交行动、承诺、欺骗、关系变化、逻辑顺序在 checkpoint 恢复后必须一致。

## 9. 观战与导演不变量

- 导演只负责镜头、节奏、高亮已发生的社会转折、带来源的安全摘要。不得改变世界、改变心智、注入社会行为、把推断显示为事实。
- provider reasoning 仅实时展示（全知席或本人 POV），默认折叠，不进入持久化、回放或归档。

---

# 第三部分：认识论分层与证据等级

## 10. 六层数据

1. **World Truth**——世界引擎权威事实（角色、投资额、保底值、结算结果）；
2. **Authorized Observation**——某 Agent 某时刻合法观察到的内容；
3. **Communicated Claim**——参与者公开/私下提出的主张（含旁路提取的社会行为，标注 `model-extracted` + 置信度）；
4. **Agent Self-report**——Agent 通过认知工具提交的信念、情绪、关系、欺骗计划。**有价值的人物一致性数据，但不是可验证心理状态**；
5. **System Inference**——系统根据数据的后验推断，必须带来源和"推断"标记；
6. **Presentation**——导演与 UI 的展示标签，永远不能反向成为社会事实。

## 11. 证据等级标签（用于欺骗与社会语义）

欺骗生命周期的每个阶段按可查证据分级：

- **attempted / received / detected / repaired**：可由消息引用、世界揭示、矛盾证据定义——**强证据**，可作为结算依据；
- **believed / behaviorally-effective**：只能由受众自报 + 后续行为一致性共同支撑——**弱证据**，UI 必须标"弱证据"，不得用于强标签或指标；
- 没有某阶段证据时如实显示"未证实"，禁止自动补全。

## 12. 来源标记

所有可展示的关键对象至少含 `Provenance { sourceKind, sourceIds, createdAtLogical }`，观战 UI 用一致视觉语言显示来源类别。

---

# 第四部分：Agent 运行

## 13. Agent 是持续主体，不是一次模型调用

每个席位：characterId、actorId、sessionId、modelBinding、identity、mind。连续性来自稳定身份、累积自述状态、有方向的关系、未结算承诺、公开口径维护、可追溯经历——不来自每回合重复 persona。

## 14. 认知循环（同一主体内的阶段，不是子 Agent）

`Perceive → Normalize → Distinguish(事实/主张/推断) → Update Beliefs(自报) → Update Relationships → Resolve Goals → Generate Candidate Intents → Select Intent → Execute(发言/私聊/沉默/工具) → Reconcile → Learn`。

每步可由确定性 TS、小型抽取调用或同会话结构化调用实现，但必须：属同一人物、不越权观察、中间产物有 schema、失败可降级但不伪造成功、只有绑定工具改变世界。

## 15. DecisionRecord：决策摘要，不是心智测量

每次重要行动生成可持久化结构化记录：observationRefs、evidenceRefs、relevantBeliefIds、openCommitmentIds、candidateIntents、selectedIntent、actionReceiptIds、resultingEventIds、outcomeAssessment。它引用实际观察与事件，是审计链路，不是 chain-of-thought，也不得用于"决策质量"评分。

## 16. 基线策略选择器（唯一的策略层）

意图选择只用规则打分：过滤不可执行候选 → 按 active goals、关系、承诺、风险、人物偏好打分 → 高风险候选要求证据引用 → 保留少量随机性 → 输出选择记录。语言由模型实现，行动由世界验证。**不做 CFR/PSRO/MCTS/搜索**（第十三部分不做清单）。

## 17. Prompt 纪律

统一系统 prompt 只规定：身份连续性、信息边界、工具协议、规则遵守、不伪造观察、不用文本代替行动、按需记录结构化认知。**不得**统一要求所有人物：视承诺为 cheap talk、优先背叛、默认不合作、经常欺骗。欺骗由目标冲突 + 私有信息 + 收益 + 被识破风险 + 人物价值观 + 关系 + 历史自然产生，不同人物允许稳定差异（诚实/含糊/机会主义/忠诚/报复/宽恕）。

---

# 第五部分：社会因果主干

## 18. 对象与单写入者

| 状态 | 唯一写入者 |
|---|---|
| WorldState | 场景 reducer / command gateway |
| Proposition / Evidence / SocialAct | SocialCausalityLedger（含旁路提取） |
| Belief / ActorModel（自报） | 各 Agent 自己的认知工具，经 ledger 单点落账 |
| Commitment | 场景 typed 承诺工具 → ledger |
| DeceptionEpisode | 欺骗计划工具 + 消息执行引用 + 矛盾/揭示证据 |
| Relationship | 各 Agent 有向自报，从结算记录派生 |
| Session history | SessionStore |
| Presentation | 导演/投影 |

模型、UI、导演只能提交 proposal 或消费 projection，不得绕过写入者直接覆盖 canonical state。mind 的信念/关系副本必须从 ledger 结算记录派生（单一写入点），不得独立重算。

## 19. 消息旁路提取（已实现）

每条持久化讨论消息异步做一次结构化抽取（全局默认模型、low 推理强度、独立短超时客户端、严格串行队列、按 messageId 幂等）。产出 SocialAct（promise/offer/acceptance/rejection/accusation/threat/alliance-proposal 等），带置信度，标 `model-extracted`。规则：

- 原文不可变，提取是对消息的解释；
- 低置信度丢弃；提取永不创建 Commitment（承诺需要 typed 工具的可结算语义）也永不创建 DeceptionEpisode（欺骗需要计划引用或识破证据）；
- 提取失败计数进日志，不阻塞房间；
- 恢复后已提取记录不重提。

## 20. 承诺对账（最有价值的真指标）

承诺是 typed 数据结构（promisor、audience、promisedAction 判别联合、conditions、state）。结算时确定性比对承诺与实际行动：fulfilled / violated / void。`promise-kept`/`promise-broken` 强标签只能由对账结果产生——这是全系统最可信的社会语义，验收和 smoke 门禁都以它为准。

## 21. 事件流分层

- **DomainEvent**：权威、确定性、可重放，唯一驱动世界 reducer；
- **SocialCausalityEvent**：引用消息/观察/DomainEvent 的社会语义变化；
- **AgentTraceEvent**：请求、工具、延迟、token、安全摘要（不含 provider reasoning）；
- **PresentationEvent**：镜头/动画/标题，永不反向驱动前三类。

统一事件信封含 eventId、sequence（房间内单调）、logicalTime、causationId、visibility、schemaVersion。事件不可原地改写，更正通过新事件表达。

---

# 第六部分：上下文管理

## 22. Session 即记忆

Agent 的记忆就是 OpenAI Agents SDK 的持久 Session：`Runner.run(agent, input, { session })` 自动把会话历史喂给模型、新回合写回。赛季模式下同一角色的 Session 按 `characterId` 跨局复用，模型凭自身上下文记得既往对局；one-shot 模式每局独立、零历史。**不做任何自建记忆系统**——没有检索、没有相关性评分、没有记忆写入策略、没有记忆归档。

## 23. 上下文预算与压缩

预算必须同一次计算覆盖：系统指令 + 人物身份 + tool schema + 社会状态块 + 压缩历史 + 新观察 + 输出/工具/推理预留 + 安全余量。编译后最终校验。压缩摘要作为受信 system 上下文块回灌（不是普通 user 消息），带 sequence range、schema version、source checksum、未结算承诺与活跃欺骗。压缩失败不破坏原始历史，压缩后必须持久化并重启验证。当前 tokenizer 是字符启发式——真实 tokenizer 列入路线（Phase D），不阻塞主线。

---

# 第七部分：对话与社会互动调度

## 24. 消息与调度

- 每条消息有 `messageId`；`replyTo` 指向真实原消息，O(1) 索引；mention 与 reply 分开处理。
- 发言压力来自结构化社会行为（被回复/被点名/被提问/被指控/收到承诺或报价/被威胁/新证据涉及自己），场景通过 `ConversationSignal` 提供语义，核心调度不硬编码任何场景词汇或单一语言关键词。
- **沉默是真实选择**，但要留下可解释状态（无压力 / 战略性沉默 / 模型失败 / 暂停 / 超时），UI 不得混为同一种。
- 调度器只决定谁获得发言机会，不写、不改、不要求特定内容。

---

# 第八部分：场景与世界规则

## 25. 世界层职责

分配游戏角色、维护阶段、产生 scoped observation、声明合法行动、校验提交、维护密封 barrier、统一结算、产生 canonical events、完整保存/恢复状态、正向投影。世界**不**决定信任谁、不猜测承诺、不按数值发强标签、不为失败补动作。

## 26. checkpoint 与投影

`exportWorldState()/importWorldState()` 必须覆盖所有 phase-local state（回合、阶段、进行中行动、资源、讨论状态、RNG、未结算承诺、schema version），每个阶段有 round-trip 测试。观察只有正向构造：`observe(actorId) / projectPublic / projectAgentPov / projectOmniscient / projectPostgame`。

## 27. 13 场景等深度路线（用户决策：不收缩）

全部 13 个场景保持可玩并**逐一**补齐社会因果深度，成熟标准每个场景一致：

1. 规则正确（结算/密封/恢复测试通过）；
2. 信息边界正确（投影测试通过）；
3. 承诺与欺骗可记录（有语义的场景接 typed 工具，无语义的场景靠旁路提取 + 中性标签）；
4. 结果可结算且后果进入关系；
5. 行为链可验收（见 §28）；
6. 有确定性自动测试 + 至少一局真实模型示例。

推进顺序：**狼人杀（旗舰）→ 囚徒困境 → 谈判 → 公共品 → 阿瓦隆 → 最后通牒 → 蜈蚣 → 胆小鬼 → 猎鹿 → 选美 → 密封拍卖 → 吹牛骰**（信任博弈已完成承诺闭环）。

## 28. 场景验收 = 行为链，不是内心状态

验收案例全部用**世界真相可查的行为链**定义：

- **狼人杀谎言闭环（旗舰）**：狼人公开声称 X → 该声称与身份/行动产生可查矛盾 → 投票/淘汰行为发生 → 身份揭晓时系统对账"该具体主张为假" → deception episode 进入 detected（引用消息 + 揭示事件）→ 关系后果进入下一轮。**身份揭晓本身不等于识破**，必须有具体主张对账。
- **信任博弈（已通过）**：受托者 typed 承诺返还 ≥N → 投资者实际收到 → 投资决策引用承诺 → 返还结算 → 承诺 fulfilled/violated → 关系变化进入角色互换轮。
- **囚徒困境**：合作承诺 → 同时选择 → 对账 → 重复互惠/报复/宽恕的行为序列。
- 其余场景按同模式定义：**主张 → 行动 → 世界结算 → 对账 → 后果**，每一步引用消息 ID、命令 ID 或事件 ID。

---

# 第九部分：观战体验

## 29. 默认产品体验

界面优先回答：谁在影响谁？谁声称什么、实际做了什么？哪个承诺悬而未决？哪个欺骗在传播或濒临暴露？关系为什么变化？三栏布局（参与者 / 直播流 / 因果页）为基础。

## 30. 因果页

- **战况**（有积分的场景）；
- **公开怀疑**（狼人杀写入的怀疑链）；
- **社会行为时间线**：混合显式声明与旁路提取（带"自动提取"+置信度标注）——所有场景必有内容；
- **信念时间线**（自述来源标注，展示叙事不冒充测量）；
- **承诺账本**（typed 承诺 + 对账状态）；
- **欺骗生命周期**（弱证据阶段明确标注，未到达阶段显示"未证实"）；
- **有向关系**（A→B 与 B→A 独立，不合并）；
- **影响链**（每条边标注 agent-cited / temporal-association / observer-inferred）；
- 每张卡片带来源徽章。

空区块如实隐藏或显示为空，不为戏剧性补造。

---

# 第十部分：持久化、恢复与安全

## 31. 持久化

- SessionStore：所有变更置 dirty 后 flush；原子写（temp + rename）；写失败保留 dirty；schema version + checksum；损坏文件隔离并**记日志**（不得静默消失）。
- Room checkpoint：room metadata、schema version、profiles（含 characterId）、world state、pending actions、messages、social ledger state、mind、open commitments、model bindings、paused state、logical clock、RNG state。
- 归档分层：public archive（正向投影）与 forensic archive（operator-only，不暴露路径/密钥/私有数据）。
- 逻辑时钟驱动社会语义排序；`Date.now()` 只用于显示与超时。
- 幂等与迟到：同一 idempotency key 只结算一次；activation 结束后迟到工具调用被 epoch 拒绝。

## 32. 权限

角色：anonymous spectator / room participant / room owner / operator。API 默认最小权限：未认证 GET 默认 public；omniscient 与 POV 需授权；控制操作需 owner/operator；token 走 header + HttpOnly cookie，不进 query string；baseURL 可配置时防 SSRF（禁云 metadata 地址、超时、脱敏错误）。错误响应不泄露路径、密钥、provider 原始响应。

---

# 第十一部分：Provider 与并发

## 33. 请求生命周期

permit 覆盖**真实 provider 请求存活时间**，不是本地 Promise.race 等待时间。本地超时后 permit 继续持有直到底层 settle。所有 timer 在成功/失败/abort/pause/dispose/retry/finish 全路径清理。支持 provider profile 独立队列、circuit breaker、429/5xx 分类重试、per-room fairness。

## 34. 推理强度降级链

`xhigh → high → provider default`（不再往下）。只对明确的 capability error 降级；与推理强度无关的 400/422/鉴权/限流/超时不得被 fallback 掩盖。降级必须向用户发出非阻塞通知（模型、请求级别、实际级别、脱敏错误、是否已重试），UI 持续显示当前生效级别。能力结果按 endpoint/model 缓存（能力记录，不是供应商特判）。

## 35. 失败策略

API 不可用：激活明确失败，不伪造台词或认知更新。结构化输出无效：有限修复次数后记录失败。未调用必要工具：可诊断的 no-action 结果。重复工具调用：幂等返回原收据。上下文超限：按预算策略压缩，摘要不伪装成 user 消息。降级后仍失败：显示脱敏最终错误，标记失败，不伪造成功。

## 36. 模型切换

模型只是引擎。切换保持 characterId、mind、session 语义、关系、承诺、欺骗、游戏角色、公开口径；记录 old/new profile、context policy、是否压缩及产物。

---

# 第十二部分：测量与质量门（替代旧版 Social Truth Lab）

## 37. 指标表（全部可测）

**工具合规**：valid action rate、required action completion、超时率、迟到拒绝数、幂等命中数、降级次数。
**承诺对账**：承诺建立数、fulfilled/violated/void 分布、强标签误报率（审计规则：无承诺记录却发强标签 = 违规）。
**标注抽检**：旁路提取 precision（人工抽样，每局 10 条）、story beat 证据门槛违规数。
**基础设施**：checkpoint recovery 成功数、SSE 断流恢复时长、provider p50/p95、context pressure 分布、提取失败计数。

## 38. smoke 门禁流程（真实模型，轻量）

每次发版或大改动后手动执行（不进 CI 强制门）：

1. 开 2-3 局真实小局（旗舰场景 + 一个普通场景）；
2. 自动汇总 §37 指标（脚本从房间快照/归档提取）；
3. 人工抽检 10 条旁路提取与全部强标签；
4. 结果记录在 PR/提交说明，不达标不合并。

## 39. 测试套件（CI 强制门，全部离线）

```bash
npm run lint && npm run typecheck
npm run test:unit && npm run test:contract && npm run test:integration
npm run test:recovery && npm run test:security && npm run test:replay && npm run test:chaos
npm run build
```

mock/scripted provider 证明调度、超时、恢复、幂等、投影、持久化、并发、失败语义；真实 provider 只进 §38 的 smoke。每个场景契约：observe 不越权、合法工具可提交、非法被拒、密封不泄露、completeActivation 不代打、export/restore round-trip、中间阶段恢复、四类投影、终局稳定。

---

# 第十三部分：明确不做清单

以下内容**不实现、不排期、不接受 PR**（理论原文见 git 历史）：

1. CFR / PSRO / MCTS / 任何形式的策略搜索与 rollout；
2. cross-play 收益矩阵、冻结对手池、meta-strategy 选择；
3. Brier / ECE / log loss / 信念校准曲线等心理状态测量；
4. "欺骗被相信率""行为有效率"作为指标（只作弱证据展示）；
5. 多阶 ToM（Level-2 以上）的结构化维护；
6. Agent POV 历史回放产品功能；
7. 长期人格/价值观演化的工程化"测量"；
8. 通用游戏插件平台、第三方场景 DSL；
9. 为戏剧性由导演注入冲突或修改 Agent 输出。

---

# 第十四部分：路线图

- **Phase A（当前）——Session 跨局持久化**：赛季模式下同一角色的 SDK Session 按 `characterId` 复用，删除自建记忆系统（检索/评分/写入策略）；社会季连续性由会话历史天然承载。
- **Phase B——狼人杀谎言闭环旗舰**：具体主张对账（§28），deception episode 的 detected 由消息+揭示事件驱动；随后囚徒困境、谈判按同标准推进。
- **Phase C——其余场景等深推进**：按 §27 顺序逐一补齐行为链验收与 typed 承诺（语义允许的场景）。
- **Phase D——上下文真实性**：真实 tokenizer 替换字符启发式；tool schema 实测预留；压缩产物 pinned-facts 结构校验。
- **Phase E——多真人参与**：单 `waitingHuman` 改为按 actor/activation 的 mailbox/barrier，支持多真人同时各持私密行动。

结构债（ledger / werewolf / participant / room 四个大文件的拆分）随对应 Phase 顺路解决，不专项重构。

---

# 第十五部分：Definition of Done

任何改动只有满足适用清单后才可称完成。

**通用**：读过真实源码与调用链；说明了当前/目标行为差异；识别了涉及的身份、可见性与状态所有者；处理了持久化恢复与旧数据迁移或明确拒绝；补了自动化测试；跑了适用 typecheck/test/build；日志与 UI 不泄私密数据；更新了直接相关文档；没把目标写成现状；没加无关抽象。

**Agent 行为**：一参与者一持续身份；无新增独立子 Agent；输入只含合法可见信息；结构化状态真正进入上下文；无全局 prompt 预设策略结论；可沉默/拒绝/改变主意；绑定行动必须经工具成功；失败/取消/超时不被描述为完成；模型切换保持连续。

**社会语义**：强标签达到证据门槛（承诺对账或证据链）；来源标注齐全；同一事件不重复结算；自述不作事实；导演标签不回写 canonical。

**世界/场景**：typed command + 确定性 reducer；checkpoint 覆盖全部 phase-local state 且 round-trip 通过；正向投影；结算不自动升级为背叛/联盟；终局披露策略明确。

**持久化**：原子写、dirty 生命周期正确、损坏不静默、重启后 canonical 一致、不持久化原始 chain-of-thought、路径不经 API 暴露。

**API/权限**：未认证最小权限；token 不进 URL/日志；public 投影不含隐藏字段；错误不泄密。

**Provider/并发**：lease 覆盖真实请求生命周期；timer 全路径清理；迟到被 epoch 拒绝；retry 不重复改变世界；hanging fake provider 测试通过。

**Bug 修复**：最小复现、失败测试、根因、回归测试、相邻路径审查、数据污染判断、必要迁移脚本。

---

# 第十六部分：Coding Agent 工作协议

接到任务先判断域：identity / world rule / social causality / agent cognition / context / conversation / runtime / persistence / security / spectator UI。然后阅读：本文件相关章节、目标文件、直接调用者与被调用者、相关 schema、相关持久化、相关投影、现有测试。

复杂改动先写清：Current behavior / Target behavior / Authoritative state owner / Visibility impact / Persistence impact / Migration impact / Failure modes / Tests / Out of scope。

禁止模式：

- 只改搜索命中的第一处代码；
- 把"模型大概会处理"当正确性依据；
- 用单局故事证明机制有效；
- 在投影里新增可见字段而不声明权限；
- 为让测试通过而软化 prompt 或工具语义；
- 把失败吞成静默成功；
- 未经测量声称"信念/欺骗机制有效"——有效性只能用 §0.2 三类硬数据或 §28 行为链验收说话。
