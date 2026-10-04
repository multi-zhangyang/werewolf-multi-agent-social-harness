# Society：通用社会心理 Agent 实验台

同一套心理与学习内核用于信任交易、公共品合作、狼人杀和信息交易。人物根据自己的可见经历形成判断，管理目标、情绪、关系假设和条件策略，并用实际结果更新记忆与概率预测。合伙人场景保留为独立的交易适配器与研究入口。

当前模型固定为 **gpt-6-luna**，配置上下文 **256000**，使用 **OpenAI Agents SDK + 原生 Responses**。运行、探测和复测均不设置输出 token 上限，由提供商决定；历史配置不会重新带入请求。没有自定义 JSON 工具信封、Chat Completions 转接或自动替换模型。256k 是本项目的配置值，尚未通过满窗口容量测试。

当前心理状态为 v14。经历新增实际角色，复盘输入分别汇总回合、结算、角色动作和各单位收益；跨场景比较依据共同决策关系。SDK 在 8 步内为必需评价、策略检验和完成动作保留步数。模型可以采用、调整或拒绝旧策略；发言中的意向不计作行动采用。本次输出上限移除通过 31 项相关测试、局部 lint、类型检查和生产构建，没有重复运行完整实验批次。

v14 短信任局完成 43 次真实调用，零模型失败、零工具错误，收益为 20 / 16；全部继承策略被拒绝，未证明正迁移。公共品运行 26 次调用后因用户要求移除输出上限而停止，保留为 interrupted。这些运行发生在移除上限之前，不能用来证明修改后的真实模型行为。通用学习、可靠欺骗与收益改善仍未完成验收，完整结果见[验证记录](docs/validation-native-responses.md)。

## 启动

需要 Node.js 22 或更新版本；本地使用 Windows / Node 24。

```sh
npm install
npm run dev
```

