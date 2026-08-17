# AGENTS.md — Society 产品与并列多 Agent 架构宪章

> 适用仓库：`multi-zhangyang/werewolf-multi-agent-social-harness`  
> 适用范围：仓库根目录及全部子目录  
> 文档定位：产品方向、架构硬约束、交互设计规范、实现路线与 Coding Agent 工作规则  
> 最后更新：2026-08-17

---

# 0. 最高优先级原则

本仓库要做的是一个 **免费、可长期运行、面向真实用户、具有高级观战体验的并列多 Agent 社会博弈产品**。

它不是论文复现项目，不是实验 Harness，不是为了堆测试、指标、审计报告或研究术语而存在的平台，也不是多个提示词轮流输出文字的演示。

本项目的核心必须始终是：

> 多个彼此平等、各自独立、具有连续人格和私有心智的真实 Agent，在同一个规则世界中感知、思考、使用工具、沟通、结盟、欺骗、怀疑、记忆、改变，并让观众能够以具有戏剧张力的方式观看这一切发生。

所有开发者和 Coding Agent 必须先接受以下不可协商的硬约束。

## 0.1 必须是真正的 Agent

每个 AI 参与者必须是一个完整、持续存在的 Agent，而不是：

- 一次性 prompt；
- 一个返回 JSON 的文本解析器；
- 一个由中央模型代替思考的“角色壳”；
- 一段固定策略脚本；
- 一套只靠随机数制造差异的伪人格；
- 一个共享大上下文中的不同名字；
- 一个临时创建、用完即丢、没有持续身份和记忆的模型调用。

一个合格的参与者 Agent 必须至少拥有：

1. 稳定且唯一的 `agentId`；
2. 独立模型绑定与模型参数；
3. 独立会话与上下文预算；
4. 独立私有记忆；
5. 独立信念、目标、情绪、需求、注意力和关系状态；
6. 只属于自己的工具权限；
7. 根据自身可见信息形成的世界理解；
8. 能够选择发言、行动、等待、沉默、欺骗、合作或拒绝；
9. 对行动结果进行反馈、反思和记忆巩固的闭环；
10. 跨回合、跨局延续的身份连续性。

缺少上述关键部分的实现，不得在文档、UI 或代码命名中宣称为“Agent”。

## 0.2 多 Agent 必须是并列关系

本项目中的所有玩家 Agent 在主体性上完全平等。

**严禁出现以下层级结构：**

- 主 Agent 与子 Agent；
- manager Agent 与 specialist Agent；
- 一个 Agent 指挥另一批 Agent；
- 一个中央 Agent 汇总并替其他玩家做决定；
- 角色 Agent 把“反思、读心、规划”委托给隶属 Agent；
- 通过 handoff 把同一个角色切换成另一个人格主体；
- 用一个超级 Agent 模拟整桌玩家。

`SocietyRoom`、`SocialWorld`、调度器、上下文管理器、存储层和观战导演都只能是 **无人格、无阵营、无私欲、无策略权的基础设施**。它们负责时间、规则、权限、持久化、并发和展示，不能替任何参与者判断、说话或下注。

反思、心智推断、规划、记忆检索、情绪评估等能力，必须是 **每个参与者 Agent 内部的认知阶段或模块**，不是新的 Agent 身份。

## 0.3 产品必须免费

Society 本身不设计收费体系。

禁止加入：

- 订阅；
- 会员；
- 付费角色包；
- 付费模型槽位；
- Token 点数包；
- 对局次数收费；
- 高级观战功能付费解锁；
- 广告解锁；
- 人为限制免费用户再销售额度；
- 任何以“商业化”为理由破坏免费使用的功能。

允许并应优先支持：

- 用户自带 API Key；
- OpenAI-compatible 端点；
- 本地模型；
- 局域网模型服务；
- 多提供商配置；
- 完全本地、自托管运行。

第三方模型提供商可能自行收费，这属于用户与提供商之间的关系，不是 Society 的收费模式。产品中的 Token、延迟和吞吐统计用于资源管理与调优，不得包装成计费系统。

## 0.4 产品级，不是实验级

“免费”不等于粗糙，“开源”不等于实验品。

产品必须具备：

- 清晰的安装与配置流程；
- 稳定的长时间运行能力；
- 失败恢复；
- 会话持久化；
- 上下文自动管理；
- 完整模型配置；
- 可理解的错误提示；
- 高级且统一的视觉设计；
- 真正有戏剧张力的观战体验；
- 可扩展的角色、世界和人物系统；
- 对真实模型行为的诚实呈现。

研究论文可以帮助选择设计，但不能把产品改造成论文附属品。任何研究概念进入代码前，都必须回答一个问题：

> 它是否直接让 Agent 更像一个持续存在的主体，或者让用户更好地创建、运行和观看这些 Agent？

不能回答这个问题的研究功能不进入主路线。

## 0.5 不允许“假的成熟度”

禁止用以下方式营造项目已经成熟的假象：

- 用固定台词、预录输出或硬编码行为冒充模型表现；
- 用 mock LLM 的预期文本证明 Agent“有人性”；
- 只跑类型检查就宣称功能可用；
- 只看单次成功结果就宣称长期稳定；
- UI 显示并未真实发生的思考、工具调用、记忆或情绪变化；
- 工具失败后偷偷代填一个成功行动；
- 模型没有返回推理摘要时生成一段伪“内心独白”并标记为原始推理；
- 用随机数制造人格差异后宣称是认知设计；
- 用大量无实际用户价值的测试、审计面板或研究指标替代产品能力。

允许并必须保留真实的工程质量检查：规则单元测试、配置解析测试、权限测试、真实提供商冒烟对局、浏览器交互检查和长期运行检查。测试是防止产品回归的手段，不是产品本身，更不能拿假的模型输出冒充真实 Agent 体验。

---

# 1. 对当前仓库的准确理解

修改本项目之前，必须理解它已经有哪些能力、哪些设计方向是正确的，以及哪些实现与产品目标发生了冲突。

## 1.1 当前产品骨架

当前仓库已经具备：

- React 19、Vite、Tailwind CSS 和组件化前端；
- Express 服务器与 SSE 实时事件流；
- OpenAI Agents SDK 驱动的参与者运行时；
- 13 个社会博弈世界；
- 每个参与者的会话、记忆、情绪、关系、信念、目标等状态；
- 公开、私聊和阵营频道；
- 模型流式文本、提供商推理字段和工具调用事件；
- 动态讨论调度；
- 跨局社会季；
- 人类玩家加入；
- 多模型轮转分配；
- 基于模型上下文窗口的自动摘要压缩；
- 三栏式实时房间界面。

这些能力说明项目已经有可用的社会游戏内核，不应推倒重来。

## 1.2 当前最严重的架构冲突

`src/society/participant.ts` 当前把一个参与者定义为 manager Agent，并创建反思、读心、谋划三个 SDK 专家 Agent，通过 `Agent.asTool()` 调用。

这与本项目要求的“并列多 Agent”不一致，必须移除。

原因不是 SDK 的 manager 模式本身错误，而是它适合“一个主体调用多个专家完成任务”的工作流，不适合本项目对社会主体的定义。这里的每个玩家本身就应该是完整主体。把认知能力拆成隶属 Agent，会造成：

- 角色内部出现不必要的代理层级；
- 同一人格的认知被拆成多个不同 Agent 实例；
- 专家输出成为摘要报告，而不是同一主体连续思考的一部分；
- UI 容易把“多个内部 Agent”错误包装成“更真实的多 Agent”；
- 模型配置、会话、记忆和工具权限难以保持单一主体的一致性；
- 项目的“多 Agent”数量被内部专家虚增。

`discussionAgent` 也不应作为第二个逻辑 Agent 身份存在。讨论阶段可以有不同的工具集合、指令片段和推理预算，但仍必须属于同一个参与者 Agent、同一个身份、同一个私有状态和同一条连续会话。

## 1.3 当前模型配置不够完整

当前实现主要是：

- 全局一个 `baseURL`；
- 全局一个 API Key；
- 一个模型 ID 列表；
- 创建房间时选择一个或多个模型；
- 按参与者顺序轮转分配；
- 一个统一推理强度；
- 可选温度；
- 通过环境变量配置模型上下文窗口。

这只能算“模型选择”，还不能算完整的 Agent 模型配置系统。

必须补齐：

- 多提供商档案；
- 模型能力档案；
- 全局默认模型；
- 房间级覆盖；
- 单 Agent 覆盖；
- 同一 Agent 不同认知阶段的可选高级覆盖；
- 上下文窗口、输出预算、工具能力、推理能力、超时、重试、缓存等参数；
- 配置继承与最终生效值预览；
- 不同模型不支持某参数时的能力协商。

## 1.4 当前上下文压缩只是第一版

`src/society/context-manager.ts` 已经实现：

- 估算历史 Token；
- 按模型上下文窗口设置阈值；
- 默认约 75% 时触发；
- 保留最近若干项；
- 用当前 Agent 模型把旧历史压缩为一段摘要；
- 将摘要重新写入会话。

这说明项目已经意识到 Agent 长期运行需要自动压缩，方向正确。

但当前仍然是单层、单阈值、纯文本摘要方案，缺少：

- 输出 Token 和工具结果的动态预留；
- 多级压力阈值；
- 不可压缩事实；
- 结构化情节、语义、关系和程序记忆；
- 压缩前后的完整性检查；
- 失败降级；
- 会话持久化；
- 按空闲阶段渐进压缩；
- 用户可见的上下文状态；
- 原生 Responses compaction 与本地 fallback 的统一策略。

## 1.5 当前“人性”仍主要依赖状态字段和人格提示

当前项目已经有 OCEAN、情绪、社会情绪、关系账本、目标、信念和记忆，这些应保留。

但真正的人类感不能只靠在 prompt 中写“谨慎、外向、容易记仇”。当前前沿结果反复暴露出几个问题：模型容易成为过度积极、过度活跃、过度礼貌的“平均人”；不同人格最终说话和行动越来越像；仅仅扩大上下文并不能自动解决长期行为一致性。

因此下一步必须从“人物描述”升级为“持续认知机制”：

- 有限注意力；
- 情景评价；
- 自传式记忆；
- 目标冲突；
- 情绪惯性；
- 关系惯性；
- 风险、面子、公平、地位和损失厌恶；
- 信念的不确定性；
- 沉默和不行动；
- 习惯与偏差；
- 有边界的长期人格变化。

## 1.6 当前观战界面更像控制台，不像竞技剧场

`room-view.tsx` 当前以固定三栏布局组织参与者、对话和世界信息。这种布局信息完整，但主要解决“看得到”，没有解决“看得爽”。

当前推理、工具、状态和关系数据已经存在，但展示上仍存在：

- 信息分散；
- 主次不清；
- 缺少镜头语言；
- 缺少对峙、反转、背叛和淘汰的戏剧包装；
- 缺少选中 Agent 的实时心智轨迹；
- 工具调用像日志，不像行动；
- 观众需要自己在多个面板中寻找关键事件；
- 缺少自动节奏、回放、高潮和高光片段。

必须从“管理后台式三栏”转向“舞台优先、数据按需展开”的沉浸式观战界面。

## 1.7 当前角色和人物容量太小

`profiles.ts` 现内置 24 个 OCEAN 人格种子，人物与房间规模解耦。狼人杀已升级为 6/8/9/10/12 人牌组模板（狼人·狼王·预言家·女巫·猎人·守卫·小丑·村民，按官方板子配牌）。

这不足以支撑长期产品内容。

需要把以下概念彻底分开：

- `CharacterDefinition`：持续人格、背景、声音、价值观和自传记忆；
- `GameRoleDefinition`：某个世界中的临时身份、能力和胜利条件；
- `AgentRuntimeConfig`：模型、上下文、工具和运行参数；
- `ParticipantController`：AI 或真人控制方式。

人物不是角色，角色不是模型，模型也不是人格。


## 1.8 现有 13 个世界与产品定位

当前 13 个世界不是为了凑“基准数量”，而是 13 种不同的社会戏剧和 Agent 能力压力。后续改造必须保留它们各自的玩法辨识度。

