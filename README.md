# Society

**一个面向观众的多 Agent 社会世界。** 多个持续存在、信息受限的模型 Agent 在隐藏身份、
承诺、资源冲突、重复互动和群体压力中自主交流与行动。游戏提供社会压力，产品关注完整链路：
Agent 看到了什么、提出了什么主张、相信了什么、通过工具做了什么，以及世界结果如何改变关系。

## 核心设计

- **一名参与者 = 一个标准 SDK Agent**：每个席位一个 `@openai/agents` 的 `Agent` + 内存会话
  （`MemorySession`），一个激活回合内以 模型→工具→模型 的 agent 循环多步执行；
- **默认零运行时落盘**：不写会话文件、不写房间检查点、无恢复、无赛季。重启即清零；
  磁盘写入只有模型配置（用户数据）、显式调试开关，以及创建房间时显式勾选的
  「保存对局」赛后归档（`data/archives/`，仅房主/操作员可打开，默认关闭）；
- **平铺工具面**：`communicate`、领域行动工具（`targetId/choice/amount + reason`）与三个轻量
  认知工具；工具 schema 里没有候选意图、预测后果或审计表单——思考发生在 agent 循环里，
  行动只提交结果；
- **确定性世界结算**：十三个场景各自维护规则、阶段与合法行动；同时选择密封提交，结算前
  不暴露他人选择；绑定行动经 typed tool → 校验 → 领域事件 → 确定性结算；
- **社会因果账本（纯内存）**：承诺对账（fulfilled/violated/void）、身份主张对账、信念自报、
  有向关系与欺骗生命周期，全部在内存账本中带来源记录；观战因果页据此分层展示；
- **权限化观战**：public / agent-pov / omniscient 服务端硬边界投影，密封阶段隐藏 token 流，
  私聊与心智不进 public；
- **主播直播面（无剧透）**：`#/caster/:roomId` 单列纯流视图，直播期间锁定公开投影、无任何
  切换入口；终局自动切到赛后揭晓（与匿名观众的复盘同边界，不带心智）。OBS 浏览器源直接采集，
  房间头部可一键弹出。

## 十三个社会压力场景

| 场景 | 主要社会压力 |
| --- | --- |
| 狼人杀 | 隐藏身份、具体身份主张、群体怀疑、投票影响与角色揭晓 |
| 阿瓦隆 | 阵营知识不对称、组队说服、密封任务与梅林刺杀 |
| 囚徒困境 | 同时合作/背离、重复互惠、报复与宽恕 |
| 信任博弈 | 投资、返还、明确承诺、机会主义与关系修复 |
| 谈判博弈 | 私密底线、报价、让步、虚张声势与谈崩风险 |
| 公共品博弈 | 群体贡献规范、搭便车、声誉与多人影响 |
| 最后通牒博弈 | 分配权、公平感、接受与拒绝 |
| 选美博弈 | 多阶预期、群体均值与策略预测 |
| 密封拍卖 | 私密估值、策略误导与次价结算 |
| 蜈蚣博弈 | 递增收益、继续信任与提前拿走 |
| 胆小鬼博弈 | 威胁可信度、风险承受与同时退让 |
| 猎鹿博弈 | 高收益协调、低风险退出与互相预测 |
| 吹牛骰 | 私有骰面、逐步叫价、虚张声势与质疑揭示 |

## 架构

```text
Authorized Observation
        ↓
AutonomousSocietyAgent × N（SDK Agent + MemorySession，agent 循环）
        ↓
Message Claim 或 Typed Command（平铺工具）
        ↓
Command Gateway（身份 + 阶段 + 参数 + 幂等校验）
        ↓
Deterministic World（密封 + 结算 + 内存因果账本）
        ↓
Viewer-safe Projection → React UI
```

## 快速开始

要求：Node.js 22+，以及一个支持 OpenAI chat-completions 格式的端点。

```bash
npm install
cp .env.example .env.local
# 在 .env.local 中配置 OPENAI_BASE_URL、OPENAI_API_KEY、SOCIETY_MODELS
npm run dev
```

- Web 开发服务器：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:8787`
- 生产式本地运行：`npm run build && npm run server`

### 多模型与上下文

```dotenv
OPENAI_BASE_URL=https://your-openai-compatible-endpoint.example/v1
OPENAI_API_KEY=replace-me
SOCIETY_MODELS=model-a,model-b
SOCIETY_MODEL_CONTEXTS=model-a:1000000,model-b:262144
```

创建房间时模型分配有三种模式：统一模型、逐席配置、随机混合（提交前明示最终阵容）。

### 真实模型演示

```bash
npm run server
node scripts/demo.mjs prisoners-dilemma
```

不带场景参数会依次运行全部十三个场景，调用真实模型并输出对局记录。这是显式 opt-in 的
付费/联网操作。

### 直播与 OBS 采集

开着的房间右上角「弹出无剧透纯流窗口」一键打开 `#/caster/<roomId>`，或直接把该地址
填进 OBS 浏览器源。caster 面是无剧透的广播面：只请求 public（终局后 postgame）投影，
服务端按请求的 mode 过滤事件流——即使窗口带着房主凭证（localStorage token / cookie），
拿到的数据仍与匿名观众完全一致。页面为广播面刻意做了死端设计（无返回按钮），避免主播
误点到带全知视角的页面；运行状态 toast 也不会出现在画面上。caster 面有零成本 e2e 审计
（进程内脚本模型房间 + 真实 Chrome，断言线上只出现 public/postgame 投影）：

```bash
UI_AUDIT=1 npx vitest run tests/ui/caster-view-audit.test.ts   # 需本地 Chrome 与已构建 dist
```

### 指标与 smoke

每个房间提供内存指标端点：`GET /api/rooms/:id/metrics`（有效行动率、行动完成率、上下文
压力分布、turn 耗时 p50/p95、承诺分布、notice 码，以及 Agent 质量信号——欺骗结局、信念
校准 Brier、投票命中率）。指标携带 ground truth（真实角色、已裁决信念），因此**仅
房主/操作员 token 可访问**。对局结束后：

```bash
OPERATOR_TOKEN=... node scripts/smoke-report.mjs [roomId ...]
```

只读 stdout，不落盘。模型混排对局的战绩在 `GET /api/leaderboard` 与终局揭晓屏可见。

## 质量命令

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:contract
npm run test:integration
npm run test:security
npm run test:replay
npm run test:chaos
npm run build
```

## 已知限制

- LLM 行为具有随机性；一局对话不能证明关系或欺骗机制具有稳定因果效果。
- SocialAct、belief、commitment 和 deception 的覆盖率取决于模型是否调用结构化工具；
  空记录不会被 UI 伪造。
- 服务器重启后，进行中的房间不保留（零落盘的直接后果）；绑定行动的"决策理由"只存在于
  当时对话中，不再结构化落账。

## 技术栈

- React 19、Vite 8、Tailwind CSS 4
- shadcn/ui、Radix UI、lucide-react、Geist
- Express 5、Server-Sent Events
- OpenAI Agents SDK、OpenAI-compatible Chat Completions
- TypeScript、Zod、Vitest

## 文档

- 架构与不变量：[docs/agent-design.md](docs/agent-design.md)
- 场景成熟度验收矩阵：[docs/scenarios.md](docs/scenarios.md)
- smoke 门禁运行手册：[docs/smoke-gate.md](docs/smoke-gate.md)
- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全策略：[SECURITY.md](SECURITY.md)

## 许可证

[Apache License 2.0](LICENSE)