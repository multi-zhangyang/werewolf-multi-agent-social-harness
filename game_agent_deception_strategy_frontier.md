# 博弈型 Agent 的欺骗、信念建模与自博弈训练

> 前沿理论、系统架构与工程路线

## 摘要

对于狼人杀、阿瓦隆、扑克、谈判模拟等隐藏信息或不完全信息博弈，仅靠 Prompt 要求 Agent “狡猾、会欺骗、善于博弈”，通常只能改变语言风格，难以稳定产生真正有效的策略行为。

更可靠的方向，是把问题建模为一个**信念动力学控制问题**：Agent 不仅要推断真实状态，还要预测其他玩家相信什么、自己的言行如何改变这些信念，以及这种变化如何影响长期胜率。

一个较完整的技术组合是：

\[
\boxed{
\text{显式信念状态}
\times
\text{潜在策略空间}
\times
\text{多样化种群自博弈}
\times
\text{长期博弈收益}
\times
\text{均衡与利用的动态权衡}
}
\]

Prompt 更适合作为人格、格式和初始先验，而不是策略能力的主要来源。

---

## 适用范围与边界

本文讨论的是**规则明确、参与者知情的封闭博弈环境**，例如：

- 狼人杀、阿瓦隆、抵抗组织；
- 扑克、桥牌等不完全信息游戏；
- 多智能体谈判模拟；
- 安全沙盒中的战略推理与社交推理评测。

不建议将相同奖励目标直接迁移到现实用户交互、身份冒充、真实金融行为、现实关系操纵或非自愿参与者身上。

---

## 1. 重新定义“欺骗”

在博弈中，欺骗不等于“输出一句假话”。

真正有效的策略欺骗通常包含以下因果链条：

1. Agent 知道或相信真实状态是什么；
2. Agent 估计对手当前持有什么信念；
3. Agent 有意选择一个动作、发言或沉默策略；
4. 该动作改变了对手对局面的判断；
5. 对手因此采取不同的后续行为；
6. 这些行为最终提高了 Agent 或其团队的博弈收益。

否则，模型的幻觉、随机乱说、前后矛盾，也可能被错误地识别为“会欺骗”。

因此，不推荐使用以下奖励：

```text
说谎次数越多 -> 奖励越高
对手越相信错误信息 -> 奖励越高
```

更合理的目标是：

```text
某次言行
-> 对手信念改变
-> 对手行动改变
-> 长期博弈收益提高
```

有时最优策略是说真话，有时是隐瞒，有时是制造歧义，有时是暂不发言。模型应该从博弈收益中学习何时使用哪种策略，而不是被固定规定为“总要骗人”。

参考：

