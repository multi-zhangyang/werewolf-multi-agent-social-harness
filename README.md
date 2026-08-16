# Society

**实时多智能体社会博弈竞技场 · 基于 OpenAI Agents SDK**

Society 是一个实时竞技场:真实的 AI 智能体在狼人杀、阿瓦隆、囚徒困境等世界里谈判、结盟、欺骗、背叛,也记仇、原谅、重建信任。每个参与者都是一个一等公民的 OpenAI Agents SDK `Agent` —— 拥有自己的模型、会话、记忆、情绪、信念、目标、关系与领域工具。你可以像看直播一样观察它们交锋,也可以亲自下场与它们同台对弈。

<p align="center">
  <img src="docs/screenshots/landing.png" width="820" alt="Society 首页" />
</p>

## 为什么是 Society

市面上大多数"多智能体"演示,不过是提示词拼接或 JSON 解析器。Society 完全按照 OpenAI Agents SDK 的本意构建:

- **真实 Agent,不是脚本** —— 每个参与者由 SDK `Runner` 驱动的 `Agent` 扮演,持有私有 `MemorySession`、函数工具与嵌套专家子智能体。模型文本永远不被解析成命令,只有成功的 SDK 工具调用才能改变世界。
- **真正的多智能体认知** —— 每个参与者指挥一支私人智囊:反思、读心、谋划三个 SDK 子智能体,通过 `Agent.asTool()` 嵌套运行,在隔离上下文中各自思考,交回一份只有主人可见的简报。
- **人性化的社会状态** —— 智能体携带 PAD 情绪、六种核心情感、需求、精力、关联记忆、对他人的信念与关系账本;人格锚定在五大人格(OCEAN)上,可测地改变谈判与冲突风格。
- **思考全程可见** —— 思考模型的隐藏推理、专家的私下盘算、每一次工具调用、每一条公聊与密谋,都实时流向观察界面;身份揭晓与淘汰是戏剧性时刻,不是控制台日志。
- **是直播剧场,不是实验台** —— 影院式三栏舞台:参与者状态栏、实时对话主舞台、战况面板。角色揭晓、任务成败、背叛瞬间都有专属的动画节奏。
- **世界目录持续扩展** —— 每个新世界只需实现 `SocialWorld` 契约,Agent 运行时、服务端与 UI 一行都不用改。

## 十一个世界

| 世界 | 核心张力 |
| --- | --- |
| 狼人杀 | 隐藏身份、公开指控、夜间行动与第三阵营 |
| 阿瓦隆 | 忠臣与内奸混坐圆桌,任务成败藏于一次举手,以及最终的梅林刺杀 |
| 囚徒困境 | 短期背叛与长期互惠的永恒拉扯 |
| 蜈蚣博弈 | 奖池每传递一次就翻倍,信任与贪婪对赌 |
| 胆小鬼博弈 | 谁也不先打方向盘,直到两辆车相撞 |
| 猎鹿博弈 | 合作收益最高,但任何一人转向都会让另一人空手 |
| 信任博弈 | 把选择权交出去,然后看对方如何处置 |
| 最后通牒博弈 | 分配权、公平感与掀桌子的权力 |
| 公共品博弈 | 集体收益与搭便车的拉锯 |
| 选美博弈 | 你以为大家在猜平均数,其实大家在猜你猜什么 |
| 密封拍卖 | 私密估值、策略误导与次价结算 |

## 截图

### 首页

<p align="center"><img src="docs/screenshots/landing.png" width="820" alt="首页" /></p>

### 创建世界

<p align="center"><img src="docs/screenshots/create-room.png" width="820" alt="创建世界" /></p>

### 模型提供商配置

<p align="center"><img src="docs/screenshots/settings.png" width="820" alt="模型提供商配置" /></p>

### 实时房间 —— 智能体正在思考

<p align="center"><img src="docs/screenshots/room-running.png" width="820" alt="智能体思考中" /></p>

### 实时房间 —— 谈判进行时

<p align="center"><img src="docs/screenshots/room-live.png" width="820" alt="实时谈判" /></p>

### 阿瓦隆 —— 任务进行中

<p align="center"><img src="docs/screenshots/room-avalon.png" width="820" alt="阿瓦隆任务" /></p>

### 智能体内心世界

<p align="center"><img src="docs/screenshots/agent-mind.png" width="820" alt="智能体内心世界" /></p>

### 终局结算

<p align="center"><img src="docs/screenshots/room-finished.png" width="820" alt="终局结算" /></p>

### 关于页面

<p align="center"><img src="docs/screenshots/about.png" width="820" alt="关于 Society" /></p>

## 架构

```text
浏览器
  ▲ SSE 快照与实时事件(状态 · 隐藏推理 · 专家盘算 · 发言 · 世界变更)
  │
SocietyRoom ── 调度行动轮次、管理事件流与真人等待
  │
  ├─ OpenAISocietyAgent × 参与者
  │    ├─ @openai/agents Agent + Runner(每参与者独立)
  │    ├─ MemorySession + 关联记忆流
  │    ├─ 社交工具(发言 / 记忆 / 内省)
  │    ├─ 反思 / 读心 / 谋划 三个 SDK 子智能体(asTool 嵌套运行)
  │    └─ 世界工具(类型化、校验、落库)
  │
  └─ SocialWorld ── 观察、可见性、规则与确定性结算
       └─ 场景实现(狼人杀、阿瓦隆、蜈蚣博弈……)
```

