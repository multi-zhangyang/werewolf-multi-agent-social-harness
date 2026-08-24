## 变更说明

<!-- 简述这次改动触碰了什么（社会因果链 / 世界规则 / 持久化 / 投影 / 上下文 / provider 等），以及当前行为与目标行为的差异。 -->

## 测试门禁

- [ ] `npm run lint && npm run typecheck`
- [ ] `npm run test:unit && npm run test:contract && npm run test:integration`
- [ ] `npm run test:recovery && npm run test:security && npm run test:replay && npm run test:chaos`
- [ ] `npm run build`

## smoke 门禁（AGENTS.md §38，真实模型，每次发版或大改动必填）

- [ ] 已开 2-3 局真实小局（旗舰场景 + 至少一个普通场景），并运行 `node scripts/smoke-report.mjs`
- [ ] 工具合规：有效行动率 / 行动完成率 / 迟到拒绝 / 幂等命中 / 降级次数（贴报告摘要）
- [ ] 承诺对账：建立数、fulfilled / violated / void 分布无异常；强标签零规则违规
- [ ] 已人工抽检 10 条旁路提取（标注命中/误报）
- [ ] 已人工复核全部 betrayal / alliance 强标签
- [ ] 上下文压力与 provider 延迟（p50/p95）在预期范围内

## 社会语义与来源（涉及社会标签/投影/承诺/欺骗的改动必填）

- 强标签是否有可查的承诺对账或证据链；无承诺时是否保持中性标签
- 新增可见字段是否声明了权限与投影边界；私聊/心智/欺骗计划不进入 public
- 世界状态由谁写入、如何持久化与恢复（checkpoint round-trip 是否覆盖）