- [Defining and Characterizing AI Deception](https://arxiv.org/html/2312.01350v1)

---

## 2. 最关键的模块：显式信念状态

纯 LLM Agent 往往只维护自然语言记忆，例如：

```text
3 号看起来可疑，5 号可能是预言家。
```

这种表示对长期、稳定的博弈推理通常不够。更好的做法，是把内部状态结构化为：

\[
X_t =
\left(
  s_t^{public},
  x_i^{private},
  B_t,
  E_t,
  M_t
\right)
\]

其中：

- \(s_t^{public}\)：公共局面、投票、死亡、发言顺序、技能结果；
- \(x_i^{private}\)：自己的身份与私有信息；
- \(B_t\)：对各玩家身份、阵营和意图的概率分布；
- \(E_t\)：对手的策略类型或行为 embedding；
- \(M_t\)：对手如何看待自己和其他玩家的估计。

### 2.1 一阶信念

例如：

\[
P(\text{玩家 3 是狼人}) = 0.65
\]

### 2.2 二阶信念

更重要的是估计：

\[
P_{\text{玩家 5}}
(\text{玩家 5 认为“我是狼人”})
\]

也就是：

> 我认为，对方认为，我是什么身份。

### 2.3 基础贝叶斯更新

可以使用如下形式更新对玩家 \(j\) 的角色判断：

\[
b_{j,t+1}(r)
\propto
b_{j,t}(r)
P(a_t,u_t\mid r,h_t,e_j)
\]

其中：

- \(b_{j,t}(r)\)：玩家 \(j\) 属于角色 \(r\) 的当前后验；
- \(a_t\)：投票、查验、保护、击杀等游戏动作；
- \(u_t\)：公开发言；
- \(h_t\)：公共历史；
- \(e_j\)：玩家 \(j\) 的对手类型表示。

### 2.4 推荐实现

可选择：

- 因子图；
- 粒子滤波；
- 贝叶斯网络；
- 角色组合枚举；
- 神经信念追踪器；
- 结构化概率模型与 LLM 的混合系统。

推荐让 LLM 负责理解发言和生成假设，让概率模块负责维护一致的后验分布。

相关工作：

- [GRAIL: Graphical Reasoning for AI in Language Games](https://aclanthology.org/2026.acl-long.1497/)
- [ReBeL: Combining Deep Reinforcement Learning and Search for Imperfect-Information Games](https://arxiv.org/html/2007.13544v2)

---

## 3. 不要直接在无限文本空间中做强化学习

自然语言动作空间极其庞大。同一个战略意图可能有成千上万种表述：

- 公开指控；
- 轻度怀疑；
- 试探性提问；
- 有条件站队；
- 延迟暴露身份；
- 保护队友；
- 主动牺牲；
- 制造投票分裂；
- 保持沉默。

直接在 token 空间内做强化学习，会遇到：

- 探索效率低；
- 奖励方差大；
- 容易学习表面话术；
- 难以做反事实比较；
- 难以用 CFR、PSRO 等经典博弈算法。

更可行的架构是：

```text
对话与游戏历史
        |
        v
策略编码器
        |
        v
潜在战略意图 z_t
        |
        v
CFR / PSRO / RL / 搜索规划
        |
        v
选定战略意图
        |
        v
语言实现模型
        |
        v
具体发言、投票、沉默或技能动作
```

### 3.1 初始潜在策略集合

```text
CLAIM_ROLE
SOFT_CLAIM
DELAY_REVEAL
ACCUSATION
DEFENSE
TEST_CONSISTENCY
PROBE_ALLIANCE
COORDINATE
SACRIFICE
MISDIRECT
ABSTAIN
SILENCE
```

### 3.2 不要永远依赖人工枚举

可采用以下迭代：

1. 人工定义 16 到 32 个粗粒度策略；
2. 对专家轨迹和自博弈轨迹进行 embedding；
3. 聚类发现新的策略簇；
4. 用长期博弈价值判断是否保留；
5. 周期性扩展、合并或删除潜在动作。

“什么时候说话”也应当是动作的一部分，而不只是“说什么”。

相关工作：

- [LSPO: Language Self-Play Optimization](https://arxiv.org/abs/2502.04686)
- [Werewolf Arena](https://arxiv.org/html/2407.13943v1)

---

## 4. 核心训练信号：长期信念塑形

仅奖励“对手降低对我的怀疑”是短视的。

某一回合降低嫌疑，并不一定提高最终胜率；有时主动增加自己的嫌疑，反而可以保护更重要的队友，或者制造更有利的投票结构。

因此，推荐让终局收益决定什么样的信念变化是有价值的。

### 4.1 Belief Critic

训练一个价值模型：

\[
V_\phi(o_t,B_t)
\]

其中：

- \(o_t\)：当前可观测状态；
- \(B_t\)：对手及全局信念状态；
- \(V_\phi\)：从当前信念状态出发的长期预期收益。

可构造多步目标：

\[
L_{\text{BOS}}
=
-
V_\phi(o_{t+k},B_{t+k})
\]

梯度或优势信号穿过未来若干步的信念更新，回传到当前策略。

这允许 Agent 学习：

- 对敌方隐藏身份；
- 对可信盟友适度暴露信息；
- 暂时增加自己的嫌疑以掩护队友；
- 在前期埋下叙事伏笔；
- 在后期利用先前形成的信念结构。

### 4.2 推荐奖励形式

\[
R =
R_{\text{terminal}}
+ \lambda_l R_{\text{legal}}
+ \lambda_c R_{\text{calibration}}
+ \lambda_b \Delta V_\phi(o,B)
- \lambda_h R_{\text{reward-hacking}}
- \lambda_k D_{KL}(\pi\|\pi_{\text{base}})
\]

其中：

- \(R_{\text{terminal}}\)：最终胜负或团队效用，作为主要信号；
- \(R_{\text{legal}}\)：动作合法、遵守回合和信息权限；
- \(R_{\text{calibration}}\)：身份推理是否校准；
- \(\Delta V_\phi(o,B)\)：信念变化带来的长期价值；
- \(R_{\text{reward-hacking}}\)：自相矛盾、利用裁判漏洞、非法泄漏；
- KL 项：防止策略坍缩为怪异语言或单一套路。

最重要的原则是：

> 不要给“骗成功”一个脱离终局收益的固定正奖励。

相关工作：

- [Bayesian Belief Manipulation in Hidden-Role Games](https://arxiv.org/abs/2209.01551)
- [D-BOS](https://arxiv.org/html/2605.29042)

---

## 5. 使用种群自博弈，而不是单模型镜像自博弈

单模型自己和自己玩，常见问题包括：

- 所有角色形成相同语言习惯；
- 学会利用自己的固定弱点；
- 产生只有同类模型理解的暗号；
- 策略循环而不真正进步；
- 面对新模型或人类时迅速失效。

推荐维护一个异构对手池：

```text
Population =
  当前策略
  + 历史 checkpoint
  + 不同规模模型
  + 不同 prompt / persona 模型
  + 规则型机器人
  + 搜索型机器人
  + 均衡策略近似器
  + 针对当前 Agent 训练的 best response
  + 经脱敏的人类轨迹策略
```

### 5.1 PSRO 风格训练循环

```text
1. 从 population 的 meta-strategy 中抽取对手
2. 进行多角色、多座位 rollout
3. 建立 cross-play payoff matrix
4. 计算新的 meta-strategy
5. 针对该种群训练近似 best response
6. 将新策略加入策略档案
7. 保留旧 checkpoint，防止遗忘和策略循环
```

### 5.2 不同算法的分工

- 小型或抽象子博弈：CFR；
- 整体策略种群：PSRO；
- 在线语言策略：PPO、GRPO、KTO；
- 决策时搜索：MCTS、有限深度 rollout；
- 部署阶段：将搜索策略蒸馏回快速策略模型。

相关工作：

- [MaKTO, NeurIPS 2025](https://proceedings.neurips.cc/paper_files/paper/2025/hash/9d276b0a087efdd2404f3295b26c24c1-Abstract-Conference.html)
- [Counterfactual Regret Minimization](https://proceedings.neurips.cc/paper/2007/file/08d98638c6fcd194a4b1e6992063e944-Metadata.json)
- [SPIRAL, ICLR 2026](https://proceedings.iclr.cc/paper_files/paper/2026/hash/3ba7c8c36b71b2fc31fae3361aefefbf-Abstract-Conference.html)
- [PLAYPEN, EMNLP 2025](https://aclanthology.org/2025.emnlp-main.1517/)

---

## 6. 同时训练均衡底座与对手利用能力

真正强的博弈 Agent 不能只有一种策略模式。

### 6.1 均衡底座

面对未知对手时，策略应尽量接近不易被利用的均衡策略：

\[
\pi_{\text{base}} \approx \pi_{\text{Nash}}
\]

它负责：

- 避免暴露明显模式；
- 防止被针对性打穿；
- 在对手信息不足时保持稳健。

### 6.2 对手利用策略

当观察到某个对手存在稳定弱点时，切换到近似 best response：

\[
\pi_{\text{exploit}}(a\mid o,e_j)
\]

其中 \(e_j\) 是根据对手历史推断出的策略类型表示。

### 6.3 动态混合

\[
\pi =
(1-\alpha_t)\pi_{\text{base}}
+
\alpha_t\pi_{\text{exploit}}
\]

\[
\alpha_t =
f(
\text{对手类型置信度},
\text{样本数量},
\text{估计可利用程度}
)
\]

证据不足时保持均衡；证据积累后逐渐针对对手。

相关工作：

- [HOP: Hierarchical Opponent Modeling and Planning](https://proceedings.mlr.press/v235/huang24p.html)

---

## 7. 推荐系统架构

```text
+-----------------------------+
| 权威规则引擎                |
| 身份、技能、阶段、合法动作  |
+--------------+--------------+
               |
               v
+-----------------------------+
| 结构化事件日志              |
| 发言、投票、技能、时间顺序  |
+--------------+--------------+
               |
               v
+-----------------------------+
| 信念追踪器                  |
| 角色后验、联盟后验、二阶信念|
| Factor Graph / Particle Set |
+--------------+--------------+
               |
               v
+-----------------------------+
| 对手模型                    |
| 类型 embedding、目标、习惯  |
+--------------+--------------+
               |
               v
+-----------------------------+
| 战略规划器                  |
| CFR / PSRO / MCTS / RL      |
| 均衡策略 + best response    |
+--------------+--------------+
               |
               v
+-----------------------------+
| 潜在战略意图 z_t            |
| 指控、试探、隐藏、协调等    |
+--------------+--------------+
               |
               v
+-----------------------------+
| 语言实现模型                |
| 将意图转成自然、角色一致发言|
+--------------+--------------+
               |
               v
      发言 / 投票 / 技能 / 沉默
```

### 7.1 规则引擎必须是确定性的

不要让 LLM 自己决定：

- 某动作是否合法；
- 某角色是否仍然存活；
- 技能是否已使用；
- 投票结果；
- 游戏是否结束；
- 哪些信息属于私有信息。

这些都应由确定性环境维护。

### 7.2 内部状态示例

```json
{
  "role_posterior": {
    "player_2": {
      "wolf": 0.12,
      "seer": 0.54,
      "villager": 0.34
    }
  },
  "opponent_type": {
    "player_2": {
      "aggressive": 0.65,
      "risk_averse": 0.20
    }
  },
  "belief_about_self": {
    "player_2_thinks_i_am_wolf": 0.42
  },
  "candidate_intents": [
    {
      "intent": "SOFT_ACCUSATION",
      "expected_value": 0.18,
      "risk": 0.21
    }
  ],
  "selected_intent": "PROBE_CONSISTENCY"
}
```

LLM 负责理解与生成，概率模块、规则引擎和价值模型负责一致性与约束。

---

## 8. 分阶段训练路线

### 阶段 1：规则与基本行为

使用专家局、规则型 Agent、自生成后筛选轨迹进行 SFT。

重点学习：

- 不违反规则；
- 正确记忆事件；
- 发言与已知信息一致；
- 完成角色基本职责；
- 输出结构化 belief 和 intent。

### 阶段 2：训练信念追踪器

单独监督以下任务：

- 玩家身份后验；
- 下一步投票预测；
- 下一步发言意图预测；
- 二阶信念；
- 对手策略类型。

可使用组合损失：

\[
L_{\text{belief}}
=
L_{\text{role CE}}
+ \lambda_1 L_{\text{action prediction}}
+ \lambda_2 L_{\text{Brier}}
+ \lambda_3 L_{\text{opponent type}}
\]

除了分类准确率，还要评估概率校准。

### 阶段 3：学习潜在策略

从轨迹中抽取：

```text
局面
-> 战略意图
-> 实际表述
-> 后续信念变化
-> 终局结果
```

在小型抽象游戏中运行 CFR 或搜索，得到较好的策略分布，再通过 DPO、KTO 或行为蒸馏教回语言模型。

### 阶段 4：种群在线自博弈

每个 batch 随机化：

- 模型家族；
- 历史 checkpoint；
- 座位；
- 身份；
- 发言风格；
- 玩家理性程度；
- 是否容易被说服；
- 风险偏好；
- 随机失误率。

不要假设所有对手都严格理性。

参考：

- [Behavioral Game Theory for LLM Agents](https://arxiv.org/abs/2502.20432v3)

### 阶段 5：加入多步 Belief Critic

在 PPO 或 GRPO 的正常优势估计之外，加入：

\[
A_t^{belief}
=
V(o_{t+k},B_{t+k})
-
V(o_t,B_t)
\]

但要限制其权重，并使用终局回报训练 \(V\)，避免 belief model 自己定义“成功”。

### 阶段 6：蒸馏与压缩

训练期可使用：

- 多次采样；
- 搜索；
- 对手模拟；
- 强 verifier；
- 多模型委员会。

部署时蒸馏为：

```text
一次 belief 更新
+ 一次 latent intent 选择
+ 一次语言生成
```

---

## 9. 评测不能只看胜率

### 9.1 分层胜率

按以下维度拆分：

```text
身份 x 座位 x 对手类型 x 游戏长度 x 模型版本
```

狼人阵营与好人阵营必须分开统计。

### 9.2 Cross-play Matrix

令所有 checkpoint 相互比赛：

\[
M_{ij}
=
\text{policy}_i
\text{ 对 }
\text{policy}_j
\text{ 的收益}
\]

用来识别循环克制，而不是只比较新旧版本。

### 9.3 Frozen Opponent Pool

保留完全不参与训练的固定对手池，防止评测被自博弈分布污染。

相关工作：

- [Mindgames](https://arxiv.org/abs/2605.29512)

### 9.4 可利用度

在小型抽象游戏中：

\[
\operatorname{Exploitability}(\pi)
=
V(\operatorname{BR}(\pi),\pi)
-
V(\pi,\pi)
\]

在完整狼人杀中难以精确计算时，可以训练多个 adversarial best responder，以其最高收益作为近似下界。

### 9.5 信念质量

至少评估：

- Brier score；
- log loss；
- Expected Calibration Error；
- 身份后验随时间的轨迹；
- 获得新证据后的更新合理性。

### 9.6 因果影响力

不要只测“对手是否相信”。应比较：

```text
原始发言下的对手动作
vs.
替换或删除该战略意图后的对手动作
```

定义：

\[
\operatorname{CausalImpact}(u_t)
=
E[R\mid u_t]
-
E[R\mid do(u_t=u'_t)]
\]

### 9.7 欺骗生产与检测

可将欺骗细分为：

- 隐瞒；
- 扭曲；
- 捏造；
- 误导。

这些更适合作为诊断指标，而不是主要奖励。

参考：

- [WOLF Benchmark](https://arxiv.org/pdf/2512.09187)

### 9.8 泛化评测

测试：

- 未见过的模型；
- 不同语言风格；
- 不同规则变体；
- 不同玩家人数；
- 噪声发言；
- 错误或不完全记忆；
- 人类玩家；
- 与训练分布不同的理性水平。

---

## 10. 常见失败模式

### 10.1 所有角色使用同一模型和同一 Prompt

容易形成自洽但脆弱的“模型方言”。

### 10.2 直接奖励怀疑度下降

Agent 会学会无意义地隐藏，而不是根据团队利益决定何时暴露。

### 10.3 让 LLM 裁判决定全部规则

合法动作和胜负必须由程序判定。LLM judge 只适合处理难以程序化的语言属性。

### 10.4 只训练终局胜负奖励

终局信号过于稀疏。需要身份预测、动作预测、合法性和价值估计等辅助任务，但辅助奖励不能压过真实博弈收益。

### 10.5 只看当前版本自博弈胜率

新版和新版互打的胜率没有充分意义。必须有冻结对手池、cross-play 和 best-response 测试。

### 10.6 将战略欺骗与事实幻觉混为一谈

Agent 对以下内容必须保持内部准确：

- 自己的私有身份；
- 已发生的事件；
- 规则状态；
- 当前存活玩家；
- 合法动作集合。

策略欺骗只发生在规则允许的公共通信层。

### 10.7 认为更大模型与更长 CoT 会自动产生博弈能力

模型规模和推理长度并不自动保证稳定的战略推理、对手建模和均衡行为。

---

## 11. 优先阅读清单

### 1. LSPO，ICML 2025

核心价值：把语言空间压缩为 latent strategy，再使用 CFR、RL 和偏好优化。

- [论文链接](https://arxiv.org/abs/2502.04686)

### 2. MaKTO，NeurIPS 2025

核心价值：多样模型池、逐步偏好反馈、KTO、多角色狼人杀训练。

- [论文链接](https://proceedings.neurips.cc/paper_files/paper/2025/hash/9d276b0a087efdd2404f3295b26c24c1-Abstract-Conference.html)

### 3. GRAIL，ACL 2026

核心价值：概率图信念推理与 LLM 分工，避免完全依赖自然语言隐式推理。

- [论文链接](https://aclanthology.org/2026.acl-long.1497/)

### 4. SPIRAL，ICLR 2026

核心价值：多轮、多智能体、在线自博弈和角色条件优势估计。

- [论文链接](https://proceedings.iclr.cc/paper_files/paper/2026/hash/3ba7c8c36b71b2fc31fae3361aefefbf-Abstract-Conference.html)

### 5. D-BOS

核心价值：将多步对手信念变化纳入长期价值优化。

- [论文链接](https://arxiv.org/html/2605.29042)

### 6. ReBeL

核心价值：公共信念状态、搜索、自博弈与不完全信息博弈求解。

- [论文链接](https://arxiv.org/html/2007.13544v2)

### 7. Mindgames

核心价值：跨游戏战略评测、冻结参考池与评测混淆分析。

- [论文链接](https://arxiv.org/abs/2605.29512)

---

## 12. 推荐的最小可行版本

第一版不建议直接做“通用欺骗 Agent”，而是实现以下闭环：

1. 确定性规则引擎；
2. 结构化事件日志；
3. 一阶身份信念追踪；
4. 16 到 32 个潜在策略动作；
5. 策略选择器；
6. 语言实现模型；
7. 历史 checkpoint 对手池；
8. 终局收益加轻量辅助奖励；
9. cross-play 与冻结对手评测。

在此基础上，再逐步增加：

- 二阶信念；
- 对手类型 embedding；
- PSRO；
- CFR 子博弈；
- 多步 Belief Critic；
- 搜索与策略蒸馏。

---

## 结论

一个真正会博弈、会隐藏、会误导、会合作、会利用对手弱点的 Agent，不应被定义为“一个更会说谎的语言模型”。

更合理的定义是：

> 一个能够维护多层信念、预测不同对手、在潜在战略空间中规划、通过种群自博弈学习，并根据长期胜率选择隐藏、揭露、试探、合作或误导行为的 Agent。

推荐优先级：

1. 先做结构化 belief tracker；
2. 再做 latent strategy 层；
3. 建立历史 checkpoint 与异构 Agent 的 population；
4. 终局收益为主，belief shaping 为辅；
5. 加入 CFR 或 PSRO 的均衡约束；
6. 使用冻结对手池、可利用度和信念校准进行评测。

Prompt 只能告诉模型“应该表现成什么样”；真正的训练系统，才能让它通过博弈结果学会：

- 什么时候说真话；
- 什么时候隐藏；
- 什么时候试探；
- 什么时候牺牲；
- 对什么样的对手使用什么策略；
- 以及如何在不被反向利用的前提下提高长期胜率。
