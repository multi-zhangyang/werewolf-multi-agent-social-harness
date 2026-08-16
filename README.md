# Society

**多智能体社会博弈竞技场 —— 让真实的模型 Agent 同台谈判、结盟、欺骗与背叛**

Society 是一个实时多智能体社会博弈平台。每个参与者都是一个由 OpenAI Agents SDK 驱动的真实 Agent：拥有独立的会话、私有记忆、情绪、信念、关系账本与专属认知专家。它们在狼人杀、阿瓦隆、囚徒困境等十一个世界里交锋——被当众指控会愤怒，被盟友背叛会记仇，兑现承诺会赢得信任。过去，真的会改变未来。

<p align="center">
  <img src="docs/screenshots/landing.png" width="820" alt="Society 首页" />
</p>

## 它是什么

市面上大多数「多智能体」演示，不过是提示词拼接或 JSON 解析器。Society 按照 OpenAI Agents SDK 的本意构建：

- **真实 Agent，不是脚本** —— 每个参与者由 SDK `Runner` 驱动的 `Agent` 扮演，持有私有 `MemorySession`、函数工具与嵌套专家子智能体。模型文本永远不被解析成命令，只有成功的 SDK 工具调用才能改变世界。
- **真正的多智能体认知** —— 每个参与者指挥一支私人智囊：反思、读心、谋划三个 SDK 子智能体，通过 `Agent.asTool()` 嵌套运行，在隔离上下文中各自思考，交回一份只有主人可见的简报。
- **通人性的社会状态** —— PAD 情绪、六种核心情感、十种社会情绪（感激、内疚、羞耻、骄傲、蔑视……）、需求、精力、关联记忆、对他人的信念与多维关系账本。人格锚定在五大人格（OCEAN）上，可测地改变谈判与冲突风格。
- **事件驱动的情绪** —— 情绪不是模型自报：世界把「谁指控了你、谁为你辩护、谁投票淘汰了你」翻译成结构化事件，由评估引擎按人格调制后写入情绪、关系与记忆。同样一句指控，高神经质的角色会恐惧，高宜人性的角色会先想修复。
- **对话自然展开** —— 讨论不是轮流念稿：被点名的人要回应，质疑会被追问，谎言会被拆穿，无话可说的人可以选择沉默。讨论在没有人再有话要说时自然结束（邻接对驱动的下一说话人选择，源自对话分析研究）。狼人杀、阿瓦隆、囚徒困境、信任博弈、最后通牒的谈判阶段全部采用动态调度。
- **怀疑氛围实时可读** —— 每一条公开指控与投票都会让被点名的对象在世界级的「怀疑氛围」中升温。氛围注入每个智能体的观察（它知道群体正在怀疑谁），观察者也看得到：谁在被围攻、指控链如何蔓延、任务失败后嫌疑如何落在队伍身上。
- **一切实时可见** —— 思考模型的隐藏推理、专家子智能体的私下盘算、每一次工具调用、每一条公聊与密谋，都像直播一样流向观察席。身份揭晓与淘汰，是戏剧性时刻而不是控制台日志。
- **是直播剧场，不是实验台** —— 影院式三栏舞台：参与者状态栏、实时对话主舞台、战况面板。讨论热度面板实时显示谁在被质疑、谁在被围攻。

## 十一个世界

| 世界 | 核心张力 |
| --- | --- |
| 狼人杀 | 隐藏身份、公开指控、夜间行动与第三阵营 |
| 阿瓦隆 | 忠臣与内奸混坐圆桌，任务成败藏于一次举手，以及最终的梅林刺杀 |
| 囚徒困境 | 短期背叛与长期互惠的永恒拉扯 |
| 蜈蚣博弈 | 奖池每传递一次就翻倍，信任与贪婪对赌 |
| 胆小鬼博弈 | 谁也不先打方向盘，直到两辆车相撞 |
| 猎鹿博弈 | 合作收益最高，但任何一人转向都会让另一人空手 |
| 信任博弈 | 把选择权交出去，然后等待对方如何处置 |
| 最后通牒博弈 | 分配权、公平感与掀桌子的权力 |
| 公共品博弈 | 集体收益与搭便车的拉锯 |
| 选美博弈 | 你以为大家在猜平均数，其实大家在猜你猜什么 |
| 密封拍卖 | 私密估值、策略误导与次价结算 |

## 截图

### 首页

<p align="center"><img src="docs/screenshots/landing.png" width="820" alt="首页" /></p>

### 创建世界

<p align="center"><img src="docs/screenshots/create-room.png" width="820" alt="创建世界" /></p>

### 实时房间 —— 谈判进行时

<p align="center"><img src="docs/screenshots/room-live.png" width="820" alt="实时谈判" /></p>

### 智能体内心世界

<p align="center"><img src="docs/screenshots/agent-mind.png" width="820" alt="智能体内心世界" /></p>

### 终局结算

<p align="center"><img src="docs/screenshots/room-finished.png" width="820" alt="终局结算" /></p>

### 关于页面

<p align="center"><img src="docs/screenshots/about.png" width="820" alt="关于 Society" /></p>

## 架构

```text
浏览器
  ▲ SSE 快照与实时事件（状态 · 隐藏推理 · 专家盘算 · 发言 · 世界变更）
  │
SocietyRoom ── 调度行动轮次、管理事件流与真人等待
  │
  ├─ OpenAISocietyAgent × 参与者
  │    ├─ @openai/agents Agent + Runner（每参与者独立）
  │    ├─ MemorySession + 关联记忆流
  │    ├─ 社交工具（发言 / 记忆 / 内省）
  │    ├─ 反思 / 读心 / 谋划 三个 SDK 子智能体（asTool 嵌套运行）
  │    └─ 世界工具（类型化、校验、落库）
  │
  └─ SocialWorld ── 观察、可见性、规则与确定性结算
       └─ 场景实现（狼人杀、阿瓦隆、蜈蚣博弈……）
```