开发页面：[127.0.0.1:5173](http://127.0.0.1:5173)。生产运行：

```sh
npm run build
npm run server
```

默认生产端口为 8787。本次恢复的本机服务位于 [127.0.0.1:8794](http://127.0.0.1:8794/)，使用原有 `data/society-v5-stability.sqlite`。

8794 正在运行 v14 的无输出上限代码。v11 至 v13 的四个历史批次以及上述两场 v14 运行已备份后追加到原库，停止与失败记录保留。原库现有 98 场通用运行、6951 条决策案例，包含失败与中断；连续世界指针、SDK 会话和环境文件保持原样。独立实验库继续保留。

模型与提供商在 `data/model-settings.json` 配置；密钥只从服务端环境引用读取。已有 `.env.local` 保持原样。当前已配置的兼容提供商必须支持原生 Responses 的函数工具与工具结果回传。

## 可以做什么

- 在首页选择信任交易、公共品、狼人杀或信息交易，配置人物、轮次和心理机制。
- 在信息交易中交换发送者与接收者，比较利益一致和冲突条件，逐轮核验报告、真值与实际所得。
- 在连续世界中让同一人物跨场景继承可迁移经验；本局隐藏身份不会作为下一局的事实。
- 同一个人的长期关系经验与本局身份假设分别保存、分别修订；中文回忆按分词相关性检索经历与条件策略。
- 依据新证据修订或停用原判断，查看原文、理由和版本；实际经历保持不变，停用项不再参与下一次决策。
- 让人物在整局结束后比较本人经历、预测与实际结果，形成可供后续检验的策略，或明确记录证据不足。
- 区分实际结算与人物解释，查看每条经历的具体动作，并分开统计结算次数和记录条数。
- 分开查看检索到的旧策略、适用性判断、实质动作采用和之后的真实收益；不适用的策略可以拒绝。
- 查看人物的事件评价、情绪、需要、对手假设、持续计划、私有意图和三类记忆。
- 查看真实收益反馈、预测结果与 Brier 分数；从保存的原始请求单独复测模型。
- 在 [合伙人入口](http://127.0.0.1:8794/#/partners) 亲自交易、观察双 AI 对局、查看检查点与心理干预分支。
- 查看历史运行和失败记录；新版本不会将旧实验结果当成本版本的验证。

公开页面、玩家视角和研究者视角由服务端分别授权。私有意图与心理记录不会写入对手观察。

## 实现

每次行动机会使用一个官方 `Agent`、`Runner` 和新的隔离 `MemorySession`。工具直接通过 Zod 定义并由 SDK 执行。证据编号、合法频道、可选人物等写入原生工具 schema；证据在数据库中保留不可变原始 ID。

工具先暂存本次心理变化和动作；只有完整流、SDK 完成状态和业务校验全部成功后，才通过一个 SQLite 事务提交。中断、不完整输出、重复提交或持久化失败不会留下半次行动。HTTP 与 SDK 重试均为零。

心理学习是**基于经历的状态、记忆和反馈更新**，没有训练模型权重。当前实现不证明人类心理真实性，也不证明策略已在统计意义上变得更优。

详见 [Agent 设计](docs/agent-design.md)、[系统架构](docs/architecture.md)、[当前验收矩阵](docs/acceptance-native-responses.md) 与 [本次验证记录](docs/validation-native-responses.md)。

## 验证

```sh
npm run ci
npm run test:ui
npm run test:ui:partners
node --import tsx scripts/ui-partners-streaming.mjs
node --env-file-if-exists=.env.local --import tsx scripts/validate-general-agents.ts
node --env-file-if-exists=.env.local --import tsx scripts/validate-agent-adaptation.ts
node --env-file-if-exists=.env.local --import tsx scripts/validate-memory-revision.ts
node --import tsx scripts/ui-memory-revision.mjs
node --env-file-if-exists=.env.local --import tsx scripts/validate-signaling-agents.ts
node --import tsx scripts/ui-signaling.mjs
node --env-file-if-exists=.env.local --import tsx scripts/validate-episode-review.ts
node --env-file-if-exists=.env.local --import tsx scripts/validate-strategy-application.ts data/episode-review-validation-1791070192853
node --import tsx scripts/ui-strategy-learning.mjs
npm run study:partners:validation
```

离线测试验证协议、权限、事务和规则；浏览器夹具验证界面。真实模型验证将源码快照、配置、原始 Responses 请求、错误、使用量和结果写入独立 `data/` 目录。完整结果及仍然存在的限制以验证记录为准。

整局复盘验证固定两条信息交易来源、分别进入信任交易和公共品，再运行独立狼人杀。预定来源缺少有效提炼策略时，目标局保持 `not_started`。源码与计划在首个请求前冻结；不按结果改选来源，不改写失败或放宽门槛。研究依据与解释范围见[策略学习设计](docs/research/strategy-consolidation.md)。

策略适用性验证只创建两个新目标局，复用指定已结束批次的两个原定源快照。它分别报告协议、明确检验和实际采用反馈；拒绝可以满足检验要求，不会被算成正迁移。来源数据库只读导入、保留原 ID 与代码版本，统计时去重。

经验对照脚本需要一份已完成的真实公共品源记录，可通过 `AGENT_ADAPTATION_SOURCE` 指定。它保持人物与初始世界一致，仅清空焦点人物的一整包既有经验作对照；动作差异不等于已经证明策略改善或单一心理机制的因果作用。

反证修订脚本覆盖信任 / 公共品两种场景、过度信任 / 完全不信任两种旧判断，各重复两次。旧判断及 20 条无关记忆明确标为研究设置，第一轮和其他人物由固定合法策略执行，焦点人物第二轮使用相同生产 Agent。检查真实请求、正式修订回执、原始账本来源和后续行动，不指定模型应采取的动作。设置 `AGENT_REVISION_PREFLIGHT=1` 可只验证实验流程，零模型调用；该预检不算真实模型通过。

信息交易脚本固定两个种子、两种发送者安排与两种利益条件，共 8 局、每局 4 轮，全部由生产 Agent 自主决策。将已结束批次目录传给 `scripts/validate-signaling-transfer.ts`，可执行一次从预定信息交易记录继承经验的全新狼人杀迁移验证。脚本先检查每位原人物是否已有可迁移条件策略；条件不足时记录 `not_started` 并以退出码 1 结束，零模型调用，不改选源局。它不会重试或改写旧失败对局。浏览器脚本使用独立数据库和注入测试模型，界面夹具不计入真实模型行为证据。