| 世界 | 当前核心张力 | Agent 重点能力 | 观战重点 |
|---|---|---|---|
| 狼人杀 | 隐藏身份、公开指控、夜间能力、第三阵营 | 欺骗、身份推断、联盟、公开辩护、秘密行动 | 怀疑扩散、对峙、夜间行动、投票翻转、身份揭晓 |
| 阿瓦隆 | 阵营隐藏、组队、任务投票、梅林刺杀 | 高阶心智推断、身份伪装、队伍选择、长期一致性 | 组队争执、任务成败、刺杀悬念、终局真相 |
| 吹牛骰 | 隐藏点数、连续叫价、质疑与揭盅 | 风险估计、概率直觉、虚张声势、对手建模 | 叫价阶梯、犹豫、质疑瞬间、揭盅冲击 |
| 谈判博弈 | 私密保底、同时报价、利益交换 | 偏好隐藏、让步、承诺、威胁、关系利用 | 条款变化、底线接近、谈崩或成交 |
| 囚徒困境 | 短期背叛与长期互惠 | 声誉、记忆、报复、原谅、策略适应 | 选择揭示、连续背叛、关系断裂或修复 |
| 蜈蚣博弈 | 继续合作使奖池增长，随时可截取 | 延迟满足、信任、贪婪、终点判断 | 奖池增长、停手犹豫、突然截取 |
| 胆小鬼博弈 | 谁先退让，谁承担相撞风险 | 威慑、可信承诺、胆量、对方风险偏好推断 | 压力上升、最后一刻转向或相撞 |
| 猎鹿博弈 | 高收益合作与安全退路 | 协调、互信、风险规避、信号解释 | 合作预期形成、临阵转向、共同成功或落空 |
| 信任博弈 | 一方先交出资源，另一方决定回报 | 信任、感恩、机会主义、长期关系 | 交付瞬间、回报比例、背叛后的情绪与记忆 |
| 最后通牒 | 分配权与拒绝权 | 公平感、尊严、惩罚意愿、谈判 | 报价、愤怒、接受或掀桌 |
| 公共品博弈 | 集体收益与搭便车 | 群体规范、贡献意愿、惩罚、声誉 | 每轮贡献揭示、搭便车者、群体情绪变化 |
| 选美博弈 | 猜别人会猜什么 | 多阶信念、群体预期、策略深度 | 数值分布、群体中心、结果反差 |
| 密封拍卖 | 私密估值、策略出价、统一揭示 | 估值保护、对手建模、风险控制 | 密封提交、同时揭价、赢家与支付价格 |

这些世界应共用 Agent、模型、记忆、事件和观战基础设施，但不能共用一套没有个性的视觉外壳。

世界层 UI 至少分为四类舞台模板：

1. **隐藏身份圆桌**：狼人杀、阿瓦隆；
2. **谈判与双人对峙**：谈判、信任、最后通牒、囚徒困境；
3. **风险升级桌面**：吹牛骰、蜈蚣、胆小鬼、猎鹿；
4. **秘密提交与统一揭示**：公共品、选美、密封拍卖。

新增角色主要发生在狼人杀和阿瓦隆，但其他世界也需要更丰富的规则变体、人数模板、视觉主题和长期关系影响。不得因为当前重点是角色扩展，就把其余世界降级成无动画的数字表格。

---

# 2. 并列多 Agent 架构硬约束

本节是仓库最高级架构规则。任何实现与本节冲突时，以本节为准。

## 2.1 一名 AI 玩家只对应一个逻辑 Agent

每个 AI 参与者必须只存在一个逻辑 Agent 身份。

推荐实现上也只创建一个 SDK `Agent` 实例。不同阶段需要不同工具和提示时，通过以下方式解决：

- 动态 instructions；
- 动态工具启用条件；
- 运行时 phase context；
- 同一 Agent 内部的结构化认知 pass；
- 同一会话上的多次模型调用；
- 同一身份下的模型配置解析。

不得为了“讨论模式”“规划模式”“反思模式”再创建第二、第三个 Agent 身份。

## 2.2 内部认知模块不是 Agent

允许存在以下内部模块：

- `PerceptionModule`；
- `AttentionModule`；
- `MemoryRetriever`；
- `SituationAppraiser`；
- `BeliefUpdater`；
- `MotivationResolver`；
- `ActionPlanner`；
- `SocialTheoryOfMind`；
- `ReflectionPass`；
- `MemoryConsolidator`。

它们可以是普通 TypeScript 函数、服务对象、状态机步骤，或同一 Agent 发起的结构化模型调用。

它们不得：

- 拥有独立玩家身份；
- 拥有自己的社会关系；
- 自称另一个人格；
- 直接访问超出该玩家权限的信息；
- 直接行动于世界；
- 通过 `Agent.asTool()` 被包装为隶属 Agent；
- 在 UI 中被计为额外参与者。

## 2.3 Agent 之间不得共享私有会话

每个 Agent 必须拥有自己的：

- session ID；
- working context；
- private observations；
- private role information；
- episodic memory；
- belief state；
- tool history；
- compaction lifecycle。

Agent 之间只能通过世界允许的渠道交换信息：

- 公开发言；
- 私聊；
- 阵营频道；
- 世界定义的信号；
- 可观察的行动与结果。

禁止把其他 Agent 的私有 prompt、会话历史、隐藏推理、工具输出或角色知识直接拼接到当前 Agent 上下文。

## 2.4 世界只提供规则，不提供策略

`SocialWorld` 负责：

- 角色分配；
- 阶段推进；
- 可见性；
- 合法行动；
- 工具校验；
- 同时提交；
- 结算；
- 胜负；
- 公开与私有事件；
- 剧情事实。

`SocialWorld` 不负责：

- 替 Agent 判断谁可信；
- 替 Agent 选择目标；
- 自动生成策略理由；
- 给某个 Agent 注入“正确答案”；
- 因为模型失败而代填行动；
- 强迫每个 Agent 说同样长度的话；
- 将开发者偏好的策略写死为“人格”。

## 2.5 房间调度器不是主 Agent

`SocietyRoom` 负责：

- 创建并列 Agent；
- 分发冻结后的观察；
- 调用 Agent；
- 收集行动意图；
- 推进世界；
- 处理暂停、恢复和真人等待；
- 广播事件；
- 保存房间状态。

它不得：

- 读取所有 Agent 的私有认知后替它们做统一决策；
- 选择“谁应该赢”；
- 作为裁判兼玩家；
- 将某个 Agent 的工具授权给另一个 Agent；
- 因为响应慢而改变该 Agent 的信息条件。

## 2.6 观战导演不是玩家

`SpectatorDirector` 或 `CinematicDirector` 只负责：

- 识别事件的重要程度；
- 选择镜头；
- 调整播放节奏；
- 生成字幕、转场和高光标记；
- 控制 UI 呈现。

它不得：

- 向 Agent 提供建议；
- 修改世界状态；
- 修改 Agent 心智；
- 影响行动顺序；
- 伪造冲突；
- 为了戏剧性改变投票或胜负；
- 读取私有信息后反馈给玩家。

## 2.7 并列 Agent 的运行拓扑

目标拓扑如下：

```text
                         ┌──────────────────────────┐
                         │   SocietyRoom Runtime    │
                         │ 调度 / 生命周期 / 持久化 │
                         └─────────────┬────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
      ┌───────▼────────┐      ┌────────▼───────┐       ┌────────▼───────┐
      │ Peer Agent A   │      │ Peer Agent B   │  ...  │ Peer Agent N   │
      │ 独立身份/会话  │      │ 独立身份/会话  │       │ 独立身份/会话  │
      │ 独立记忆/模型  │      │ 独立记忆/模型  │       │ 独立记忆/模型  │
      └───────┬────────┘      └────────┬───────┘       └────────┬───────┘
              │                        │                        │
              └────────────────────────┼────────────────────────┘
                                       │ 只通过合法工具与频道
                         ┌─────────────▼────────────┐
                         │       SocialWorld        │
                         │ 规则 / 权限 / 可见性 / 结算 │
                         └─────────────┬────────────┘
                                       │ 事实事件
                    ┌──────────────────┴──────────────────┐
                    │                                     │
          ┌─────────▼─────────┐                ┌──────────▼─────────┐
          │ Persistence Layer │                │ Spectator Director │
          │ 会话/记忆/检查点   │                │ 镜头/节奏/高光     │
          └───────────────────┘                └────────────────────┘
```

任意箭头都不能被解释为玩家之间的隶属关系。

## 2.8 同时行动必须真正同时提交

对于投票、出价、选择目标等并行阶段，不能让先返回的模型改变后返回模型看到的世界。

并行阶段必须使用：

1. 冻结阶段快照；
2. 为每个 Agent 创建独立观察；
3. 并行生成 `ActionIntent`；
4. 在所有必要意图完成或超时后统一校验；
5. 原子提交；
6. 统一揭示和结算。

```ts
interface ActionIntent {
  activationId: string;
  actorId: string;
  action: string;
  payload: unknown;
  createdAt: string;
  idempotencyKey: string;
}
```

工具在并行生成阶段不得直接写入共享世界。工具只产生意图；世界在 commit 阶段统一生效。

---

# 3. Agent 的完整定义

## 3.1 Agent 不是一轮模型调用

本项目中的 Agent 是一个长期运行实体：

```ts
interface AutonomousSocietyAgent {
  readonly id: string;
  readonly characterId: string;
  readonly sessionId: string;
  readonly modelBinding: AgentModelBinding;

  perceive(observation: AgentObservation): Promise<PerceptionFrame>;
  deliberate(input: DeliberationInput): Promise<DecisionFrame>;
  act(decision: DecisionFrame): Promise<AgentActionResult>;
  appraise(events: SocialEvent[]): Promise<void>;
  consolidate(reason: ConsolidationReason): Promise<void>;
  checkpoint(): Promise<AgentCheckpoint>;
}
```

Agent 的连续性来自身份、状态、会话、记忆和行动因果链，不来自每轮重复一段 persona 文案。

## 3.2 每个 Agent 的四类状态

### A. 稳定身份层

长期稳定，不因单局轻易改变：

- 名字与视觉形象；
- 价值观；
- 人格基线；
- 语言风格；
- 道德边界；
- 风险偏好；
- 公平偏好；
- 依恋与信任倾向；
- 冲突处理方式；
- 代表性自传经历；
- 长期自我叙事。

### B. 中期适应层

跨局缓慢变化：

- 对其他人物的关系；
- 声誉判断；
- 习惯策略；
- 对特定人物的警惕；
- 对不同博弈类型的经验；
- 自我效能感；
- 近期人格偏移；
- 形成或瓦解的联盟倾向。

### C. 当前心理层

随事件和回合变化：

- 情绪；
- 社会情绪；
- 精力；
- 压力；
- 当前需求；
- 注意力焦点；
- 当前目标；
- 当前怀疑；
- 当前计划；
- 当前自我呈现策略。

### D. 当前世界层

由游戏环境定义：

- 临时角色；
- 阵营；
- 可见玩家；
- 私有线索；
- 当前阶段；
- 合法工具；
- 剩余资源；
- 已提交行动；
- 胜利条件。

四层不得混写。角色能力不能永久写进人物人格；模型参数不能写进角色定义；上一局角色身份不能成为下一局的事实知识。

## 3.3 Agent 必须拥有可执行的认知循环

每次重要行动至少经过以下逻辑阶段：

```text
观察世界
  ↓
注意力选择
  ↓
检索相关经历与关系
  ↓
评估情境对目标、需求和身份的意义
  ↓
更新带置信度的信念
  ↓
识别目标冲突与社会风险
  ↓
生成少量候选行为
  ↓
按人格、情绪、经验和约束选择
  ↓
调用真实工具或选择沉默
  ↓
观察结果
  ↓
更新关系、情绪、经验和自我叙事
```

这不是要求每一步都调用一次昂贵模型。简单步骤可以由确定性代码完成，复杂步骤可以合并为一次结构化模型调用。硬约束是：最终行为必须真实依赖该 Agent 自己的状态和观察，而不是只依赖当前一条用户式 prompt。

## 3.4 推荐的内部认知帧

```ts
type CognitivePhase =
  | "perceive"
  | "recall"
  | "appraise"
  | "infer"
  | "plan"
  | "decide"
  | "act"
  | "reflect"
  | "consolidate";

interface CognitionFrame {
  agentId: string;
  activationId: string;
  phase: CognitivePhase;
  observationDigest: string;
  attendedSignals: Array<{
    kind: string;
    sourceId?: string;
    salience: number;
    summary: string;
  }>;
  recalledMemoryIds: string[];
  currentGoals: Array<{
    goalId: string;
    urgency: number;
    progress: string;
  }>;
  hypotheses: Array<{
    proposition: string;
    confidence: number;
    evidenceFor: string[];
    evidenceAgainst: string[];
  }>;
  candidateActions: Array<{
    action: string;
    expectedBenefit: number;
    perceivedRisk: number;
    socialCost: number;
    rationaleSummary: string;
  }>;
  selectedAction?: string;
}
```

`CognitionFrame` 属于同一个 Agent 的内部状态，不代表一个“认知 Agent”。

## 3.5 Agent 必须允许不行动

真实社会行为不是持续发言。

每个适用阶段应允许：

- `stay_silent`；
- `observe`；
- `pass`；
- `defer`；
- `withhold_information`；
- `refuse`；
- `wait_for_response`。

沉默必须有真实语义：

- 没有新信息；
- 风险过高；
- 想观察别人；
- 不愿暴露立场；
- 精力不足；
- 社会压力导致退缩；
- 故意制造不确定性。

不能为了“热闹”强制所有 Agent 每轮都输出长篇发言。前端导演可以跳过无信息时段，但不能消灭沉默本身。

### 3.5.1 先形成表达意愿，再生成公开发言

讨论阶段必须把“内部评价”“是否想说”“获得话轮后的公开表达”分开。每个并列 Agent 可以在同一时间窗独立形成 `SpeakIntent`：

```ts
interface SpeakIntent {
  activationId: string;
  agentId: string;
  wantsToSpeak: boolean;
  willingness: number;
  urgency: number;
  addressedAgentIds: string[];
  strategy:
    | "answer"
    | "challenge"
    | "defend"
    | "clarify"
    | "bridge"
    | "qualify"
    | "withhold";
  reasonSummary?: string;
  createdAt: string;
}
```