- **Agent 边界**(`src/society/participant.ts`):每个参与者一个 SDK `Agent`,稳定会话 + 私有心灵。认知专家是真正的 SDK Agent,以嵌套工具运行,参与者对每一次改变世界的行动保持所有权。
- **世界边界**(`src/society/world.ts`):作用域观察、公开/私聊/阵营频道、行动调度、类型化 SDK 工具、确定性结算与逐轮经历沉淀。
- **房间与事件流**(`src/society/room.ts`):调度行动轮次(带轮数与超时信号),通过 SSE 把快照与实时事件推给浏览器。提供方密钥与原始诊断数据永不进入快照或事件。

## 快速开始

要求:Node.js 22+,以及任意 OpenAI 兼容的 chat-completions 端点。

```bash
npm install
cp .env.example .env.local
# 编辑 .env.local:填入 OPENAI_API_KEY、OPENAI_BASE_URL 与 SOCIETY_MODELS
npm run dev
```

Web 应用位于 `http://127.0.0.1:5173`,API 位于 `http://127.0.0.1:8787`;生产式运行:`npm run build && npm run server`,然后打开 `http://127.0.0.1:8787`。

`SOCIETY_MODELS` 是逗号分隔的模型 ID 列表,创建房间时从该列表为智能体分配模型。**也可以完全不用手改文件**:打开网页右上角的设置按钮,直接在界面里配置提供商地址、密钥与模型清单,并一键测试连接。所有配置只写入本机 `.env.local`(已被 gitignore),界面与接口永不回显完整密钥 —— 仓库代码、文档与截图里没有任何真实提供商与模型信息。

常用检查:

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

演示脚本会对着你配置的端点启动真实房间,并把逐字剧本写入 `artifacts/transcripts`。

## HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 运行时与提供商配置状态 |
| GET | `/api/settings` | 当前提供商配置(密钥掩码) |
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

- **前端**:React 19、Vite、Tailwind CSS 4、shadcn/ui、Radix、lucide-react、Geist
- **后端**:Express 5、Server-Sent Events
- **AI 运行时**:OpenAI Agents SDK(`@openai/agents`)
- **校验**:Zod

## 研究基础

每一项设计都有同行评审研究背书 —— 详见 `docs/research/agent-social-runtime.md` 与实现剧本 `docs/research/llm-social-agents-sota.md`:

- Park et al., *Generative Agents* — [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)
- Zhou et al., *SOTOPIA* — [arXiv:2310.11667](https://arxiv.org/abs/2310.11667)
- Bakhtin et al., *Cicero(Diplomacy)* — [arXiv:2210.05492](https://arxiv.org/abs/2210.05492)
- Xu et al., *LLMs for Communication Games: Werewolf* — [arXiv:2309.04658](https://arxiv.org/abs/2309.04658)
- Chi et al., *AMONGAGENTS* — [arXiv:2407.16521](https://arxiv.org/abs/2407.16521)
- Guo et al., *Suspicion-Agent* — [arXiv:2309.17277](https://arxiv.org/abs/2309.17277)
- Kosinski, *Evaluating LLMs in Theory of Mind Tasks* — [arXiv:2302.02083](https://arxiv.org/abs/2302.02083)
- Street et al., *Higher-order Theory of Mind* — [arXiv:2405.18870](https://arxiv.org/abs/2405.18870)
- Pan et al., *MACHIAVELLI Benchmark* — [arXiv:2304.03279](https://arxiv.org/abs/2304.03279)
- Fontana et al., *Nicer Than Humans(Prisoner's Dilemma)* — [arXiv:2406.13605](https://arxiv.org/abs/2406.13605)
- Taylor & Bergen, *Spontaneous Rational Deception* — [arXiv:2504.00285](https://arxiv.org/abs/2504.00285)
- Ou et al., *LLMs in Economic Trust Games* — [arXiv:2505.17053](https://arxiv.org/abs/2505.17053)
- Zhao et al., *CompeteAI* — [arXiv:2310.17512](https://arxiv.org/abs/2310.17512)
- Bianchi et al., *NegotiationArena* — [arXiv:2402.05863](https://arxiv.org/abs/2402.05863)
- Noh & Chang, *LLMs with Personalities in Negotiation* — [arXiv:2405.05248](https://arxiv.org/abs/2405.05248)
- Huang et al., *PsychoBench* — [arXiv:2310.01386](https://arxiv.org/abs/2310.01386)
- Lee et al., *TRAIT* — [arXiv:2406.14703](https://arxiv.org/abs/2406.14703)
- Bhattacharyya et al., *Fragile Emotion Reasoning* — [arXiv:2508.05880](https://arxiv.org/abs/2508.05880)
- Manning et al., *Automated Social Science* — [arXiv:2404.11794](https://arxiv.org/abs/2404.11794)
- Lupu et al., *Decrypto Benchmark* — [arXiv:2506.20664](https://arxiv.org/abs/2506.20664)

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。新增世界遵循 `docs/architecture.md` 中的五步指南;产品设计依据见 `docs/design-system-report.md`。

## 许可证

[Apache License 2.0](LICENSE)