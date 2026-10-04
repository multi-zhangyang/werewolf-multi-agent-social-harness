# 个性化与交互体验：续作记录

2026-10-03。承接工作区中尚未提交的 v2 重构，不重置旧修改。当前研究优先级：同一处境下，不同性格能否产生可观察、可重复的行为差异。界面按用户要求使用黑白风格与暗黑模式。

## 中断时的进度与问题

已有独立 SDK Agent、事件队列、私有记忆、SQLite 快照、三类场景、真人操作与研究导出。之前的 `validation-v2.md` 记录了最后一批 15 局中 12 局完成，以及自然度与人物辨识度尚未验收。

此次确认两个数据链路问题：

- 人物库保存了 `traits`、`temperament`、`decisionBiases`、`regulation`、`autobiographicalAnchors`，但 `runtimeCharacter` 只传递人设、价值、目标和声音风格。额外人格信息没有进入模型。
- 人物编辑器固定保存 `traits: ["自定义"]`，并遗漏上述可选字段；修改名字也可能清除原来的丰富设定。

另一个配置问题是本机实际思考强度为 high，与先前文档的默认 low 不同。高强度不等于自然表达，也会占用输出预算。用户随后明确指定 Apodex 并授权安排思考强度，现将常规交流设为 low、实际行动设为 medium。

## 本轮实现

### 人格与实验

- 完整保存、复制、编辑和传递人格字段；转换时深复制，避免运行数据改变人物库。
- `runtime/personality.ts` 将性格、偏差和压力应对转为定性判断倾向。成长背景明确是虚构背景，不是对在场人物的指控或本局证据。
- 不指定投资金额或投票对象，不强制表现偏差，不要求展示隐藏思考过程。调整语言指令，允许直接追问、拒绝、提条件和沉默。
- 独立实验支持 `experiment.personality = full | persona-only`。后者仍有原有文字人设、目标、价值和声音；它是附加人格上下文的消融，不是“无个性”对照。
- 运行配置记录人格条件与提示版本。研究页显示真实发言数量、长度、精确重复、行动与对应事件编号；这些不是心理状态分数。
- 批量 `study --personality-ablation` 分组统计两个条件，同场景、样本编号、记忆和调度条件配对，保存匿名对话与独立配对密钥。失败样本保留。

### 界面与官方组件

- 黑白语义色板，默认深色；支持浅色、深色、跟随系统，保存选择并监听系统变化。
- 互动首页、场景入口、人物工作室、倾向面板、对照条件和研究页重新组织。
- 聊天使用官方 `Message`、`Bubble`、`MessageScroller`、`Marker`；输入区使用此次从官方 CLI 获取的 `InputGroup`。
- 工具活动使用官方 `Message`、`Item`、`Collapsible`、`Tabs`、`Badge`、`Separator` 组合，展示实际返回、输入和错误。同一行动及其工具回执合并展示，避免重复卡片。
- 房主在房间中选择“研究视角 · 含工具”可查看调用轨迹；普通公开视角不会因此获得私聊或工具输入。
- `@shadcn/helpers/ai-sdk` 用于离线浏览器夹具，固定消息和工具输入不会冒充模型输出。该 helper 是官方测试与预览工具，不是模型推理服务。
- 移动断点改用媒体查询订阅，截图等待布局稳定；固定高度房间按视口截图，避免浏览器全页截图临时改变视口造成抽屉动画残影。
- 补上设置页的“管理访问”入口：已有服务启用管理令牌时，新浏览器可保存或清除访问凭据；输入保存后清空，后续 API 写入使用该凭据。原有入口缺失会导致新浏览器无法开局或编辑人物。

官方来源：