`ConversationScheduler` 只能按确定性规则解决多人同时抢话，例如被直接提问、回应紧迫度、等待时长、话轮公平和世界阶段；它不是主 Agent，也不能替任何 Agent 生成立场。只有获得话轮的 Agent 才生成最终公开表达。这样既保留并列自治，又让沉默、犹豫、插话和抢答成为真实行为。

## 3.6 工具是 Agent 行动能力，不是装饰

每个 Agent 的行动只能通过真实工具进入世界。

工具必须满足：

- 明确的输入 schema；
- 角色和阶段权限；
- actor 绑定；
- 幂等保护；
- 可追踪状态；
- 成功或失败结果；
- 对世界造成可描述的真实影响；
- 不能由文本假装已执行。

Agent 在文本中说“我投给 A”不等于已投票；只有 `cast_day_vote` 成功才算。

工具失败时必须把失败反馈给同一个 Agent，让它决定重试、换方案或放弃。基础设施不能替它补一个“合理行动”。

---

# 4. 让 Agent 更具人性的设计方向

## 4.1 不能再把“人性”理解为更多人格形容词

只增加“冷静、腹黑、善良、果断”等词不会得到真正不同的人。

当前模型的常见偏差包括：

- 过度积极；
- 过度合作；
- 过度礼貌；
- 过度活跃；
- 人格平均化；
- 长对话后语气和策略趋同；
- 记住事实但忘记这些事实对自己意味着什么；
- 明明受过背叛，下一轮仍迅速恢复友好；
- 只会“理性最优”，缺乏面子、惯性和自我辩护；
- 每次都重新评估，缺少习惯和路径依赖。

解决方案是建立结构化、连续、受约束的主体，而不是无限扩写系统提示。

## 4.2 人性化的八个核心层

### 4.2.1 自传式身份

每个 Character 不只有人物简介，还应拥有多分辨率的虚构人生记忆：

- 童年形成性经历；
- 家庭与群体关系；
- 重要成功；
- 重要失败；
- 被信任或背叛的经历；
- 对公平、权威、承诺和风险的来源性事件；
- 一些普通、低戏剧性的生活记忆；
- 对自己的解释方式。

不需要每个角色一开始就生成上千条长文本。产品实现可分为：

- 8—12 个核心人生节点；
- 30—60 个中等粒度情节；
- 若干按需展开的生活片段；
- 一段自我叙事摘要。

关键是当前情境能检索到“为什么这个人会这样反应”的经历。

### 4.2.2 情境评价

Agent 不应直接从事件跳到情绪。

它先判断：

- 这件事是否有利于我的目标；
- 是否损害我的地位或面子；
- 是否违反公平预期；
- 是否来自我信任的人；
- 是否可控；
- 是否确定；
- 是否公开发生；
- 是否要求立即回应；
- 是否暗示欺骗或联盟变化。

可以用适合社交博弈的情境维度：

```ts
interface SituationAppraisal {
  duty: number;
  threat: number;
  opportunity: number;
  socialExposure: number;
  negativity: number;
  positivity: number;
  deception: number;
  coalitionPressure: number;
  fairnessConflict: number;
  uncertainty: number;
  controllability: number;
}
```

### 4.2.3 有限注意力

Agent 不应平等处理所有消息。

注意力受以下因素影响：

- 是否点名自己；
- 是否涉及当前目标；
- 来源人物的重要性；
- 情绪强度；
- 新颖性；
- 与既有信念的冲突；
- 是否公开；
- 是否临近行动截止；
- 当前精力和压力。

被忽略的信息仍可存在于环境历史，但不应自动进入每次推理的核心上下文。

### 4.2.4 带不确定性的信念

所有社会判断必须允许不确定性和矛盾证据。

```ts
interface SocialBelief {
  id: string;
  subjectId: string;
  proposition: string;
  confidence: number;
  evidenceFor: EvidenceRef[];
  evidenceAgainst: EvidenceRef[];
  sourceReliability: number;
  lastUpdatedTurn: number;
  decayPolicy: "stable" | "normal" | "fast";
}
```

角色怀疑不应只是一个任意分数。需要区分：

- 我直接观察到的事实；
- 某人告诉我的信息；
- 我从行为推断的结论；
- 我出于阵营策略公开宣称的内容；
- 我真正相信的内容。

公开发言和私有信念不能被当成同一件事。

### 4.2.5 多目标和内部冲突

Agent 同时拥有多个可能冲突的目标：

- 赢得当前游戏；
- 保护盟友；
- 保持声誉；
- 避免公开羞辱；
- 报复背叛；
- 保留信息优势；
- 维持长期关系；
- 证明自己判断正确；
- 降低风险；
- 追求刺激或影响力。

行动不是简单最大化一个分数，而是受人格、情绪和经验调节的权衡。

### 4.2.6 情绪与关系惯性

情绪和关系不能每回合重新归零，也不能被一条正面消息瞬间修复。

需要：

- 情绪上升和恢复速度因人而异；
- 背叛造成的信任下降快、恢复慢；
- 公开羞辱比私下分歧影响更大；
- 盟友的背叛比陌生人的攻击更痛；
- 长期正面经历形成缓冲；
- 压力会缩窄注意力、提高冲动或沉默倾向；
- 情绪影响决策，但不能完全覆盖角色目标。

### 4.2.7 有限理性和稳定偏差

人性不是随机犯错。偏差必须来自角色自身：

- 确认偏误；
- 损失厌恶；
- 沉没成本；
- 内群体偏好；
- 权威敏感；
- 对背叛过度警觉；
- 对魅力型人物过度信任；
- 高估自己识谎能力；
- 避免认错；
- 公开立场后的承诺升级；
- 对最近事件过度加权。

每个 Character 只拥有少量稳定偏差，不要给所有人全部偏差，也不要每轮随机切换。

### 4.2.8 缓慢的人格发展

长期 Agent 可以改变，但不能一局后彻底换人。

变化应遵循：

- 核心价值变化最慢；
- 行为习惯比核心人格更容易变化；
- 重复且高强度的经历才产生长期偏移；
- 短期状态与长期特质分开存储；
- 每次变化有原因、有幅度上限、有回归趋势；
- 变化写入自我叙事，而不是直接覆盖原 persona。

```ts
interface TraitState {
  baseline: number;
  adaptation: number;
  effective: number;
  lastCauses: string[];
}
```

`effective` 可由 `baseline + bounded(adaptation)` 得出，适应值随时间缓慢衰减或被长期经历巩固。

## 4.3 Character 设计必须增加行为差异，而不是只改台词

每个 Character 至少定义：

- Big Five 或等价稳定人格维度；
- 价值优先级；
- 风险偏好；
- 公平敏感度；
- 地位需求；
- 归属需求；
- 控制需求；
- 报复阈值；
- 原谅速度；
- 欺骗意愿；
- 欺骗心理成本；
- 说话欲望；
- 被点名后的回应阈值；
- 冲突升级倾向；
- 信息保留倾向；
- 信任先验；
- 受影响程度；
- 自信校准；
- 记忆偏差；
- 语言风格；
- 自传记忆锚点。

这些参数必须影响：

- 注意什么；
- 记住什么；
- 相信什么；
- 何时发言；
- 选择什么工具；
- 如何解释结果；
- 下一局如何对待同一个人。

只影响措辞而不影响行为的字段，不得被宣传为深层人格。

## 4.4 欺骗要成为有成本的真实策略

Agent 可以撒谎，但不能把“会撒谎”写成每轮随机反转事实。

欺骗系统必须包含：

- 私有真实信念；
- 对外主张；
- 欺骗目标；
- 目标受众；
- 预期收益；
- 被揭穿风险；
- 与历史说法的一致性；
- 道德或情绪成本；
- 需要维护的谎言链；
- 被揭穿后的羞耻、愤怒、辩解或策略调整。

```ts
interface DeceptionPlan {
  id: string;
  trueBelief: string;
  publicClaim: string;
  audienceIds: string[];
  objective: string;
  risk: number;
  psychologicalCost: number;
  consistencyRefs: string[];
  status: "planned" | "active" | "abandoned" | "exposed" | "succeeded";
}
```

## 4.5 反思和心智推断的正确实现

反思和读心可以保留，但必须改为同一 Agent 的内部 pass。

推荐：

```ts
interface ReflectionResult {
  mistakenAssumptions: string[];
  unresolvedQuestions: string[];
  strategyAdjustments: string[];
  selfNarrativeUpdate?: string;
}

interface TheoryOfMindResult {
  targetId: string;
  likelyGoals: string[];
  likelyBeliefs: string[];
  likelyNextActions: string[];
  confidence: number;
  uncertaintyNotes: string[];
}
```

这些结果写回该 Agent 的私有状态，并在必要时产生可视化的 `ThoughtBeat`，但不创建任何专家 Agent。

---

# 5. 长期运行、上下文预算与自动压缩

## 5.1 上下文管理是 Agent 的基本能力

任何真实 Agent 都会在长时间运行中超过模型上下文窗口。因此本项目必须默认启用上下文管理，不能把它作为高级选项，也不能要求用户自己猜阈值。

每个 Agent 独立维护上下文预算。不同模型、不同 Agent、不同房间不得共用一个估算值。

## 5.2 模型可用预算计算

不要用 `contextWindow × ratio` 直接当全部输入预算。

必须预留：

- 最大输出；
- 工具调用参数；
- 工具返回；
- 系统指令；
- 当前观察；
- 安全余量。

```ts
interface ContextBudget {
  contextWindow: number;
  reservedOutputTokens: number;
  reservedToolTokens: number;
  reservedSystemTokens: number;
  safetyMarginTokens: number;
  usableInputTokens: number;
  currentInputTokens: number;
  pressureRatio: number;
}
```

```text
usableInputTokens =
  contextWindow
  - reservedOutputTokens
  - reservedToolTokens
  - reservedSystemTokens
  - safetyMarginTokens
```

优先使用提供商返回的真实 usage 或准确 tokenizer；无法获得时才使用启发式估算。

## 5.3 默认自动阈值

产品必须默认开启多级上下文压力管理；用户不进入高级设置也能安全长期运行。模型档案或单 Agent 可以覆盖，但默认值必须存在：

| 阶段 | 默认压力 | 行为 |
|---|---:|---|
| `normal` | `< 55%` | 正常检索与运行 |
| `watch` | `55%—65%` | 显示压力，去除重复注入，准备巩固 |
| `retrieval-tight` | `65%—72%` | 缩小检索 topK，去重低显著性记忆 |
| `soft-compact` | `72%—82%` | 在回合或阶段边界压缩已完成的旧情节 |
| `deep-compact` | `82%—90%` | 结构化整合事实、关系、承诺、计划与反证 |
| `emergency` | `90%—95%` | 只保留固定事实、当前执行位置和近期原文，立即压缩 |
| `hard-guard` | `>= 95%` | 未降压前禁止调用主模型；失败则暂停该 Agent，不得盲目超窗 |

成功压缩后必须把压力降到 `52%—58%`，不能只降到触发线下一点。必须设置迟滞和冷却，避免每个回合重复压缩。跨过更高等级时可以跳过冷却。

设置 UI 可以提供“自动”“保守”“平衡”“激进”“自定义”预设；默认选择“平衡自动”。所有预设最终都展开为每个 Agent 的明确数值。

## 5.4 多层记忆，而不是一段大摘要

每个 Agent 至少维护以下记忆层：

### 5.4.1 身份与规则记忆

永不被普通压缩覆盖：

- Character 核心身份；
- 当前 GameRole；
- 胜利条件；
- 世界规则；
- 工具权限；
- 已知秘密；
- 不可遗忘的用户或系统约束。

### 5.4.2 工作记忆

用于当前阶段：

- 最近对话；
- 当前观察；
- 活跃目标；
- 当前计划；
- 待回应问题；
- 尚未完成的工具链；
- 最近失败。

### 5.4.3 情节记忆

保留“何时、谁、做了什么、结果怎样、对我意味着什么”：

```ts
interface EpisodicMemory {
  id: string;
  occurredAt: string;
  turn: number;
  actors: string[];
  eventType: string;
  facts: string[];
  subjectiveMeaning: string;
  emotion: string;
  salience: number;
  confidence: number;
  sourceEventIds: string[];
}
```

### 5.4.4 语义与社会记忆

从多次情节中提炼：

- 某人通常是否守约；
- 某人的说话习惯；
- 某类策略的效果；
- 长期关系；
- 稳定偏好；
- 已形成的概念和规则理解。

### 5.4.5 程序与策略记忆

记录可复用技能：

- 如何在被公开指控时回应；
- 如何判断投票摇摆者；
- 哪类谈判开价对某人有效；
- 如何在特定角色下隐藏信息；
- 哪些工具序列容易失败。

### 5.4.6 自我叙事记忆

回答“我认为自己是怎样的人、最近发生的事如何改变了我”。它用于长期一致性，不直接替代具体事实。

### 5.4.7 链接记忆与重巩固

长期记忆不能只是互不相关的向量片段。新经历应能够与人物、承诺、冲突、地点、策略和旧经历建立链接：

