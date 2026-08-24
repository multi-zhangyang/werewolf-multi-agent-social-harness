# Smoke 门禁运行手册（AGENTS.md §38）

每次发版或大改动后手动执行：2-3 局真实小局 → 自动汇总 §37 指标 → 人工抽检 →
结果记录进 PR / 提交说明。不达标不合并。

## 前置条件

- Node 22+，已按 `.env.example` 配置 `OPENAI_BASE_URL` / `OPENAI_API_KEY`；
- 模型配置中心（或 `SOCIETY_MODELS`）中至少有一个 enabled 的模型档案；
- 注意：运行数据在 `data/`（gitignored），smoke 报告在 `artifacts/smoke/`（gitignored），
  都不进版本库——结果以文字形式贴进 PR。

## 步骤

```bash
# 1. 启动服务端（生产式）
npm run server

# 2. 开 2-3 局真实小局（旗舰 + 一个普通场景；demo 会等待每局 finished）
node scripts/demo.mjs werewolf prisoners-dilemma
#    可选：DEMO_ROUNDS=3（默认）控制回合数，DEMO_PLAYERS 控制席位，
#    DEMO_SEASON=one-shot（默认）让每局独立
```

`demo.mjs` 会轮询房间状态，paused 时自动 resume（需要 `DEMO_OPERATOR_TOKEN`
与 `/api/rooms/:id/resume` 权限）。若 demo 因超时退出而服务端仍在跑，可稍后用
`node scripts/capture-transcript.mjs` 从 API 抓取快照补全 transcript。

```bash
# 3. 汇总指标（读 data/rooms/*/checkpoint.json，输出到 artifacts/smoke/）
node scripts/smoke-report.mjs
```

## 报告里看什么

- **工具合规**：有效行动率、行动完成率（直接完成 / 经重试轮）、幂等命中、迟到拒绝、
  无效拒绝、推理降级通知；
- **上下文压力**：level 分布与峰值 pressureRatio（长时间处于 soft-compact 以上要说明）；
- **Provider 延迟**：成功 turn 墙钟耗时的 p50 / p95；
- **承诺对账**：建立数与 fulfilled / violated / void 分布；
- **强标签审计**：promise-kept / promise-broken / deception-exposed 的规则违规必须为 0，
  betrayal / alliance 全部人工复核；
- **旁路提取抽检样例**：报告末尾列出 10 条（按置信度），人工核对标注是否属实。

## 人工抽检与结果记录

1. 抽检 10 条旁路提取，记录命中/误报数；
2. 复核全部 betrayal / alliance 强标签，确认有可查证据链；
3. 把报告摘要与抽检结论贴进 PR（`.github/pull_request_template.md` 已内置清单）；
4. 不达标（规则违规 > 0、有效行动率异常低、p95 显著恶化、抽检误报高）不合并。

## 已知限制

- `data/rooms` 归档保留最近 24 个终局房间（`SOCIETY_ARCHIVE_MAX_ROOMS`）；
- 报告中的"p50/p95"是房间本地 turn 墙钟耗时（含模型调用与工具往返），不是
  provider 服务器内部时间——只用于横向比较，不对外宣称 provider 官方指标；
- SSE 断流恢复时长与 checkpoint 恢复成功计数尚未插桩（Phase D 前补齐）。