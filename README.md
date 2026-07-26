# 狼人杀多 Agent 社会实验 Harness

[![Validate](https://github.com/multi-zhangyang/werewolf-multi-agent-social-harness/actions/workflows/validate.yml/badge.svg)](https://github.com/multi-zhangyang/werewolf-multi-agent-social-harness/actions/workflows/validate.yml)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111827)
[![License](https://img.shields.io/badge/License-Apache%202.0-D22128.svg)](LICENSE)

**可重放、可分叉、可评测的多 Agent 对抗社会实验运行时。**

本项目提供一套领域中立的 harness：调度有状态社会 Actor，管理作用域观察与通信拓扑，校验类型化动作，提交确定性环境转换，并把每一步沉淀为可审计工件。狼人杀是首个高压证明域，用于验证隐藏信息、欺骗、联盟、说服与投票；它不是产品边界。

![加载了真实脱敏对局工件的研究驾驶舱](docs/assets/cockpit-overview.png)

<p align="center">
  <a href="#为什么">为什么</a> ·
  <a href="#架构">架构</a> ·
  <a href="#能力矩阵">能力矩阵</a> ·
  <a href="#性能">性能</a> ·
  <a href="#研究驾驶舱">研究驾驶舱</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#cli-与-api">CLI 与 API</a> ·
  <a href="#验证">验证</a> ·
  <a href="#许可证">许可证</a>
</p>

---

## 为什么

多数 “multi-agent” 演示把多个模型对话拼成 transcript，然后用 UI 假装有社会系统。这套 harness 解决的是另一类问题：

| 问题 | 系统给出的答案 |
| --- | --- |
| 某个 Actor 当时知道什么？ | 作用域 observation、channel、delivery receipt、exposure 证据 |
| 为什么做出这个动作？ | 私有状态、memory、belief、关系、目标、policy、reasoner 备忘、仲裁记录 |
| 模型输出能不能改世界？ | 不能。候选必须经过 policy / 仲裁 / 环境合法性检查 |
| 失败发生在哪？ | 生命周期状态、失败阶段、流式调用遥测、部分工件 |
| 能否复现？ | 不调用模型的确定性 replay + 状态/消息哈希链 |
| 能否从中途改条件？ | checkpoint、fork 谱系、分支树 |
| 指标是否可审计？ | 版本化 evaluator、证据引用、promotion 策略、可重建聚合 |
| 浏览器会不会泄漏隐藏真相？ | 服务端投影权威；live / postgame-redacted / truth-redacted 分轨 |

边界是硬约束：

```text
Agent     = 身份 + 私有社会状态 + policy + 可选 reasoner + 仲裁
Reasoner  = Agent 内部可选的认知组件
Harness   = 调度、可见性、通信、合法性、工件、replay、fork、评测
Environment = 领域真相与确定性转换
Cockpit   = 基于服务端投影与工件的操作界面
```

JSON 是命令、工件与 API 的编码，不是 agency 的定义。

---

## 架构

```text
Experiment Spec
      │
      ▼
Control Plane ── profile / seed / scheduler / timeout / assignment
      │
      ▼
Social Runner ── AEC | batched decision | true parallel (stepBatch)
      │
      ├─ ObservationAssembler ── 作用域视图 + 可见社会消息
      ├─ SocialCommunicationBus ── 频道、回执、确定性 seq
      ├─ Agent Scaffold ── memory / belief / 关系 / 目标 / 规范
      ├─ Policy + Arbitrator ── 合法候选，可选流式 reasoner
      └─ Environment Adapter ── 类型化命令、领域转换、事件
      │
      ▼
Artifact Plane ── 对局 / 轨迹 / 社会 episode / 指标 / 失败记录
      │
      ├─ Replay Engine ── 不调用模型
      ├─ Checkpoint / Fork ── 原生边界谱系
      ├─ Evaluator Registry ── 证据支撑的指标
      └─ Tournament / Matrix ── 多 episode 聚合
      │
      ▼
Server API ── 脱敏投影 + 操作接口
      │
      ▼
React Cockpit ── 研究界面，不是第二真相源
```

代码按职责域组织为内聚模块，聚合入口文件是纯转发 barrel，导入路径长期稳定：

```text
src/
  core/                     狼人杀规则与确定性转换
  harness/
    social/                 通用社会执行契约：调度、消息、可见性、步进提交
    socialState/            Actor 私有社会状态：memory / belief / 关系 / 规范 / journal
    socialEvaluator/        社会动力学指标族与生命周期评测
    matchArtifacts/         对局工件构建、完整性校验、checkpoint 载荷
    episodeArtifacts/       episode 封套、快照审计、fork 载荷校验
    episodeArtifactStore/   持久化 episode 存储与崩溃恢复
    tournamentArtifacts/    锦标赛工件目录、公开包、统计与 CSV
    evaluator/              狼人杀结果指标族
    evaluation/             evaluator 注册表与 metric promotion
    matchComparison/        对局对比行、投影格式、聚合
    experimentSpec/         实验规范归一化与 attestation
    experimentOrchestrator/ 实验编排、checkpoint、发布
    experimentRunStore/     持久化实验运行存储（含并发租约与崩溃恢复）
    experimentMatrix/       实验矩阵运行器与统计
    tournament/             锦标赛运行器
    werewolfAdapter/        狼人杀领域适配器（actor / scaffold / 投影 / 消息）
  agents/                   Provider 中立的流式模型客户端
  server/
    routes/                 12 个路由域（matches / checkpoints / tournaments / …）
    *.ts                    投影、脱敏、DTO、工件存储、恢复审计
  components/cockpit/
    hooks/                  13 个驾驶舱状态 hooks（数据加载 / live 轮询 / 对比 / 谱系 …）
    *Workspace.tsx          每工作区一个组件；重计算全部懒加载
  App.tsx                   驾驶舱组合根；状态逻辑全部在 hooks 中
  scripts/                  CLI 入口
tests/                      651 个确定性单元与集成测试
e2e/                        Playwright fixture 驾驶舱与无障碍检查
docs/                       架构说明与驾驶舱截图
```

---

## 能力矩阵

| 层 | 内容 |
| --- | --- |
| 社会 Actor | memory、belief、关系、声誉、规范、承诺、联盟、目标、变更 journal |
| 调度 | AEC、batched decision、真并行联合 `stepBatch` |
| 通信 | 公开 / 团队 / 私聊 / 系统频道，不可变受众快照与投递回执 |
| 观察 | exposure 证据来自作用域观察，绝不从 `recipientIds` 推断 |
| 动作 | reasoner 候选仅为建议；环境是最终权威 |
| 工件 | 原生社会步骤、轨迹投影、JSONL、脱敏、完整性校验 |
| Replay / Fork | 不调用模型的 replay；原生边界 checkpoint；持久 fork 谱系 |
| 评测 | 版本化 evaluator、证据引用、promotion 目录、锦标赛公开包 |
| 驾驶舱 | 运行、时间线、领域适配器、社会图、谱系、评测、实验矩阵、对比、公开包 |

---

## 性能

运行时在保持确定性契约的前提下按热路径设计：

**对局引擎**

- 评测注册表只构建一份深冻结的 canonical 上下文快照，所有 evaluator 共享冻结数据、各自持有独立冻结身份——隔离由 `Object.freeze` 强制，而不是逐模块的全量 `structuredClone`。
- 每步的全阵容 actor 快照捕获一次后以所有权转移方式挂载到步骤与轨迹投影，不做重复深拷贝。
- 60 步确定性对局（桩推理器，即模型延迟为零）的纯 harness 开销约 22 s / 2 核开发机；真实运行中的耗时由模型延迟主导。

**服务端 API**

- 只读 GET 路径直接复用不可变的权威工件对象；写入与变更路径保持隔离克隆语义。
- 投影 DTO 以工件对象身份为键做 WeakMap 缓存；篡改检测的 fail-closed 路径不缓存，重放路由保持逐请求完整性审计。
- 磁盘恢复扫描每 baseDir 执行一次；复盘账本使用有序区间 + 二分检索取代全表扫描。

**驾驶舱**

- 仅渲染激活的工作区；重组件 `React.memo`，表格 columns / dataSource 全部 memo 化。
- 复盘投影、锦标赛分享等重计算位于懒加载 chunk；初始 JS 预算 360 KiB，由 `scripts/checkBundleBudget.mjs` 在构建时强制。

---

## 研究驾驶舱

驾驶舱是研究与运维界面。它只消费服务端 API 与已记录工件，不根据 transcript 推断隐藏角色、关系或胜负。

截图均来自本机对真实 OpenAI-compatible 流式模型（`inclusionai/ling-3.0-flash`）调用后的 `postgame-redacted` 工件，不包含 API key、endpoint 或私有环境配置。

### 研究总览

运行注册表、原生步骤密度与脱敏工件摘要：

![加载真实对局的研究驾驶舱](docs/assets/cockpit-overview.png)

### 领域适配器复盘

狼人杀作为首个证明域的赛后公开局面与事件账本：

![领域适配器赛后复盘面板](docs/assets/werewolf-review.png)

### 社会证据

服务端权威社会图、消息流与作用域 exposure：

![服务端权威的社会证据工作台](docs/assets/social-evidence.png)

### 时间线

原生 scheduler step、提交状态与执行证据：

![原生时间线与证据检查器](docs/assets/timeline-evidence.png)

### 评测

版本化指标、证据引用与 promotion 分类：

![评测指标工作台](docs/assets/evaluation-metrics.png)

投影视图：

| 视图 | 用途 |
| --- | --- |
| `live-public` | 运行中公开桌面；无隐藏角色 / 私有备忘 |
| `postgame-redacted` | 本地研究；私有认知脱敏，可保留赛后真相 |
| `truth-redacted` | 对外分享；私有证据与赛后真相均脱敏 |

---

## 快速开始

### 环境要求

- Node.js 22+
- npm 10+
- 用于真实模型运行的 OpenAI-compatible 流式端点

### 安装

```bash
git clone https://github.com/multi-zhangyang/werewolf-multi-agent-social-harness.git
cd werewolf-multi-agent-social-harness
npm install
cp .env.example .env
```

### 配置

`.env` 中配置：

```bash
LLM_CHAT_COMPLETIONS_URL=https://your-provider.example/v1/chat/completions
LLM_API_KEY=your-key
LLM_MODELS=your-model-id
LLM_STREAM=true
```

Live 请求必须使用 `stream: true`。OpenAI-compatible Chat Completions 路径默认不发送 `max_tokens` / `max_completion_tokens`。不要把密钥写入 README、测试、截图或提交到仓库。

### 本地驾驶舱

```bash
npm run dev
```

- API：`http://127.0.0.1:8787`
- Web：Vite 开发服务器将 `/api` 代理到 API

### 冒烟检查

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

---

## CLI 与 API

### 通过生产 actor 边界探测模型

```bash
npm run agent:probe -- --models=your-model-id --timeout=90s
```

探测走真实流式 completion → 生产 scaffold 认知 → policy/仲裁 → 纯环境 `validateAction()`。它不提交环境转换，也不写持久 actor 状态。

### 有界对局

```bash
npm run arena:match -- \
  --models=your-model-id \
  --maxTransitions=8 \
  --timeout=180s \
  --json=summary
```

省略 `maxTransitions` 表示不设 transition 上限；截断与失败都会保留工件。

### 锦标赛

```bash
npm run arena:tournament -- \
  --models=your-model-id \
  --games=1 \
  --maxTransitions=8 \
  --timeout=300s \
  --json=summary
```

### Replay

```bash
npm run arena:replay -- --artifact=path/to/match.json
```

Replay 不调用模型。

### 主要 HTTP 路由

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 安全的健康摘要 |
| `GET` | `/api/config` | 模型、profile、能力 |
| `POST` | `/api/matches/run` | 启动对局；`live: true` 返回 202 + live 投影流 |
| `GET` | `/api/matches/:id/live` | 严格公开的 live 桌面 |
| `GET` | `/api/matches/:id/artifact?view=postgame-redacted` | 研究工件投影 |
| `POST` | `/api/matches/:id/replay` | 不调用模型的 replay 摘要 |
| `POST` | `/api/matches/:id/checkpoints` | 最终或前缀 checkpoint |
| `POST` | `/api/checkpoints/:id/fork` | 从 checkpoint fork |
| `GET` | `/api/comparisons` | 对比注册表 |
| `POST` | `/api/tournaments/run` | 锦标赛 + 可选工件导出 |

完整工件、checkpoint 变更、赛后原生 replay 等操作接口按配置保持 local/loopback 门控。

---

## 验证

仓库门禁：

```bash
npm run ci
```

等价于：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

CI 在 GitHub Actions（`Validate` workflow）跑同一路径。测试套件包含 58 个文件、651 个确定性单元与集成测试。

真实 provider 验证独立进行，且必须是真实流式调用：

```bash
npm run agent:probe -- --models=your-model-id --timeout=90s
npm run arena:match -- --models=your-model-id --maxTransitions=4 --timeout=180s --json=summary
```

零 harness 错误的有界截断对局即为有效的流式路径证据；只有 `game_over` 才算完成的领域结局。

---

## 设计原则

1. **Harness 优先。** 领域适配器证明运行时，而不是定义运行时。
2. **服务端投影是权威。** 浏览器永远看不到不该看的隐藏真相。
3. **确定性高于便利。** Replay、哈希与工件胜过 transcript 的感觉。
4. **证据支撑评测。** 没有证据引用的指标进不了计分卡。
5. **测量驱动优化。** 性能改动必须携带可复现的测量依据。

---

## 许可证

[Apache License 2.0](LICENSE)