```ts
interface MemoryLink {
  fromMemoryId: string;
  toMemoryId: string;
  kind:
    | "same-person"
    | "supports"
    | "contradicts"
    | "caused-by"
    | "resolved-by"
    | "similar-situation"
    | "promise-chain"
    | "deception-chain";
  weight: number;
  lastReinforcedAt: string;
}
```

记忆被再次检索并遇到新证据时，可以重巩固其主观意义、置信度和链接，但不能悄悄改写已经发生的世界事实。事实层保持稳定，解释层允许更新；冲突证据应并存并降低置信度，而不是让最新摘要覆盖旧真相。

## 5.5 不可压缩与固定事实

以下内容必须 pin：

- 当前角色和阵营；
- 胜利条件；
- 当前活跃承诺；
- 尚未完成的计划；
- 尚未回答的直接问题；
- 已提交但尚未揭示的行动；
- 关键调查结果；
- 工具返回的对象 ID；
- 活跃欺骗计划；
- 最近一次失败及其原因；
- 当前阶段所需行动；
- 用户手动固定的记忆。

压缩后必须验证这些字段仍存在。摘要写得流畅但丢失关键状态，视为压缩失败。

## 5.6 推荐压缩流水线

```text
1. 读取当前 ContextBudget
2. 标记不可压缩项目
3. 识别已完成、重复、低价值的历史片段
4. 从旧轨迹提取结构化事实、行动、结果和未完成事项
5. 写入情节记忆
6. 更新语义、关系和程序记忆
7. 生成短叙事摘要
8. 校验关键事实、行动位置和未完成事项
9. 替换旧工作上下文
10. 保存压缩检查点
11. 发出 context.compacted 事件
```

压缩必须保存“轨迹位置”，不能只写“过去发生了什么”。Agent 必须知道：

- 哪些行动已经完成；
- 当前正在做什么；
- 下一步是什么；
- 哪些操作不能重复；
- 何时应停止。

## 5.7 原生压缩与本地压缩

当使用支持 Responses compaction 的模型和提供商时，可通过 SDK 的原生 compaction session 处理会话项压缩。

但项目仍需保留本地结构化记忆层，因为：

- 不同提供商能力不同；
- 原生压缩不等于社会记忆；
- 角色、关系、承诺、未完成计划等需要显式结构；
- UI 需要展示压缩和记忆巩固过程；
- 本地模型必须能运行。

推荐策略：

```text
Provider-native compaction 可用
  → 用于压缩原始模型会话轨迹
  → 同时运行本地记忆巩固

Provider-native compaction 不可用
  → 使用本地结构化压缩器
  → 生成 session digest + layered memory
```

## 5.8 压缩失败处理

压缩不得成为单点故障。

失败顺序：

1. 重试一次轻量压缩；
2. 缩小待压缩块；
3. 使用确定性提取保留关键事实；
4. 丢弃可重建的重复 UI/流式碎片；
5. 保存完整检查点；
6. 暂停该 Agent 并向用户显示明确原因。

禁止：

- 静默清空会话；
- 随机删除历史；
- 继续发送超出窗口的请求；
- 换一个无关 Agent 接管；
- 假装压缩成功。

## 5.9 会话和房间持久化

当前仅内存会话不适合长久运行。

默认本地部署应提供持久化存储，推荐：

- SQLite 作为默认；
- 可选文件存储用于最小部署；
- 通过接口支持其他数据库；
- API Key 仍只保存在安全配置层，不写进房间快照。

必须持久化：

- 房间元数据；
- 世界状态；
- 每个 Agent 会话；
- 每个 Agent 分层记忆；
- 模型绑定快照；
- 角色分配；
- 工具调用结果；
- 上下文检查点；
- 观战事件；
- 播放进度与高光。

服务重启后应可恢复未结束房间，至少允许从最后安全检查点继续。

## 5.10 上下文状态必须可视化

选中 Agent 时显示：

- 当前模型上下文窗口；
- 已使用输入预算；
- 预计输出预留；
- 当前压力等级；
- 最近压缩时间；
- 压缩次数；
- 保留的最近原始回合；
- 分层记忆数量；
- 是否使用 provider-native compaction；
- 是否存在压缩错误。

这不是调试器堆数据。UI 应用清晰的环形预算、状态标签和记忆巩固动画表达。

---

# 6. 模型、提供商与参数配置

模型配置是 Agent 的一等能力，不能继续只保存一个模型字符串。

## 6.1 配置实体

### 6.1.1 ProviderProfile

```ts
interface ProviderProfile {
  id: string;
  name: string;
  kind: "openai" | "openai-compatible" | "local" | "custom";
  baseURL: string;
  apiKeyRef?: string;
  apiMode: "responses" | "chat-completions" | "auto";
  defaultHeaders?: Record<string, string>;
  organization?: string;
  project?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

Secret 只通过 `apiKeyRef` 引用安全存储，不能进入公开设置、SSE、房间快照或前端持久化状态。

### 6.1.2 ModelCapabilities

```ts
type CapabilityState = "yes" | "no" | "unknown";

interface ModelCapabilities {
  streaming: CapabilityState;
  tools: CapabilityState;
  parallelToolCalls: CapabilityState;
  reasoning: CapabilityState;
  reasoningSummary: CapabilityState;
  structuredOutput: CapabilityState;
  promptCaching: CapabilityState;
  nativeCompaction: CapabilityState;
  seed: CapabilityState;
  stopSequences: CapabilityState;
  imageInput: CapabilityState;
  maxOutputTokens: CapabilityState;
}
```

能力来自：

1. 提供商探测；
2. 内置已知档案；
3. 用户手动覆盖。

能力必须是三态，不能用一个布尔值把“未知”误当成“不支持”或“支持”。未知能力不得盲目发送参数；用户强制覆盖时，UI 必须明确标注“未验证”。原始隐藏思维链不是产品能力，不进入 capability matrix。

### 6.1.3 ModelProfile

```ts
interface ModelProfile {
  id: string;
  name: string;
  providerProfileId: string;
  modelId: string;
  contextWindow: number;
  contextWindowSource: "provider" | "known-profile" | "manual";
  maxUsableInputTokens?: number;
  capabilities: ModelCapabilities;
  defaults: ModelTuning;
  contextPolicyId: string;
  enabled: boolean;
}
```

### 6.1.4 ModelTuning

```ts
interface ModelTuning {
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  maxOutputTokens?: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "concise" | "detailed" | "off";
  verbosity?: "low" | "medium" | "high";
  toolChoice?: "auto" | "required" | "none" | string;
  parallelToolCalls?: boolean;
  truncation?: "auto" | "disabled";
  store?: boolean;
  seed?: number;
  stop?: string[];
  maxTurns?: number;
  requestTimeoutMs?: number;
  retryMaxAttempts?: number;
  retryInitialDelayMs?: number;
  promptCacheRetention?: "in-memory" | "24h" | "off";
  providerData?: Record<string, unknown>;
}
```

不是每个提供商都支持所有参数。解析器只向目标提供商发送明确支持或用户强制允许的字段。

## 6.2 AgentModelBinding

```ts
interface AgentUtilityModelBindings {
  summarizerModelProfileId?: string;
  embeddingModelProfileId?: string;
  rerankerModelProfileId?: string;
  ttsModelProfileId?: string;
  speechToTextModelProfileId?: string;
}

interface AgentModelBinding {
  defaultModelProfileId?: string;
  tuningOverrides?: Partial<ModelTuning>;
  contextPolicyId?: string;
  contextOverrides?: Partial<ContextPolicy>;
  utilityModels?: AgentUtilityModelBindings;
  phaseOverrides?: Partial<Record<CognitivePhase, {
    modelProfileId?: string;
    tuning?: Partial<ModelTuning>;
  }>>;
}
```

阶段覆盖是同一个 Agent 在不同内部认知阶段使用不同模型配置，不产生新的 Agent 身份，不创建主从关系，不改变其会话和记忆所有权。

`contextWindow` 是模型能力上限，不是可随意调大的生成参数。提供商没有返回元数据时，用户可以手工登记；运行时实际输入预算仍必须扣除输出、工具、系统提示和安全余量。单 Agent 的上下文覆盖用于选择更保守的软预算、压缩阈值和保留策略，不能伪装成模型拥有更大的真实窗口。

P0 必须实现：

- 全局默认模型；
- 房间统一模型；
- 单 Agent 模型覆盖；
- 单 Agent 参数覆盖。

阶段级模型覆盖属于高级能力，可在基础配置稳定后实现。

摘要、embedding、rerank、TTS 和语音识别模型属于 utility model，不是新的 Agent。它们没有游戏身份、目标、关系或行动权，不能替主决策模型选择世界行动。每个 Agent 可以继承全局 utility 配置，也可以单独覆盖；默认应支持本地或免费实现。

## 6.3 配置继承优先级

最终配置按以下顺序解析，越靠后优先级越高：

```text
系统安全默认值
  < ModelProfile 默认值
  < 全局 Agent 默认值
  < 世界/房间覆盖
  < 单 Agent 覆盖
  < 当前认知阶段覆盖
  < 运行时必须的安全限制
