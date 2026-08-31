# Smoke 门禁运行手册

每次发版或大改动后手动执行：2-3 局真实小局 → 汇总内存指标 → 人工抽检 → 结果贴进 PR。

## 前置条件

- Node 22+，已按 `.env.example` 配置 `OPENAI_BASE_URL` / `OPENAI_API_KEY`；
- 模型配置中心（或 `SOCIETY_MODELS`）中至少有一个 `enabled + protocol passed` 的模型档案；
- 禁用模型不会被 doctor、创建房间或 smoke 调用。

## 步骤

```bash
# 1. 检查本机配置、存储和所有已启用模型的真实协议流程
npm run doctor

# 2. 启动服务端（生产式）
npm run server

# 3. 开 2-3 局真实小局（旗舰 + 一个普通场景；demo 会等待每局 finished）
node scripts/demo.mjs werewolf prisoners-dilemma
#    可选：DEMO_ROUNDS=3（默认）、DEMO_PLAYERS、DEMO_REASONING_EFFORT（默认 high）、
#    DEMO_TIMEOUT_MIN（默认 20；狼人杀等 9 席长局实际跑 60-90+ 分钟，需调大，如 90）
```

`demo.mjs` 会轮询房间状态，paused 时自动 resume（需要 `DEMO_OPERATOR_TOKEN` 与
`/api/rooms/:id/resume` 权限）。

```bash
# 4. 汇总指标（读运行时内存 /api/rooms/:id/metrics，不落盘）
#    metrics 端点携带 ground truth（真实角色、已裁决信念），需要鉴权：
#    设置 OPERATOR_TOKEN=$SOCIETY_OPERATOR_TOKEN（或用某房间的 owner token 走 ROOM_TOKEN）
OPERATOR_TOKEN=... node scripts/smoke-report.mjs
```

## 报告里看什么

- **工具合规**：有效行动率、行动完成率（直接完成 / 经重试轮）、幂等命中、迟到拒绝、
  无效拒绝、弃置回合、notice 码；
- **上下文压力**：level 分布与峰值 pressureRatio；
- **Provider 延迟**：成功 turn 墙钟耗时的 p50 / p95；
- **承诺对账**：建立数与 fulfilled / violated / void 分布；
- **社会行为提取**：按来源分布（explicit-tool / model-extracted）与提取失败计数；
- **Agent 质量（全知视角）**：每个 agent 的欺骗结局（被信/被识破）、信念校准
  （对已裁决命题的 Brier 分，越低越好，0.25 = 永远说 50% 的基线）、
  投票命中率（狼人杀：投中真狼的票数）——这些衡量"演得好不好"，
  与合规指标衡量"协议对不对"互补。

## 人工抽检与结果记录

1. 对局结束后打开房间的因果页，抽检 10 条旁路提取（标注是否属实）；
2. 复核全部 betrayal / alliance 强标签（若有），确认有可查证据链；
3. 把报告摘要与抽检结论贴进 PR（`.github/pull_request_template.md` 已内置清单）；
4. 不达标（有效行动率异常低、p95 显著恶化、抽检误报高）不合并。

## 已知限制

- 报告中的"p50/p95"是房间本地 turn 墙钟耗时（含模型调用与工具往返），不是
  provider 服务器内部时间——只用于横向比较；
- 指标只存在于进程内存：服务器重启后无法回看历史对局指标，请在对局结束后立即跑
  smoke-report。
