# 合伙人流式界面与断点恢复

## 恢复位置

2026-10-03 23:47（北京时间），开发会话在接口返回 401 后中断。最后一个完成的操作是停止旧的 8794 服务，新服务尚未启动。源码、构建、实验数据库及 UI 证据均已落盘。2026-10-04 从该位置继续，完成导入、重启和浏览器验证。

## 界面结构

- 对话按人物的每次行动组织，公开发言、可展开的思考与工具、资金结果放在同一条记录中。
- AI Elements 的 Conversation、Message、Reasoning、Tool、Plan 负责展示。技能已安装在用户目录 `.agents/skills/ai-elements/`。
- 研究检查面板显示心理变化、计划、判断和证据，不再重复列出对话区工具。选择历史事件后读取对应检查点；分支比较同样按所选轮次取状态。
- 实验页面使用参数配置、样本表和结果标签页；手机上以 Sheet 查看人物详情。删去主流程中反复出现的技术解释段落。
- 提供商增量通过研究专用 SSE 展示，允许研究者查看，不进入另一名 Agent 的输入。完成响应校验和世界事务提交前，局面不会因部分输出发生变化。

## 参考资料

上一会话通过 Exa 检索并提取了以下资料，原始检索和内容保存在 `data/partners-docs/ui-references/`：

- [LangChain 子 Agent 流](https://docs.langchain.com/oss/python/deepagents/frontend/subagent-streaming)：按 Agent 身份组织活动与状态。
- [LangChain Agent Chat UI](https://docs.langchain.com/oss/python/langchain/ui)：会话主区和独立检查区域。
- [LangSmith Studio](https://docs.langchain.com/langsmith/studio)：区分交互会话与执行细节。
- [AutoGen Studio](https://microsoft.github.io/autogen/stable/user-guide/autogenstudio-user-guide/usage.html)：团队配置与运行空间分离。
- [AI Elements Chatbot](https://elements.ai-sdk.dev/examples/chatbot)：消息、思考和工具的组件组合。

## 验证

| 证据 | 结果 |
| --- | --- |
| `data/partners-ui/final-ci.log` | lint、TypeScript、34 文件 / 221 测试及生产构建通过；仍有 509 kB 分块体积警告 |
| `data/partners-ui/recovery-play-test.log` | 三轮玩家操作、六个独立夹具分支、失败状态、草稿保留、键盘及深浅主题通过 |
| `data/partners-ui/scroll-layout-test.log` | 启用运行历史后可访问最早事件，保留历史回看能力 |
| `data/partners-ui/stream-layout-test.log` | 增量 SDK 夹具、稳定 DOM、研究流权限、对手隔离、失败部分输出、手机检查通过 |
| `data/partners-ui/cognition-layout-test.log` | 四条干预夹具分支、单步暂停、正式状态与行动、历史及手机检查通过 |
| `data/partners-ui/research-layout-test.log` | 无人类占位心理、历史轮次对齐、计划矛盾审计、隔离续跑源局不变通过 |

这些 UI 夹具使用真实接口、规则与 SDK 传输路径，但不能作为真实模型行为效果的证据。恢复后对 8794 的浏览器检查读取实际保存的探针记录，不调用模型或添加行动，结果保存在 `data/session-recovery-1791045007327/browser-result.json`。

完整 UI 脚本曾在模拟失败状态时偶发超时。原因是“0 / 6 已完成”在实验启动请求完成前就能满足旧等待条件，后续研究决策可能消费为失败局准备的夹具标记。当前脚本等待指定实验实际完成，断言 6 条完成、0 条失败，再确认新失败局的世界版本仍为 0。

## 真实模型与数据

模型仍为 Cardinalize `apodex/apodex-1.1-mini:free`。v13 固定情境取自 `data/partners-cognition-1791039410357/`：

| 情境 | 单次行动提交 | 耗时 | 工具错误 / 整次重试 |
| --- | --- | --- | --- |
| 普通开场 | 是 | 6.598 秒 | 0 / 0 |
| 背叛后回应 | 是 | 75.444 秒 | 6 / 1 |
| 私有收入结算 | 是 | 5.563 秒 | 0 / 0 |
| 末轮角色与计划 | 是 | 50.370 秒 | 5 / 1 |

四条心理干预分支（合作意愿 0.2 / 0.8 × 完整机制 / 只记录心理）均提交了“继续合作”。每格仅一个样本，无行动变化，不能据此声称心理干预有效或无效。v9、v12 的失败和未执行分支一并保留，未合并为 v13 成功率。尚未验证 90 条真实分支或完整自由局稳定性目标。

主库导入后的 38 条记录中，2 条完成、12 条失败、17 条暂停、7 条停止；暂停包括刻意只运行一步的诊断。导入不自动继续任何模型任务。备份 `before.sqlite`、试导入 `staging.sqlite`、源哈希和导入清单均在 `data/session-recovery-1791045007327/`。

本地交付服务只绑定 `127.0.0.1:8794`，沿用上一会话的进程级本地管理模式；没有改写 `.env.local`。本轮恢复核验的是本地服务与保存的数据，没有重新验证提供商当前可用性。