```

每个最终字段都应能说明来源：

```ts
interface ResolvedField<T> {
  value: T;
  source:
    | "system"
    | "model-profile"
    | "global"
    | "room"
    | "agent"
    | "phase"
    | "runtime-safety";
}
```

创建房间界面必须提供“查看最终生效配置”，而不是让用户猜继承结果。

## 6.4 必须支持统一配置和单 Agent 自定义

创建房间流程必须具有两个层次。

### 快速模式

用户选择：

- 一个统一模型；
- 推理强度；
- 上下文策略预设；
- 回合数；
- 人物和角色模板。

所有 Agent 默认继承统一设置。

### 高级阵容模式

每个参与者行显示：

- Character；
- 控制方式；
- 最终角色分配方式；
- 模型档案；
- 推理强度；
- 温度；
- 最大输出；
- 上下文策略；
- “继承统一设置”开关；
- 参数详情入口。

必须提供：

- 全部应用同一模型；
- 批量选择多行；
- 按顺序轮转模型；
- 随机分配模型；
- 保存阵容模板；
- 恢复默认；
- 复制某 Agent 配置到其他 Agent；
- 明确标识哪些 Agent 使用了覆盖。

不能继续只显示“模型 1、模型 2 按顺序轮转”而不给单个 Agent 精确控制。

## 6.5 模型配置 UI

设置页分为：

1. **提供商**：URL、密钥、API 模式、连接状态；
2. **模型档案**：模型 ID、上下文、能力、默认参数；
3. **全局 Agent 默认值**：新房间默认模型和参数；
4. **上下文策略**：阈值、保留项、原生压缩；
5. **运行限制**：并发、超时、重试、每 Agent 速率；
6. **导入导出**：不包含明文密钥的配置文件。

连接测试不能只测试 `/models`。模型档案探测至少可选择执行：

- 最小文本流；
- 工具调用；
- 结构化输出；
- reasoning summary；
- Responses API；
- 最大输出参数；
- usage 返回；
- native compaction。

探测失败只标记能力未知或不可用，不应删除用户配置。

## 6.6 模型参数与 Agent 行为的关系

模型参数不是只给开发者看的底层字段。

- `temperature` 影响表达和策略采样，但不应代替人格差异；
- `reasoningEffort` 影响复杂决策阶段的推理预算；
- `maxOutputTokens` 防止一名 Agent 无限制占据舞台；
- `maxTurns` 限制同一行动中的工具循环；
- `parallelToolCalls` 只在世界和工具语义允许时开启；
- `toolChoice` 可在强制行动阶段设为 required；
- `contextWindow` 直接决定该 Agent 的压缩预算；
- `requestTimeoutMs` 和 retry 策略必须按 Agent 独立生效；
- `reasoningSummary` 决定观战席能否展示提供商支持的思考摘要。

## 6.7 不得把模型配置和人物绑定死

Character 可以在不同模型上运行。

模型替换后，该人物的：

- 身份；
- 记忆；
- 关系；
- 人格；
- 角色；
- 视觉形象；
- 社会季历史

都应保持不变。

模型是大脑运行引擎，不是人物本身。

---

# 7. 角色、人物与房间阵容扩展

## 7.1 四个概念必须解耦

```ts
interface ParticipantSlot {
  slotId: string;
  characterId: string;
  controller: "ai" | "human";
  agentConfig?: AgentRuntimeConfig;
  roleAssignment?: "random" | "fixed";
  fixedRoleId?: string;
}
```

- Character：谁；
- Agent：如何感知、思考、记忆和行动；
- Model：使用哪一个模型及参数；
- Role：这局游戏里是什么身份。

任何代码把这四者合成一个 `profile` 大对象，都应逐步拆分。

## 7.2 CharacterDefinition

```ts
interface CharacterDefinition {
  id: string;
  displayName: string;
  pronouns?: string;
  avatar: CharacterAvatar;
  biography: string;
  values: Array<{ name: string; weight: number }>;
  traits: Record<string, number>;
  needs: Record<string, number>;
  socialStyle: SocialStyle;
  decisionBiases: DecisionBias[];
  voice: VoiceProfile;
  autobiographicalAnchors: AutobiographicalAnchor[];
  defaultMemorySeedIds: string[];
  tags: string[];
  builtIn: boolean;
}
```

P1 内置人物目标不少于 24 个，并保证行为结构有真实差异，而不是只换名字和语气。

必须允许用户：

- 新建人物；
- 编辑人物；
- 复制人物；
- 导入导出人物；
- 为人物生成或手写自传记忆；
- 选择头像；
- 重置长期记忆；
- 保留人物跨世界历史。

## 7.3 RoleDefinition

```ts
interface RoleDefinition {
  id: string;
  worldId: string;
  name: string;
  factionId: string;
  description: string;
  objective: string;
  knowledgePolicy: RoleKnowledgePolicy;
  activeAbilities: RoleAbilityDefinition[];
  passiveAbilities: RolePassiveDefinition[];
  winCondition: RoleWinCondition;
  revealPolicy: "hidden" | "on-death" | "endgame" | "public";
  playerCount: { min: number; max?: number };
  unique: boolean;
  balanceWeight: number;
  tags: string[];
  visual: RoleVisualDefinition;
}
```

角色能力通过世界规则注册工具和事件处理器，不通过 prompt 约定。

## 7.4 狼人杀角色系统

当前固定 6 人牌组必须升级为角色包与牌组模板。

推荐角色池至少支持：

### 狼人阵营

- 普通狼人；
- 狼王；
- 白狼王；
- 梦魇；
- 狼美人；
- 隐狼。

### 好人阵营

- 村民；
- 预言家；
- 女巫；
- 猎人；
- 守卫；
- 白痴；
- 骑士；
- 通灵师；
- 墓地守卫；
- 长老。

### 中立或第三阵营

- 小丑；
- 丘比特；
- 盗贼；
- 野孩子；
- 吹笛者。

这些是可配置角色模块，不要求一次全部上线，也不能照搬互相冲突的桌游规则。每个角色必须在 `RoleDefinition` 中明确能力时机、目标限制、胜利条件、揭示策略和 UI 表现。

内置牌组模板建议包括：

- 6 人快速局；
- 8 人标准局；
- 9 人标准局；
- 10 人进阶局；
- 12 人多能力局。

房间创建器必须在用户选择冲突角色或不合理数量时给出清楚警告。

## 7.5 阿瓦隆角色扩展

应支持模块化角色：

- 梅林；
- 派西维尔；
- 忠臣；
- 莫甘娜；
- 刺客；
- 莫德雷德；
- 奥伯伦；
- 爪牙；
- 可选湖中仙女机制。

同样必须由规则和工具实现知识与能力，不能只在提示中告诉模型“你可以做某事”。

## 7.6 角色编辑器

长期方向应允许用户创建自定义角色包：

- 阵营；
- 初始知识；
- 可用阶段；
- 主动能力；
- 被动触发；
- 目标过滤；
- 次数；
- 冷却；
- 公开或私有结果；
- 胜利条件；
- 角色图标和颜色；
- 观战特效。

第一版可通过 JSON/TypeScript 定义，后续再做可视化编辑器。

## 7.7 玩家规模

近期优先稳定支持 2—12 名参与者，并让角色、UI、并发和上下文策略都不再假定最多 8 人。

后续支持 20 名以上时，必须先完成：

- 并发背压；
- 分组讨论；
- 视野过滤；
- 批量上下文巩固；
- UI 聚合；
- 事件优先级；
- 提供商限流适配。

不能只把 `players` 数字改大。

---

# 8. 第三视角观战与高级 UI

## 8.1 目标体验

用户打开房间后，应感觉自己进入了一个正在直播的 AI 社会竞技场，而不是打开了一个运维仪表盘。

核心感受是：

- 我知道现在谁是焦点；
- 我能看到冲突怎样形成；
- 我能理解 Agent 为什么犹豫或出手；
- 我能看到工具行动真实发生；
- 我能追踪关系和怀疑变化；
- 我能在高潮时刻得到明确的视觉和节奏反馈；
- 我不用同时盯三个滚动面板寻找重点。

## 8.2 舞台优先布局

桌面端推荐结构：

```text
┌──────────────────────────────────────────────────────────────┐
│ 顶部 HUD：世界 / 阶段 / 回合 / 存活 / 播放速度 / 观战模式   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                   中央主舞台 / 圆桌 / 对峙                   │
│        玩家席位、发言焦点、目标连线、角色行动动画             │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ 当前对白 + Thought Beat + Tool Trace + 高潮字幕               │
├──────────────────────────────────────────────────────────────┤
│ 时间线：事件节点 / 投票变化 / 背叛 / 淘汰 / 回放              │
└──────────────────────────────────────────────────────────────┘

侧边抽屉：选中 Agent 心智、关系网、战况、模型与上下文详情
```

三栏信息仍可保留为“分析视图”，但默认观战入口必须是舞台视图。

## 8.3 观战模式

必须支持四种信息权限明确的模式：

### 公开观战

- 不显示存活角色的隐藏身份；
- 不显示私聊和阵营频道；
- 不显示私有信念和计划；
- 可显示不剧透的情绪和公开行为摘要。

### 全知第三视角

- 显示角色；
- 显示所有频道；
- 显示 Agent 的结构化思考摘要；
- 显示工具输入、结果和世界影响；
- 显示真实信念与公开主张的差异；
- 适合用户纯观看 AI 对决。

### 单 Agent 视角

- 只显示该 Agent 能看到的信息；
- 只显示该 Agent 的私有心智；
- 世界和其他 Agent 信息按其视野过滤；
- 适合体验“跟着一个 Agent 走”。

### 终局回放

- 游戏结束后允许解锁全知时间线；
- 展示关键误判、谎言链、调查、投票转折和角色真相；
- 可从任一高光节点重播。

真人玩家在对局进行时默认不能切换到会泄露隐藏信息的模式。

## 8.4 显示 Agent 思考的正确方式

“显示思考”必须区分四类信息，不能全部混成一段滚动文本。

### A. Provider Reasoning Summary

模型或提供商明确返回的推理摘要。

UI 标签示例：

- “模型推理摘要”；
- “Reasoning Summary”；
- “提供商返回”。

只有提供商真实返回时显示。未返回时不能伪造。

### B. ThoughtBeat

同一个 Agent 主动产出的、用于观战的结构化心智节拍。

```ts
type ThoughtBeatKind =
  | "notice"
  | "recall"
  | "doubt"
  | "goal"
  | "hypothesis"
  | "conflict"
  | "plan"
  | "decision"
  | "regret"
  | "realization";

interface ThoughtBeat {
  id: string;
  roomId: string;
  agentId: string;
  activationId: string;
  kind: ThoughtBeatKind;
  title: string;
  summary: string;
  confidence?: number;
  targetIds?: string[];
  memoryIds?: string[];
  visibility: "private" | "omniscient" | "postgame" | "public";
  createdAt: string;
}
```

ThoughtBeat 不是完整隐藏思维链，而是可展示的真实结构化认知结果，例如：

- “我注意到林默连续两次避开直接回答”；
- “上一局他在同样压力下背叛过我”；
- “我在胜利和保住盟友之间犹豫”；
- “我准备先问一个可验证的问题”；
- “调查结果与我的公开立场冲突”。

### C. Memory Activity

显示：

- 检索了哪段经历；
- 为什么相关；
- 记忆可信度；
- 是否发生巩固、合并或遗忘；
- 压缩后形成了什么记忆条目。

不需要展示完整 prompt。

### D. ToolTrace

显示 Agent 从决定到世界结果的行动链。

```ts
interface ToolTrace {
  id: string;
  roomId: string;
  activationId: string;
  agentId: string;
  toolName: string;
  label: string;
  phase: "queued" | "started" | "streaming" | "succeeded" | "failed";
  safeInputSummary?: string;
  safeOutputSummary?: string;
  worldEffect?: string;
  errorCode?: string;
  startedAt?: string;
  finishedAt?: string;
  visibility: "public" | "private" | "team" | "omniscient" | "postgame";
}
```

工具调用不再只是右侧日志。它应出现在舞台上：

- 投票时出现目标锁定；
- 查验时出现私有行动轨迹；
- 私聊时显示通道连线；
- 出价时显示密封提交；
- 工具失败时显示明显但不过度打断的失败状态；
- 结算后显示真实世界影响。

## 8.5 原始隐藏思维链不得进入产品界面

用户要求“看到 Agent 在想什么”是合理的，但产品必须展示 **真实、结构化、可理解、可跨模型运行的思考产物**，而不是依赖某个提供商偶然暴露的隐藏 token 流。

硬约束：

1. 提供商正式返回 reasoning summary 时，可以按来源标识后展示；
2. 每次重要激活应由同一个 Agent 输出 `ThoughtBeat` 或等价的结构化决定摘要；
3. 记忆检索、信念变化、候选行动、最终决定和工具轨迹必须来自实际运行事件；
4. 原始 `reasoning_content`、完整 chain-of-thought、内部系统提示和未脱敏工具参数不得进入 SSE、日志、回放、检查点或前端状态；
5. 没有 summary 时，UI 显示 ThoughtBeat、Memory Activity、ToolTrace 和世界结果，不能伪造“模型内心独白”；
6. ThoughtBeat 必须在行动当次生成，并关联 `activationId`、真实记忆 ID、目标 ID 或事件 ID，不能由观战导演事后编故事。

结构化思考摘要比 raw reasoning 更适合产品，因为它可跨 OpenAI-compatible、本地模型和不同 API 模式保持一致，也更容易控制长度、权限和剧透范围。观战导演只负责呈现，不能制造 Agent 没有产生的理由。

## 8.6 自动观战导演

导演基于真实事件计算张力，不读取不存在的信息。

```ts
interface TensionSignal {
  eventId: string;
  score: number;
  reasons: Array<
    | "direct-accusation"
    | "contradiction"
    | "betrayal"
    | "alliance-break"
    | "vote-swing"
    | "role-action"
    | "deception-exposed"
    | "save"
    | "elimination"
    | "win-condition-near"
    | "emotional-spike"
  >;
  primaryAgentIds: string[];
}
```

张力分数只控制镜头和节奏，不控制游戏。

导演规则示例：

- 两名 Agent 连续互相指控：进入对峙镜头；
- 某人公开发言与私有信念明显相反：全知模式显示“正在伪装”；
- 投票结果发生领先者变化：触发票型翻转提示；
- 关键角色使用能力：进入角色行动镜头；
- 谎言被事实击穿：短暂停顿并回放相关旧发言；
- 盟友投向对方：关系线断裂；
- 淘汰或终局：使用完整结算动画和身份揭晓。

## 8.7 “爽感”来自真实因果的强化

爽感不是粒子特效越多越好，而是关键因果被及时放大。

必须优先强化：

- 谁攻击了谁；
- 为什么这句话危险；
- 某个怀疑如何逐步升高；
- 一次工具行动如何改变局势；
- 投票是怎样翻转的；
- 谁背叛了旧盟友；
- 哪段记忆推动了当前决定；
- 哪个谎言终于被揭穿；
- 哪个 Agent 犹豫后做了高风险选择；
- 终局真相与之前公开叙事有何反差。

每个高潮节点都应可点击展开前因后果。

## 8.8 对峙镜头

当两个 Agent 形成直接冲突时，进入 Duel View：

- 双方头像与当前情绪；
- 各自公开主张；
- 观众模式允许时显示私有真实判断；
- 双方置信度变化；
- 彼此关系和怀疑变化；
- 被引用的历史发言；
- 正在使用的工具；
- 其他玩家的站队倾向。

对峙结束后自然回到主舞台，不能让用户手动关闭一堆弹窗。

## 8.9 播放与节奏控制

必须支持：

- 自动导演；
- 手动镜头；
- 暂停；
- 0.5×、1×、2×、4×；
- 自动跳过无新信息等待；
- 高张力时自动回到 1×；
- 逐事件前进；
- 回看最近 10 秒或最近一个事件；
- 跳转高光；
- 终局高光合集；
- 关闭自动特效；
- Reduced Motion。

模型还在思考时，UI 应显示真实阶段：

- 正在读取局势；
- 正在回忆；
- 正在权衡；
- 正在调用工具；
- 等待世界结算；
- 正在巩固记忆。

阶段来自运行时事件，不得用随机计时器伪装。

## 8.10 视觉设计原则

默认风格应是高级、克制、戏剧化，而不是一屏相同的灰色 Card。

要求：

- 中央舞台具有明确视觉焦点；
- 玩家有可辨识头像、席位、状态轮廓和阵营揭晓效果；
- 公开、私聊、阵营频道有不同但统一的视觉语言；
- 字体层级清晰；
- 动画有进入、持续和结束状态；
- 颜色表达阵营、情绪、工具状态和信息权限，但不依赖颜色作为唯一信号；
- 移动端重新编排为舞台 + 底部抽屉，而不是强行压缩三栏；
- 所有高强度动画支持关闭；
- 避免模板化后台、过多小边框、无意义渐变、到处发光和持续抖动。

## 8.11 头像和角色美术

内置人物需要统一风格的高质量头像或半身像，并支持：

- 表情状态；
- 存活/淘汰状态；
- 角色揭晓覆盖层；
- 说话口型或轻微呼吸动效；
- 被指控、思考、行动、震惊等有限状态；
- 用户自定义头像。

美术表现不能影响世界规则，也不能依据隐藏身份提前泄露信息。


## 8.12 不同世界必须有不同的舞台语言

统一设计系统不等于所有世界套同一张 Card。

### 隐藏身份世界

狼人杀和阿瓦隆应强调：

- 围桌席位；
- 发言焦点；
- 怀疑和联盟连线；
- 私密行动的遮蔽与全知模式揭示；
- 投票盘；
- 身份揭晓；
- 角色能力的专属镜头。

### 谈判世界

谈判、最后通牒和信任博弈应强调：

- 双方分屏；
- 当前条款；
- 历史报价轨迹；
- 各自公开底线与全知模式下的真实底线；
- 让步幅度；
- 即将成交或谈崩的压力条；
- 承诺与违约记录。

### 风险升级世界

吹牛骰、蜈蚣、胆小鬼和猎鹿应强调：

- 风险随回合上升；
- 当前可得收益；
- 继续与退出的临界点；
- Agent 的犹豫和置信变化；
- 最终揭示或碰撞时的集中爆发。

### 秘密提交世界

公共品、选美和密封拍卖应强调：

- 所有人已提交但结果未揭示的悬念；
- 不显示具体秘密值；
- 统一揭示动画；
- 结果分布；
- Agent 预期与真实群体结果之间的偏差；
- 下一轮策略调整。

每个世界都需要自己的高光检测规则，但高光只能来自真实世界事件。

## 8.13 高级 UI 的实施路线

优先做可稳定交付的 2D/2.5D 竞技场，不要一开始就把项目拖进重型全 3D。

推荐分层：

```text
World / Agent events
  → Spectator projection
  → TensionEngine
  → CinematicCue queue
  → Camera state machine
  → Arena renderer + audio director + timeline