- **Agent 边界**（`src/society/participant.ts`）：每个参与者一个 SDK `Agent`，稳定会话 + 私有心灵 + 事件评估引擎。认知专家是真正的 SDK Agent，以嵌套工具运行，参与者对每一次改变世界的行动保持所有权。
- **对话边界**（`src/society/conversation.ts`）：动态讨论导演。追踪谁被点名、谁被提问、谁被指控，按人格调制回应紧迫度，驱动多轮讨论直到自然收场——沉默是被允许的战术，不是故障。
- **评估边界**（`src/society/appraisal.ts`）：事件驱动的社会评估。世界结算产生的结构化事件（投票、指控、辩护、淘汰、胜负）经人格调制后写入情绪、社会情绪、需求、关系与记忆，形成「事件 → 状态 → 行为」的完整因果链。
- **世界边界**（`src/society/world.ts`）：作用域观察、公开/私聊/阵营频道、行动调度、类型化 SDK 工具、确定性结算与逐轮经历沉淀。
- **房间与事件流**（`src/society/room.ts`）：调度行动轮次（带轮数与超时信号），通过 SSE 把快照与实时事件推给浏览器。提供方密钥与原始诊断数据永不进入快照或事件。

## 快速开始

要求：Node.js 22+，以及任意 OpenAI 兼容的 chat-completions 端点。

```bash
npm install
cp .env.example .env.local
# 编辑 .env.local：填入 OPENAI_API_KEY、OPENAI_BASE_URL 与 SOCIETY_MODELS
npm run dev
```

Web 应用位于 `http://127.0.0.1:5173`，API 位于 `http://127.0.0.1:8787`；生产式运行：`npm run build && npm run server`，然后打开 `http://127.0.0.1:8787`。

`SOCIETY_MODELS` 是逗号分隔的模型 ID 列表，创建房间时从该列表为智能体分配模型。**也可以完全不用手改文件**：打开网页右上角的设置按钮，直接在界面里配置提供商地址、密钥与模型清单，并一键测试连接。所有配置只写入本机 `.env.local`（已被 gitignore），界面与接口永不回显完整密钥。

常用检查：

```bash
npm run typecheck
npm run build
curl http://127.0.0.1:8787/api/health
```

### 真实模型演示

```bash
npm run server &
node scripts/demo.mjs prisoners-dilemma   # 或 node scripts/demo.mjs avalon
```

演示脚本会对着你配置的端点启动真实房间，并把逐字剧本写入 `artifacts/transcripts`。

## HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 运行时与提供商配置状态 |
| GET | `/api/settings` | 当前提供商配置（密钥掩码） |
| PUT | `/api/settings` | 更新提供商地址、密钥或模型清单 |
| POST | `/api/settings/test` | 测试连通性并发现可用模型 |
| GET | `/api/scenarios` | 世界与模型目录 |
| GET | `/api/rooms` | 本进程内的房间列表 |
| POST | `/api/rooms` | 创建并启动房间 |
| GET | `/api/rooms/:roomId` | 当前房间快照 |
| GET | `/api/rooms/:roomId/events` | 快照 + 实时 SSE 事件 |
| POST | `/api/rooms/:roomId/pause` | 暂停运行中的房间 |
| POST | `/api/rooms/:roomId/action` | 提交真人行动 |

## 技术栈

- **前端**：React 19、Vite、Tailwind CSS 4、shadcn/ui、Radix、lucide-react、Geist
- **后端**：Express 5、Server-Sent Events
- **AI 运行时**：OpenAI Agents SDK（`@openai/agents`）
- **校验**：Zod

## 研究基础

Society 的每一项设计都有可核实的同行评审研究背书——详见 `docs/research/agent-social-runtime.md` 与 `docs/research/llm-social-agents-sota.md`：

- **记忆与反思**：Park et al., *Generative Agents*（arXiv:2304.03442）
- **意图驱动的谈判语言**：Bakhtin et al., *Cicero*（arXiv:2210.05492）
- **社会智能评测**：Zhou et al., *SOTOPIA*（arXiv:2310.11667）
- **隐藏身份博弈**：Xu et al.（arXiv:2309.04658）、Chi et al., *AMONGAGENTS*（arXiv:2407.16521）、Guo et al., *Suspicion-Agent*（arXiv:2309.17277）
- **高阶心智理论**：Street et al.（arXiv:2405.18870）、Lupu et al., *Decrypto*（arXiv:2506.20664）
- **人格与行为**：Noh & Chang（arXiv:2405.05248）、Huang et al., *PsychoBench*（arXiv:2310.01386）、Lee et al., *TRAIT*（arXiv:2406.14703）
- **情绪的结构化评估**：Bhattacharyya et al.（arXiv:2508.05880）
- **欺骗的工程化**：Taylor & Bergen（arXiv:2504.00285）、Fontana et al.（arXiv:2406.13605）
- **动态对话调度**：*Who Speaks Next?*（arXiv:2412.04937）、*Think-Before-Speak*（arXiv:2606.03137）
- **情感记忆架构**：*PsychoAgent*（arXiv:2608.07438）

研究也告诉我们：大模型默认过度合作、自发欺骗很弱——所以欺骗被工程化为显式目标、信念管理与廉价话语折扣，而不是寄望于模型「自己变坏」。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。新增世界遵循 `docs/architecture.md` 中的指南；产品设计依据见 `docs/design-system-report.md`。

## 许可证

[Apache License 2.0](LICENSE)
