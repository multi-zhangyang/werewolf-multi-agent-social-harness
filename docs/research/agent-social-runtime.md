# Agent 社会运行时的研究依据

Society 把语言模型放在有状态社会角色内部，而不是把多个回答拼成一段
聊天记录。每个角色持续拥有记忆、目标、信念和关系；环境负责可见性、规则
与副作用；观察者通过事件流看到真实交互。

## 设计取舍

- **记忆流**：经历先写入关联记忆，再按当前情境检索（recency × salience ×
  relevance × 情绪一致性）；高显著性事件可以影响后续关系与目标。对应
  Park et al. 的记忆流与反思循环。
- **反思**：反思是独立的 SDK Agent 调用，通过 `agent.asTool()` 提供给主
  Agent，不能直接发送消息或改变世界。对应 Generative Agents 的高阶反思。
- **行动边界**：发言和领域行动分别使用 SDK 工具。工具成功才会产生世界
  事件，最终文本不会被解析成命令 —— 模型输出永远不是协议。
- **欺骗工程化**：研究一致表明 LLM 默认合作、自发欺骗很弱
  （arXiv:2504.00285, arXiv:2406.13605），因此欺骗被设计为显式目标 + 信念
  管理 + 廉语（cheap talk）折扣，而不是期望自发涌现。
- **作用域观察**：每个角色只收到自己的私有信息、可见频道和当前世界投影。
  观察者 UI 可以展示事件，但不把浏览器状态当作规则真相。
- **可扩展场景**：囚徒困境、公共品、信任博弈、狼人杀、阿瓦隆、蜈蚣博弈等
  共享同一个房间与 Agent runtime；新增场景只需实现 `SocialWorld` 契约。

## 参考文献（全部经 arXiv 逐一核实）

- Park et al., *Generative Agents: Interactive Simulacra of Human Behavior* — [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)
- Zhou et al., *SOTOPIA: Interactive Evaluation for Social Intelligence in Language Agents* — [arXiv:2310.11667](https://arxiv.org/abs/2310.11667)
- Bakhtin et al., *Mastering the Game of No-Press Diplomacy via Human-Regularized RL and Planning* (Cicero) — [arXiv:2210.05492](https://arxiv.org/abs/2210.05492)
- Xu et al., *Exploring Large Language Models for Communication Games: An Empirical Study on Werewolf* — [arXiv:2309.04658](https://arxiv.org/abs/2309.04658)
- Chi et al., *AMONGAGENTS: Evaluating LLMs in the Interactive Text-Based Social Deduction Game* — [arXiv:2407.16521](https://arxiv.org/abs/2407.16521)
- Guo et al., *Suspicion-Agent: Playing Imperfect Information Games with Theory of Mind Aware GPT-4* — [arXiv:2309.17277](https://arxiv.org/abs/2309.17277)
- Kosinski, *Evaluating Large Language Models in Theory of Mind Tasks* — [arXiv:2302.02083](https://arxiv.org/abs/2302.02083)
- Street et al., *LLMs achieve adult human performance on higher-order theory of mind tasks* — [arXiv:2405.18870](https://arxiv.org/abs/2405.18870)
- Pan et al., *Do the Rewards Justify the Means? … MACHIAVELLI Benchmark* — [arXiv:2304.03279](https://arxiv.org/abs/2304.03279)
- Fontana et al., *Nicer Than Humans: How do LLMs Behave in the Prisoner's Dilemma?* — [arXiv:2406.13605](https://arxiv.org/abs/2406.13605)
- Taylor & Bergen, *Do Large Language Models Exhibit Spontaneous Rational Deception?* — [arXiv:2504.00285](https://arxiv.org/abs/2504.00285)
- Ou et al., *Social preferences with unstable interactive reasoning: LLMs in economic trust games* — [arXiv:2505.17053](https://arxiv.org/abs/2505.17053)
- Zhao et al., *CompeteAI: Understanding the Competition Dynamics in LLM-based Agents* — [arXiv:2310.17512](https://arxiv.org/abs/2310.17512)
- Bianchi et al., *How Well Can LLMs Negotiate? NegotiationArena Platform and Analysis* — [arXiv:2402.05863](https://arxiv.org/abs/2402.05863)
- Noh & Chang, *LLMs with Personalities in Multi-issue Negotiation Games* — [arXiv:2405.05248](https://arxiv.org/abs/2405.05248)
- Huang et al., *Who is ChatGPT? Benchmarking LLMs' Psychological Portrayal Using PsychoBench* — [arXiv:2310.01386](https://arxiv.org/abs/2310.01386)
- Lee et al., *TRAIT: Personality Testset designed for LLMs with Psychometrics* — [arXiv:2406.14703](https://arxiv.org/abs/2406.14703)
- Bhattacharyya et al., *LLMs show fragile cognitive reasoning about human emotions* — [arXiv:2508.05880](https://arxiv.org/abs/2508.05880)
- Manning et al., *Automated Social Science: Language Models as Scientist and Subjects* — [arXiv:2404.11794](https://arxiv.org/abs/2404.11794)
- Lupu et al., *The Decrypto Benchmark for Multi-Agent Reasoning and Theory of Mind* — [arXiv:2506.20664](https://arxiv.org/abs/2506.20664)

## 实现剧本

`docs/research/llm-social-agents-sota.md` 收录了逐条核实过的 23 篇论文与
可直接落地的实现剧本（记忆流、信念模型、欺骗意图槽、OCEAN 行为映射、
PAD 情绪评估）。