```

实现要求：

- React 组件只消费事件和派生视图状态，不直接猜测 Agent 行为；
- 头像、席位、关系线、投票盘和目标指向优先使用 DOM/SVG；
- 大规模关系网络、粒子或特殊世界效果可按需使用 Canvas/WebGL；
- 镜头切换、卡片进退场、关系断裂和投票翻转使用统一 motion tokens；
- 声音分为 ambience、UI feedback、dramatic sting 三层，默认可关闭并遵守浏览器自动播放限制；
- `CinematicCue` 必须可中断、可合并、可跳过，低优先级动画不能阻塞高优先级淘汰或终局；
- 60 FPS 目标下，主舞台不得因完整时间线或大型 Agent 状态重新渲染；
- SSE 高频 delta 先在客户端缓冲聚合，再按动画帧刷新；
- 长局时间线必须虚拟化；
- 移动端以单焦点舞台和底部抽屉为主，不缩小桌面布局；
- Reduced Motion、静音、低性能模式必须是正式能力。

视觉升级优先级：

1. 信息层级和主舞台；
2. 真实事件驱动的镜头；
3. ThoughtBeat 与 ToolTrace 的舞台化；
4. 对峙、投票、角色行动和终局的专属序列；
5. 音效与高光回放；
6. 最后才考虑重型 3D。

---

# 9. 事件系统：让 Agent 行为可以被产品化展示

## 9.1 统一事件信封

```ts
interface SocietyEventEnvelope<T = unknown> {
  id: string;
  roomId: string;
  sequence: number;
  type: string;
  actorId?: string;
  targetIds?: string[];
  activationId?: string;
  turn: number;
  phase: string;
  visibility: "public" | "private" | "team" | "omniscient" | "postgame";
  payload: T;
  createdAt: string;
}
```

所有 UI、回放和导演都消费这一事件流。不要让各组件分别猜测世界对象发生了什么。

## 9.2 必须支持的事件族

### Agent 生命周期

- `agent.created`；
- `agent.ready`；
- `agent.phase.changed`；
- `agent.thought`；
- `agent.memory.recalled`；
- `agent.memory.consolidated`；
- `agent.context.pressure`；
- `agent.context.compacted`；
- `agent.error`；
- `agent.paused`；
- `agent.resumed`。

### 模型调用

- `model.request.started`；
- `model.text.delta`；
- `model.reasoning.summary.delta`；
- `model.usage`；
- `model.retry`；
- `model.request.failed`；
- `model.request.completed`。

### 工具

- `tool.queued`；
- `tool.started`；
- `tool.output.delta`；
- `tool.succeeded`；
- `tool.failed`；
- `tool.world-effect`。

### 社交

- `message.sent`；
- `message.replied`；
- `accusation`；
- `defense`；
- `promise.made`；
- `promise.kept`；
- `promise.broken`；
- `alliance.formed`；
- `alliance.broken`；
- `deception.claimed`；
- `deception.exposed`；
- `relationship.changed`；
- `belief.changed`；
- `emotion.changed`。

### 世界

- `activation.opened`；
- `action.intent.submitted`；
- `action.committed`；
- `vote.revealed`；
- `role.action.resolved`；
- `participant.eliminated`；
- `phase.changed`；
- `round.completed`；
- `game.finished`。

### 观战

- `cinematic.cue`；
- `highlight.created`；
- `replay.marker`；
- `tension.changed`。

## 9.3 事件必须有稳定 ID 和顺序

当前依赖时间和数组位置的展示方式不够。

事件必须有：

- 唯一 ID；
- 房间内单调递增 `sequence`；
- 发生时间；
- 逻辑回合和阶段；
- 可见性；
- 来源事件关联。

这样才能实现：

- SSE 断线续传；
- 重启恢复；
- 时间线；
- 点击追溯；
- 高光回放；
- 工具调用和世界结果关联；
- 对话 replyTo 稳定引用。

## 9.4 SSE 只发增量，恢复走检查点

长期房间不能每次更新都发送越来越大的完整快照。

推荐：

- 首次连接：最近检查点 + 之后事件；
- 正常运行：增量事件；
- 客户端定期校验 sequence；
- 丢失事件：按 `afterSequence` 补拉；
- 大型心智和记忆内容按需请求；
- 私有数据按观战权限投影。

---

# 10. 关键类型与数据边界

以下类型是目标方向，实际实现可分阶段迁移，但含义不得被削弱。

## 10.1 AgentDefinition

```ts
interface AgentDefinition {
  id: string;
  characterId: string;
  controller: "ai";
  modelBinding: AgentModelBinding;
  contextPolicyId: string;
  memoryPolicyId: string;
  toolPolicyId: string;
  enabled: boolean;
}
```

## 10.2 AgentRuntimeState

```ts
interface AgentRuntimeState {
  agentId: string;
  roomId: string;
  sessionId: string;
  status:
    | "idle"
    | "perceiving"
    | "recalling"
    | "thinking"
    | "speaking"
    | "acting"
    | "waiting"
    | "consolidating"
    | "paused"
    | "error";
  mind: AgentMindState;
  context: ContextBudget;
  effectiveModel: ResolvedModelConfig;
  lastCheckpointAt?: string;
  lastError?: AgentRuntimeError;
}
```

## 10.3 AgentMindState

```ts
interface AgentMindState {
  identity: AgentIdentityState;
  affect: AgentAffectState;
  needs: AgentNeedState;
  attention: AgentAttentionState;
  activeGoals: AgentGoalState[];
  beliefs: SocialBelief[];
  relationships: AgentRelationshipState[];
  activePlans: AgentPlanState[];
  deceptions: DeceptionPlan[];
  selfNarrative: AgentSelfNarrative;
  traitAdaptations: Record<string, TraitState>;
}
```

大型记忆条目不应全部嵌进每个实时快照，只在需要时查询。

## 10.4 ContextPolicy

```ts
interface ContextPolicy {
  id: string;
  name: string;
  mode: "automatic" | "custom";
  watchRatio: number;                 // default 0.55
  retrievalTightRatio: number;        // default 0.65
  softCompactRatio: number;           // default 0.72
  deepCompactRatio: number;           // default 0.82
  emergencyRatio: number;             // default 0.90
  hardLimitRatio: number;             // default 0.95
  targetAfterCompactionMin: number;   // default 0.52
  targetAfterCompactionMax: number;   // default 0.58
  recentTurnsToKeep: number;
  recentRawMessagesToKeep: number;
  recentToolResultsToKeep: number;
  maxRetrievedMemoryTokens: number;
  reservedOutputTokens: number | "auto";
  reservedToolTokens: number | "auto";
  safetyMarginTokens: number | "auto";
  compactionCooldownActivations: number;
  tokenizer: "provider" | "local" | "heuristic";
  heuristicSafetyMultiplier: number;  // default >= 1.15
  useNativeCompaction: "auto" | "always" | "never";
  verifyPinnedFacts: boolean;
  consolidateDuringIdle: boolean;
}
```

每个 Agent 保存自己的策略副本和运行统计。`hardLimitRatio` 触发后，在压缩成功之前不得继续调用主模型。

## 10.5 RoleDefinition

角色定义见第 7 节。每个世界只能通过该定义或等价的类型化插件系统扩展角色，不允许在一个巨大 `switch` 中不断硬编码。

## 10.6 CinematicCue

```ts
type CameraMode =
  | "wide-table"
  | "speaker"
  | "duel"
  | "agent-mind"
  | "tool-action"
  | "vote-board"
  | "relationship"
  | "role-reveal"
  | "endgame";

interface CinematicCue {
  id: string;
  roomId: string;
  sourceEventIds: string[];
  camera: CameraMode;
  focusAgentIds: string[];
  priority: number;
  minimumDurationMs: number;
  maximumDurationMs: number;
  title?: string;
  subtitle?: string;
  effect?: string;
  sound?: string;
  skippable: boolean;
  createdAt: string;
}
```

`CinematicCue` 由真实事件推导，可重新生成，不是世界真相的一部分。

---

# 11. 按文件实施的改造要求

## 11.1 `src/society/participant.ts`

必须做：

- 删除 manager Agent 定义；
- 删除 specialist sub-agents；
- 删除 `Agent.asTool()` 认知专家；
- 将类重命名为能表达并列主体的名字，例如 `AutonomousSocietyAgent` 或 `PeerSocietyAgent`；
- 每个参与者只保留一个逻辑 Agent；
- 统一 discussion 与 domain action 的身份和会话；
- 引入 `ResolvedModelConfig`；
- 引入独立 `ContextPolicy`；
- 发出结构化 `ThoughtBeat`、`ToolTrace`、memory 和 context 事件；
- 保持工具调用是唯一世界写入通道；
- 失败后由同一 Agent 接收错误并重新决定。

不允许简单把变量名从 `manager` 改成 `peer`，但内部仍保留三个 Agent。

## 11.2 `src/society/cognition.ts`

必须从“创建认知 Agent 工具”改为“同一 Agent 的内部认知服务”。

建议拆分：

```text
src/society/cognition/
  perception.ts
  attention.ts
  appraisal.ts
  belief-updater.ts
  theory-of-mind.ts
  motivation.ts
  planning.ts
  reflection.ts
  thought-beat.ts
  index.ts
```

每个模块输入只包含当前 Agent 有权看到的内容。

## 11.3 `src/society/context-manager.ts`

必须升级为：

- 动态预算计算；
- 多级阈值；
- pinned facts；
- 结构化记忆巩固；
- provider-native compaction adapter；
- 本地 fallback；
- 压缩完整性验证；
- 检查点；
- 失败降级；
- 独立 Agent 状态事件；
- 可持久化 session store。

现有单段摘要逻辑可以保留为 fallback 的一个步骤，不能再是完整方案。

## 11.4 `src/society/contracts.ts`

必须拆清：

- Character；
- Agent definition；
- Runtime state；
- Model profile；
- Provider profile；
- Model binding；
- Context policy；
- Role definition；
- Thought beat；
- Tool trace；
- Society event；
- Spectator cue。

避免一个巨大共享文件无限增长。可逐步迁移到 `contracts/` 目录，并在 `index.ts` 统一导出。

## 11.5 `src/society/profiles.ts`

当前人物和模型绑定方式必须解耦。

改造为：

```text
src/society/characters/
  builtins.ts
  schema.ts
  repository.ts
  autobiography.ts

src/society/models/
  providers.ts
  profiles.ts
  resolver.ts
  capabilities.ts