- [Message](https://ui.shadcn.com/docs/components/radix/message)
- [Bubble](https://ui.shadcn.com/docs/components/radix/bubble)
- [Input Group](https://ui.shadcn.com/docs/components/radix/input-group)
- [AI SDK helper](https://ui.shadcn.com/docs/helpers/ai-sdk)
- [Vite dark mode](https://ui.shadcn.com/docs/dark-mode/vite)

当前 `message.tsx` 与最新官方 CLI 的差异只有项目 `cn` 导入路径。沿用已有 Radix 基础，不通过替换整个 preset 覆盖本地组件。官方 CLI 的 Windows 搜索命令偶尔在返回结果后触发 libuv 断言；文档读取和组件 view 已成功。

### 模型与搜索

- 本机默认模型固定为用户指定的 Cardinalize / `apodex/apodex-1.1-mini:free`。
- 旧模型定义保留但全部停用，默认随机池也只包含 Apodex。最终 `npm run doctor` 为 1/1，通过真实工具调用检查（约 3.6 秒）。此前旧配置中的四个启用模型返回 503，该结果不混入最终 Apodex 验收。
- 默认 low；实际行动由已有逻辑提高到 medium。产品运行默认输出预算仍为 8192。
- 两个服务的凭据仅保存在忽略的 `.env.local`；模型 JSON 仅包含环境变量引用。
- 资料检索已通过 Parallel `POST /v1/search` 的 advanced 模式实际调用。搜索用于开发与研究资料，不接入封闭博弈中，以免改变参与者可见信息与实验条件。

本轮最终预览为 http://127.0.0.1:8788，已通过健康接口与模型目录确认加载 low 配置、且仅启用 Apodex。旧 8787 服务保留，它仍缓存此前的全局 high 设置，因此本轮验收使用 8788。之后重新启动的默认服务会读取已保存的新配置。新端口的浏览器存储独立；如设置页要求管理凭据，沿用本机已有的 `SOCIETY_OPERATOR_TOKEN`。真实首页截图为 `data/v2-ui/home-live-dark.png` 和 `home-live-light.png`。

## 真实模型诊断：保留负面结果

以下均为固定合成情境：三人公共品博弈，上一轮有人承诺投入 6 却投入 0，最后一轮再次要求合作。每个条件单独创建 SDK 会话；名字和可见情境保持一致。每个条件含一次交流和一次真实工具提交，输出预算 4096，最多 6 次 SDK 步骤。这不是完整对局。

| 批次 | 条件 | 完成 | 实际行动观察 |
| --- | --- | --- | --- |
| `data/personality-v3-diagnostic` | 林默、陈策；完整 / 文字；配置 high；各 1 次 | 3/4 | 成功样本全部投入 0；陈策完整人格耗尽输出预算 |
| `data/personality-v3-contrast-low` | 林默、周岚；完整 / 文字；交流 low、行动 medium；各 2 次 | 6/8 | 林默成功样本为 0，周岚成功样本为 6；各有 1 个条件预算失败 |

第二批选择更有对比性的谨慎与公平人物，配置和人物集合都改变了，不能与第一批直接作因果比较。完整人格与文字人设条件在各人物的成功样本中行动一致；目前不能宣称额外人格字段提高了辨识度。人物之间的差异也混合了价值、目标、背景等多种因素，不能归因于单一 Big Five 维度。

语言仍存在冗长、错误推断和不必要的算账。例如，有回复把“最后一轮”误解成“承诺无法兑现”，实际本轮行动仍可兑现。不能用 UI 改善掩盖这个问题。人工自然度和心理真实性评分尚未进行。

所有诊断目录保存失败、原始输出、实际行动、配置、提供商响应计数、源文件和摘要。未收到的响应仍可能产生额外用量。

## 接下来最值得做的研究工作

1. **先定义行为假设。** 将“谨慎”“公平”具体化为投资比例、拒绝率、遭遇违约后的调整、对反证的反应。不要只询问 Agent 自评人格。
2. **做单因素对照。** 保持人设、目标、名字和模型相同，仅改变一个人格倾向；轮换座位、身份、对手与发言顺序。当前 full/persona-only 只回答附加上下文有没有额外作用。
3. **换成能区分机制的情境组。** 分别比较可靠履约、偶发违约、解释但未补偿、实际补偿、公开与私下承诺。最后一轮的支配策略可能压平差异，不能只用一种情境判断人格无效。
4. **重复采样并保留失败。** 预先确定样本量与主要指标；报告分布、置信区间与失败率。两次重复仅够诊断，不能声称显著性。
5. **分开评价表达与行动。** 人工盲评接话自然度、重复与人物辨识；行动指标来自世界事件。模型裁判最多作为辅助，不替代人工判断。
6. **之后再研究心理博弈。** 用可检验的预测比较“人物如何猜测对手”与对手实际行为，再研究欺骗、信任修复和跨局关系。避免恢复无依据的心理分数回写。

Parallel advanced 检索提供的研究入口：

- [How Personality Traits Shape LLM Risk-Taking Behaviour, ACL Findings 2025](https://aclanthology.org/2025.findings-acl.1085/)，涉及人格诱导、风险决策与自陈测量有效性。
- [Beyond Self-Reports: Multi-Observer Agents for Personality Assessment in Large Language Models](https://arxiv.org/abs/2504.08399)，指出自陈和观察者判断可能偏离。
- [PersonaFeedback](https://arxiv.org/abs/2506.12915)，将显式人物描述下的个性化能力与人物推断分开评价。

## 复现入口

```sh
npm run ci
npm run test:ui
npm run study:personality -- --count=2 --characters=builtin-01,builtin-04 --effort=low --output=data/新诊断目录
npm run study -- --personality-ablation --scenario=trust-game --count=5 --workers=2 --output=data/新实验目录
npm run study -- --analyze-only --output=data/已有实验目录
```

`study:personality` 的 `--effort` 只改变本次诊断内存配置，不修改保存的设置。已有批次拒绝覆盖。UI 图片保存在 `data/v2-ui`，其中对话来自明确的离线夹具。

验证：50 项离线测试、ESLint、TypeScript、构建；桌面与手机浏览器覆盖发言、私聊、人物复制编辑、字段保留、实验条件、工具展开、暗黑切换及持久化。浏览器验收启用真实管理鉴权，先通过设置入口保存测试令牌，再完成受保护的人物编辑与导入；实际 8788 服务另行验证令牌保存、输入清空、授权请求进入参数校验及本地清除。构建仍有约 530 KB 房间分块提示，主要包含富文本渲染，后续可进一步按需拆分。