```

`createAgentProfiles(models, count)` 这类把模型分配和人物创建绑在一起的入口应废弃。

## 11.6 `src/society/room.ts`

必须支持：

- Provider registry；
- Model profile registry；
- 每 Agent 模型解析；
- 每 Agent 独立 provider/model binding；同一提供商可安全共享无状态客户端和连接池；
- ActionIntent + atomic commit；
- 房间检查点；
- 恢复；
- 增量事件；
- 观战权限投影；
- Director event feed；
- 并发和提供商限流；
- 单 Agent 暂停与恢复，而不是整个房间直接崩溃。

房间仍是调度器，不得成为中央智能体。

## 11.7 `src/society/world.ts`

必须保持为规则层：

- 观察投影；
- 频道权限；
- 工具权限；
- 意图校验；
- 提交和结算；
- 事实事件。

不要把模型配置、人物自传、UI 镜头或 Agent 认知写进 World。

## 11.8 `src/society/scenarios/werewolf.ts`

必须逐步移除：

- 固定 6 人假设；
- 固定四角色 union；
- 写死牌组；
- 角色工具散落在一个大类；
- 与具体角色数量耦合的胜负逻辑。

目标是角色插件 + 牌组模板 + 能力时机系统。

## 11.9 其他场景

现有 13 个世界应保留，不要为了扩角色先删除其他场景。

所有世界逐步统一：

- `RoleDefinition` 或 world-specific position definition；
- 冻结观察；
- ActionIntent；
- 提交/揭示；
- 真实工具事件；
- 观战事件；
- 同一 Agent 认知循环。

## 11.10 `src/server/settings.ts`

从单一 `ProviderSettings` 升级为：

- 多 ProviderProfile；
- 多 ModelProfile；
- 加密或受限 Secret Store；
- 能力探测结果；
- 全局默认模型；
- ContextPolicy；
- 并发和超时设置；
- 不含密钥的导入导出。

不要再把所有模型和上下文信息塞进逗号分隔环境变量作为主要产品配置。环境变量可作为首次启动和无 UI 部署的兼容入口。

## 11.11 `src/components/society/create-room.tsx`

必须重构为房间编排器：

- 世界；
- 牌组；
- 玩家规模；
- Character 阵容；
- 真人/AI；
- 统一模型；
- 每 Agent 模型覆盖；
- 上下文策略；
- 推理参数；
- 观战模式；
- 社会季模式；
- 最终配置检查。

默认流程保持简单，高级配置用展开区或单独步骤，不要把所有参数一次堆到一个弹窗。

## 11.12 `src/components/society/room-view.tsx`

必须从固定三栏容器升级为视图路由与舞台外壳：

- `ArenaView`；
- `DuelView`；
- `AgentMindView`；
- `RelationshipView`；
- `ReplayView`；
- `AnalysisView`。

默认 `ArenaView`，原三栏可迁移为 `AnalysisView`。

## 11.13 `conversation.tsx`

不再只是消息列表。

需要支持：

- 发言焦点；
- reply chain；
- 引用历史；
- ThoughtBeat；
- 工具轨迹；
- 对峙段落；
- 高潮字幕；
- 渐进流式文本；
- 观战权限过滤；
- 自动滚动与手动锁定；
- 消息稳定 ID。

## 11.14 `participants.tsx`

参与者卡应升级为舞台席位和可选中角色：

- 头像；
- 状态；
- 说话；
- 思考阶段；
- 情绪；
- 存活；
- 关系提示；
- 当前模型徽标；
- 上下文压力；
- 工具行动；
- 角色揭晓。

卡片不能默认暴露不该公开的角色或私有状态。

## 11.15 `world-panel.tsx`

拆成按需抽屉：

- 战况；
- 投票；
- 角色行动；
- 关系；
- 怀疑；
- 工具；
- 模型与上下文；
- 事件时间线。

不要继续把所有数据塞进一个右栏。

## 11.16 `src/components/society/settings-dialog.tsx`

当前只配置 Base URL、密钥和模型 ID 的形态必须升级为正式模型配置中心：

- Provider Profiles；
- Model Profiles；
- capability 状态；
- context window 与 max output；
- sampling、reasoning、tool、timeout、retry；
- ContextPolicy 预设；
- utility model 绑定；
- 连接与最小能力探测；
- 不含明文密钥的导入导出。

不支持的参数必须禁用或明确提示，不能在 UI 看起来已生效、请求时却被静默忽略。不得加入费用、套餐或购买入口。

## 11.17 `src/components/society/use-room.ts`

必须从零散字符串状态升级为规范化事件 reducer：

- 按 `eventId`、`sequence`、`activationId` 去重和排序；
- 聚合同一 Agent 的 ThoughtBeat、MemoryActivity、ToolTrace、发言和世界结果；
- 支持 SSE cursor 重连；
- 支持 presentation queue、暂停、倍速和回放；
- 将低价值 token delta 与必须保留的工具完成、世界结算和上下文状态分开；
- 不从 provider 原始事件临时猜测产品语义；
- 不把全知数据放入普通玩家状态后再靠组件隐藏。

## 11.18 新增建议目录

```text
src/society/
  agents/
    autonomous-agent.ts
    cognition-runtime.ts
    model-binding.ts
    context-runtime.ts
  characters/
  roles/
  models/
  memory/
  events/
  persistence/
  spectator/
    tension-engine.ts
    cinematic-director.ts
    highlight-builder.ts

src/components/society/
  arena/
  agent-mind/
  duel/
  replay/
  timeline/
  model-config/
  role-composer/
```

目录不是强制一次完成，但模块边界必须向此方向收敛。

---

# 12. 房间创建和运行数据流

## 12.1 创建房间请求

目标请求结构示例：

```ts
interface CreateSocietyRoomInput {
  scenarioId: string;
  rounds: number;
  seasonMode: "season" | "one-shot";
  spectatorMode: "public" | "omniscient" | "agent-pov";

  globalAgentDefaults: {
    modelProfileId: string;
    contextPolicyId: string;
    tuning?: Partial<ModelTuning>;
  };

  participants: Array<{
    slotId: string;
    characterId: string;
    controller: "ai" | "human";
    modelBinding?: AgentModelBinding;
  }>;

  roleDeck: {
    templateId?: string;
    roleIds?: string[];
    assignment: "random" | "fixed";
    fixedAssignments?: Record<string, string>;
  };
}
```

## 12.2 创建时解析

服务器必须：

1. 校验场景和玩家数量；
2. 校验角色牌组；
3. 解析每个 Agent 的最终模型；
4. 检查模型能力是否满足所需工具；
5. 计算每个 Agent 的上下文策略；
6. 创建独立 session；
7. 创建独立记忆命名空间；
8. 保存不可变房间配置快照；
9. 返回每个 Agent 的生效模型摘要；
10. 开始世界。

创建后改变全局模型默认值，不应偷偷改变已运行房间。房间内模型切换必须是显式操作，并保存切换事件。

## 12.3 Agent 单次激活

```text
Room 打开 activation
  → World 生成该 Agent 可见的冻结 Observation
  → Agent 计算 ContextBudget
  → 必要时压缩或检索记忆
  → Agent 运行内部认知循环
  → Agent 产生 ThoughtBeat
  → Agent 调用工具或选择合法沉默
  → 工具形成 ActionIntent / 即时 Commit
  → World 校验并结算
  → 事实事件广播
  → Agent appraise
  → 记忆巩固
  → 保存检查点
```

每一步都属于同一个 Agent，不得中途切换为专家 Agent。

## 12.4 模型切换

允许用户在暂停状态下给某个 Agent 切换模型。

切换必须：

- 保留 Agent 身份；
- 保留记忆；
- 保留世界角色；
- 保存旧模型与新模型；
- 重新计算上下文预算；
- 必要时先压缩；
- 向 UI 显示切换；
- 不把旧模型私有 provider 状态错误复用到不兼容的新模型。

---

# 13. 产品路线优先级

以下顺序高于继续增加新世界。

## P0：纠正 Agent 身份和运行基础

必须完成：

1. 移除 manager/sub-agent/council 架构；
2. 一个 AI 参与者 = 一个并列自治 Agent；
3. 反思、读心、规划改为内部认知阶段；
4. 多 ProviderProfile 与 ModelProfile；
5. 全局模型 + 房间覆盖 + 单 Agent 覆盖；
6. 完整模型参数与能力协商；
7. 默认自动上下文策略；
8. 多级压缩、固定事实和结构化记忆；
9. 会话与房间检查点持久化；
10. 稳定事件 ID、ThoughtBeat 和 ToolTrace。

P0 完成前，不再把新增“专家 Agent”或内部 agent-as-tool 当成功能扩展。

## P1：重做观战体验

必须完成：

1. 默认 ArenaView；
2. Agent 舞台席位；
3. 全知、公开、单 Agent、回放模式；
4. 思考、记忆、工具和行动统一时间线；
5. 自动导演和张力引擎；
6. Duel View；
7. 投票翻转、角色行动、背叛和淘汰高潮；
8. 播放速度、暂停、跳过等待和即时回放；
9. 高光生成；
10. 分析三栏降级为辅助视图。

## P2：提升人性和内容容量

必须完成：

1. 24+ 内置 Character；
2. Character 编辑器；
3. 自传式记忆；
4. 有限注意力；
5. 情境评价；
6. 多目标冲突；
7. 情绪和关系惯性；
8. 稳定认知偏差；
9. 有成本的欺骗计划；
10. 缓慢人格适应；
11. 狼人杀角色插件与多牌组；
12. 阿瓦隆角色扩展。

## P3：长期运行和规模

完成：

- 重启恢复；
- 长期社会季；
- 2—12 人稳定运行；
- 多房间并发；
- 提供商限流；
- Agent 级背压；
- 20+ 人分组场景；
- 本地模型优化；
- 低带宽增量事件；
- 回放归档。

## P4：生态扩展

在核心体验稳定后再做：

- 自定义角色包；
- 自定义世界插件；
- Character 分享；
- 阵容模板；
- 社区主题与美术包；
- 观战导演主题；
- 本地多人观看。

这些扩展仍然免费，不引入付费商店。

---

# 14. 产品级验收标准

## 14.1 Agent 验收

一个参与者功能只有在以下条件同时满足时才能标记完成：

- 是独立 Agent；
- 没有主从 Agent；
- 有独立 session；
- 有独立模型配置；
- 有独立记忆；
- 只看到合法信息；
- 使用真实工具；
- 能处理工具失败；
- 能保持跨回合状态；
- 能输出结构化 ThoughtBeat；
- 能在上下文压力下继续运行；
- 可保存和恢复。

## 14.2 模型配置验收

必须能够实际完成：

- 所有 Agent 使用统一模型；
- Agent A 使用模型 X、Agent B 使用模型 Y；
- 两个 Agent 使用同一模型但不同推理强度；
- 某 Agent 选择独立 ContextPolicy、有效输入预算和输出上限；
- UI 显示最终继承结果；
- 不支持的参数不会盲目发送；
- 提供商错误只影响相关 Agent；
- 切换模型后身份和记忆不丢失。

## 14.3 上下文验收

必须使用真实长对局验证：

- 自动触发 watch、soft、urgent 阶段；
- 角色和胜利条件不丢失；
- 未完成行动不重复；
- 关键承诺不丢失；
- 工具对象 ID 不丢失；
- 压缩失败有降级；
- 进程重启可从检查点恢复；
- UI 显示真实压力；
- 不同模型各自使用正确窗口。

## 14.4 观战验收

由真实模型对局检查：

- 用户在 5 秒内知道当前阶段和焦点人物；
- 关键工具行动在主舞台可见；
- 能从高潮节点追溯前因；
- 全知与公开模式不会串数据；
- 真人玩家不会看到隐藏信息；
- 对峙镜头由真实事件触发；
- 没有推理摘要时 UI 不伪造；
- 沉默阶段不会让界面像卡死；
- 长局时间线仍可操作；
- 移动端不依赖三栏。

## 14.5 人性验收

不能用固定预期台词判断。

应通过真实对局观察：

- 不同 Character 在相同局面下有不同注意力和策略；
- Agent 会保持沉默；
- 背叛会产生长期关系影响；
- 公开立场和私有信念可以不同；
- 人物不会因一条 prompt 突然完全换性格；
- 长局后人物不会全部变成同一种礼貌语气；
- 记忆会影响行动，而不只是被 UI 展示；
- Agent 会因错误调整计划；
- 情绪变化具有惯性；
- 人格变化缓慢且有事件原因。

## 14.6 真实质量检查规则

允许：

- 世界规则单元测试；
- RoleDefinition 校验测试；
- 模型配置继承测试；
- 权限投影测试；
- ContextPolicy 测试；
- 数据迁移测试；
- UI 组件交互测试；
- 真实 provider 冒烟对局；
- 长时间运行检查。

禁止：

- 把 mock LLM 对话当成真实 Agent 行为证明；
- 为了测试通过写死 Agent 台词；
- 用 LLM judge 分数代替产品体验；
- 在 README 宣称未经真实运行验证的性能；
- 建造庞大研究评测框架后仍缺少基本模型配置和 UI。

---

# 15. Coding Agent 工作规则

所有在仓库中工作的 Coding Agent 必须遵守。

## 15.1 开始前

1. 先阅读根 `AGENTS.md`；
2. 阅读将要修改的真实源文件；
3. 确认改动属于 Agent、世界、模型、记忆、事件、持久化或 UI 哪一层；
4. 不根据 README 宣传推断实现已经存在；
5. 不把研究概念直接复制进产品；
6. 不创建新的主从 Agent 结构。

## 15.2 设计时

必须回答：

- 这是哪个并列 Agent 的能力？
- 这个状态由谁拥有？
- 这个信息谁能看到？
- 这个动作是否经过真实工具？
- 失败后由谁处理？
- 是否会长期运行并超出上下文？
- 能否保存和恢复？
- UI 如何真实展示？
- 是否支持统一模型和单 Agent 覆盖？
- 是否在不收费的前提下工作？

## 15.3 禁止的代码模式

禁止新增：

```ts
managerAgent.asTool(subAgent)
```

禁止新增：

```ts
const expertAgent = new Agent(...)
const planningAgent = new Agent(...)
const reflectionAgent = new Agent(...)
```

用于同一玩家内部认知。

禁止让所有参与者共享：

```ts
const sharedSession = new MemorySession(...)
```

禁止用：

```ts
if (agentFailed) world.applyFallbackAction(...)
```

偷偷代填行动。

禁止把模型输出文本正则解析成绑定行动；必须使用 SDK 工具或结构化 action intent。

禁止在 UI 中用随机延迟和随机文案假装 Agent 正在思考。

## 15.4 修改 Agent 时

必须同步检查：

- session；
- model binding；
- context budget；
- memory namespace；
- tool permissions；
- event visibility；
- checkpoint；
- UI status；
- error recovery。

## 15.5 修改模型配置时

必须：

- 更新 schema；
- 更新服务器存储；
- 更新公开脱敏结构；
- 更新解析优先级；
- 更新创建房间 UI；
- 更新单 Agent 覆盖 UI；
- 更新能力检查；
- 更新 context budget；
- 不泄露密钥。

## 15.6 修改上下文时

必须证明：

- 不会丢角色；
- 不会丢未完成行动；
- 不会让 Agent 重复工具；
- 不会跨 Agent 混淆；
- 能处理 provider compaction 不可用；
- 能发出真实状态事件；
- 能持久化；
- UI 能显示当前压力。

## 15.7 修改 UI 时

必须从观众任务出发，而不是从数据库字段出发。

观众最先需要知道：

1. 现在发生什么；
2. 谁是焦点；
3. 为什么重要；
4. Agent 在做什么；
5. 行动造成了什么结果；
6. 下一步看哪里。

高级详情放抽屉、悬浮层或分析视图，不要把所有字段永久摆在主舞台。

## 15.8 修改角色时

必须通过类型化角色能力和规则实现。

不得只修改 system prompt 说：

- “你现在可以救人”；
- “你可以查验”；
- “你死亡时可以开枪”。

如果世界没有对应工具、触发时机和结算逻辑，该能力不存在。

## 15.9 完成前

最低检查：

```bash
npm run typecheck
npm run build
```

涉及世界规则时运行对应规则检查；涉及 Agent、模型、工具、上下文或 SSE 时，必须使用至少一个真实配置提供商完成相关流程的冒烟运行。没有真实模型环境时，要明确说明未完成真实运行验证，不能用 mock 结果冒充。

## 15.10 文档语言

产品文档应：

- 先解释用户能做什么；
- 再解释系统如何工作；
- 使用“并列 Agent”“自治 Agent”“内部认知阶段”；
- 不再把本项目称为研究 Harness；
- 不以审计、可证伪、实验工件作为产品中心；
- 不宣传内部专家子 Agent；
- 不宣传收费计划；
- 不夸大未经真实运行验证的效果。

---

# 16. 具体删除与替换清单

## 16.1 必须删除的概念

- “manager Agent”；
- “私人智囊 Agent”；
- “reflection sub-agent”；
- “theory-of-mind sub-agent”；
- “planning sub-agent”；
- 同一角色的第二个 discussion Agent 身份；
- 用内部 Agent 数量证明项目是多 Agent；
- 把研究 Harness 作为项目目标；
- 付费、会员、Token 包或角色 DLC 方向；
- mock 行为证明；
- 未发生思考的伪可视化。

## 16.2 必须替换的说法

| 旧说法 | 新说法 |
|---|---|
| manager Agent | autonomous peer Agent |
| specialist sub-agent | internal cognitive pass/module |
| private council | private cognition pipeline |
| agent-as-tool reflection | structured reflection pass |
| model list | provider and model profiles |
| model rotation only | global defaults + per-Agent binding |
| one summary compaction | layered memory + adaptive compaction |
| three-column theater | arena-first spectator experience |
| research harness | free product-grade multi-Agent social arena |

## 16.3 必须新增的基础能力

- `ProviderProfile`；
- `ModelProfile`；
- `AgentModelBinding`；
- `ContextPolicy`；
- `ResolvedModelConfig`；
- `ThoughtBeat`；
- `ToolTrace`；
- `ActionIntent`；
- `AgentCheckpoint`；
- `RoleDefinition`；
- `CharacterDefinition`；
- `SocietyEventEnvelope`；
- `CinematicCue`；
- `TensionEngine`；
- `SessionStore`；
- `MemoryRepository`。

---

# 17. 前沿技术如何进入本项目

本节只保留能够直接转化为产品能力的技术结论。论文不是功能，术语不是进度；每一项都必须落到 Peer Agent、模型配置、长期记忆、交互协议或观战体验。

## 17.1 OpenAI Agents SDK：Agent、Session、Tool 与完整 ModelSettings

当前 TypeScript Agents SDK 提供 Agent、Runner、Session、Streaming、Tools、Context Management 和广泛的 `ModelSettings`。其中可用于本项目的字段包括 temperature、top-p、presence/frequency penalty、max tokens、reasoning、tool choice、parallel tool calls、timeout、retry、truncation、prompt cache 和 provider data。

对本项目的决定：

- 每个参与者拥有独立 Session 和 resolved model config；
- Settings UI 不再只暴露模型 ID、temperature 和统一 reasoning effort；
- provider/model capability 为 unknown 时不盲目发送参数；
- SDK 的 handoff、manager 和 agents-as-tools 只是可选编排模式，本项目参与者路径禁止采用；
- provider-native compaction 可以作为优化，但不能替代本地分层社会记忆和检查点。

## 17.2 Generative Agents：记忆、反思、计划必须形成持续闭环

Generative Agents 展示了观察流、记忆检索、反思和计划对可信社会行为的重要性。

对本项目的决定：

- 保留 observation、retrieval、reflection、planning；
- 全部实现为同一个 Peer Agent 的内部阶段；
- 计划必须接受世界后果反馈；
- 反思结果进入该 Agent 私有状态，不创建 reflection Agent。

## 17.3 Think-Before-Speak：私下评价、表达意愿与公开发言分开

Think-Before-Speak 强调内部评价、发言意愿和公开表达的分离，并允许沉默。

对本项目的决定：

- 每个并列 Agent 独立产生 `SpeakIntent`；
- 中立 `ConversationScheduler` / `DiscussionFloor` 解决同时抢话；
- 没有表达意愿的 Agent 可以沉默；
- 获得话轮后才生成完整公开发言；
- UI 可以显示“想回应但未获得话轮”“选择保留信息”等真实状态。

## 17.4 PsychoAgent：事实记忆、情感记忆和冲突仲裁

PsychoAgent 提出将事实与情感记忆分开，并根据冲突显著性重新排序检索结果。

对本项目的决定：

- 每个 Agent 同时维护 episodic/semantic 与 affective/social memory；
- 检索不仅看语义相似，还看目标人物、当前情绪、未解决承诺和冲突；
- 目标、关系、自我调节和记忆之间通过 `MotiveArbiter` 仲裁；
- 最终意图仍由同一个 Peer Agent 的主决策模型选择。

## 17.5 MemGPT、Mem0 与 A-MEM：有限上下文之外的长期记忆

这些工作共同指向：长期 Agent 不能把全部历史永久塞进 prompt，而需要外部分层存储、抽取、检索、链接、更新和再整合。

对本项目的决定：

- 工作上下文是有限工作区；
- 长期记忆在 Agent 独立存储中持久化；
- 记忆条目原子化并带稳定 ID；
- 新记忆可以支持、矛盾、取代或链接旧记忆；
- 空闲期进行去重、聚合和语义巩固；
- 角色、承诺、秘密、未完成计划和关键背叛不可普通遗忘。

## 17.6 LongMemEval：长期记忆必须支持更新、时间和“不知道”

LongMemEval 将长期记忆能力拆为信息抽取、跨 session 推理、时间推理、知识更新和 abstention。

对本项目的决定：

- 记忆必须保存时间与有效期；
- 新事实能 supersede 或 contradict 旧事实；
- Agent 需要跨局回忆共同经历；
- 没有证据时允许回答“不知道”或维持低置信度；
- 不把更长上下文等同于更好的长期记忆。

## 17.7 ACON 与 LLMLingua-2：压缩要保留行动因果和执行位置

长期 Agent 的上下文压缩不能只是截掉旧消息或生成一段漂亮摘要。压缩必须保留行动、结果、前置条件、对象 ID、未完成计划、承诺、反证和当前执行位置。可选的抽取式压缩可用于去除冗余，但不能发明新内容。

对本项目的决定：

- 使用第 5 节的多级阈值和第 10 节的 `ContextPolicy`；
- 压缩结果必须结构化并引用 source event/memory ID；
- 压缩前后验证 pinned facts；
- 紧急压缩失败时暂停该 Agent；
- 长期运行依赖持久 Session、分层记忆和 checkpoint 三者，而不是压缩单点。

## 17.8 MDA 与 CaM-Wolf：从目标情绪反推舞台和多模态表现

MDA 强调从目标审美体验反推机制和动态；CaM-Wolf 展示了角色头像、语音、动作和社会推理结合的方向。

对本项目的决定：

- Arena 的目标情绪是期待、对抗、紧张、反转、理解和释放；
- ThoughtBeat、ToolTrace、Duel View、Tension Engine 和 Reveal 必须服务这些情绪；
- 语音、表情、口型和动作属于 P2 表演层；
- 多模态必须由真实 Agent/world event 驱动，不能生成另一套假剧情；
- 核心免费体验不得依赖收费多模态服务。

## 17.9 这些技术不允许被错误使用

禁止：

- 因为论文用了多个内部模型调用，就把它们命名成多个子 Agent；
- 因为某 provider 暴露 reasoning，就把完整隐藏思维链当观战卖点；
- 因为需要长期记忆，就在每次请求中塞入全部人生文本；
- 因为想要热闹，就强制所有 Agent 每轮发言；
- 因为原生 compaction 可用，就删除本地社会记忆和 checkpoint；
- 因为研究结果先进，就在主产品中加入没有用户价值的评测面板。

## 17.10 技术参考清单

实现相关模块前，优先核对原始资料的最新版本：

- OpenAI Agents SDK TypeScript：<https://openai.github.io/openai-agents-js/>
- OpenAI Agents SDK `ModelSettings`：<https://openai.github.io/openai-agents-js/openai/agents/type-aliases/modelsettings/>
- Generative Agents：<https://arxiv.org/abs/2304.03442>
- Think-Before-Speak：<https://arxiv.org/abs/2606.03137>
- PsychoAgent：<https://arxiv.org/abs/2608.07438>
- MemGPT：<https://arxiv.org/abs/2310.08560>
- Mem0：<https://arxiv.org/abs/2504.19413>
- A-MEM：<https://arxiv.org/abs/2502.12110>
- LongMemEval：<https://arxiv.org/abs/2410.10813>
- ACON：<https://arxiv.org/abs/2510.00615>
- LLMLingua-2：<https://arxiv.org/abs/2403.12968>
- SOTOPIA：<https://arxiv.org/abs/2310.11667>
- MDA：<https://www.cs.northwestern.edu/~hunicke/MDA.pdf>
- CaM-Wolf：<https://arxiv.org/abs/2607.26393>

这些资料提供设计输入，不构成产品宣传承诺。最终实现仍以本文件的 Agent-first、并列自治、免费、真实运行和高级观战硬约束为准。

# 18. 最终产品判断标准

任何重大改动都用以下问题判断：

## Agent

- 每个玩家仍然是独立、并列、自治的 Agent 吗？
- 是否有人偷偷替 Agent 做决定？
- 是否出现了主 Agent、子 Agent或专家 Agent？
- Agent 是否有自己的模型、会话、记忆、心智和工具？

## 长期运行

- 运行足够久后是否自动压缩？
- 压缩是否保留身份、角色、承诺和执行位置？
- 重启后是否能继续？
- 模型切换后人物是否还是同一个人？

## 模型配置

- 用户能否统一设置所有 Agent？
- 用户能否单独指定某个 Agent 的模型？
- 用户能否配置上下文、输出、推理、采样、工具、超时和重试？
- UI 是否显示最终生效值？

## 人性

- 行为差异是否来自记忆、需求、关系、情境和偏差，而不是只换台词？
- Agent 是否可以沉默、犹豫、误判、记仇、原谅、改变和坚持？
- 长局后不同人物是否仍然不同？

## 观战

- 观众是否知道现在发生了什么？
- 是否能看到 Agent 的真实思考摘要、记忆和工具过程？
- 是否能看到行动造成的世界影响？
- 关键冲突是否有镜头、节奏和因果回放？
- UI 是否像一个产品，而不是后台控制台？

## 免费

- 是否引入了任何收费、会员、点数或付费解锁？
- 用户是否能用自己的模型或本地模型完整运行？

只要其中任一关键答案是否定的，就不能认为该方向完成。

---

# 19. 一句话路线

> 先把每个参与者做成真正独立、并列、可长期运行且可精细配置的 Agent；再把它们的真实思考、记忆、工具和冲突变成一个具有电影感、节奏感和因果爽感的免费社会竞技产品。
