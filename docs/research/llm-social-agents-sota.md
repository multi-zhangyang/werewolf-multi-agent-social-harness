# Frontier Research Report: Making LLM Agents "Human-Like" in Social/Deception Games

**Scope:** Real, verified state of the art for building human-like (通人性) LLM social agents — persona, emotion, theory of mind, memory, persuasion, deception, grudges, reputation — targeting game-theory and social-deduction games built on the OpenAI Agents SDK (TypeScript).

**Verification method.** `web_search` was unavailable in this session (API auth failure), so every reference below was verified **directly against the source of truth**: the arXiv API (`export.arxiv.org`) and the `arxiv.org/abs/{id}` abstract pages, checking that the returned **title + authors + date exactly match** the claimed paper. No ID below is from memory; incorrect remembered IDs (e.g. `2111.03666`, `2310.05318`, `2105.xxx`) were caught and discarded during verification. Date stamps observed on arXiv's own HTML (`20260626`) indicate we are operating in 2026, so the literature below includes verified 2025–2026 works alongside the 2022–2024 foundational papers.

---

## Part 1 — Verified Reference List

Every entry: **arXiv ID → exact title → authors → year → verified URL.** All IDs confirmed live on arXiv at time of writing.

### A. Social intelligence / interactive evaluation

1. **2310.11667** — *SOTOPIA: Interactive Evaluation for Social Intelligence in Language Agents* — Xuhui Zhou, Hao Zhu, Leena Mathur, Ruohong Zhang, Haofei Yu, Zhengyang Qi, Louis-Philippe Morency, Yonatan Bisk, Daniel Fried, Graham Neubig, Maarten Sap — 2023 — https://arxiv.org/abs/2310.11667
   - **Takeaways:** (a) Social intelligence is not a scalar "smartness" — score it as a joint `(goal-completion × relationship (relationship-building/cooperation))` two-axis reward, not a single win/loss; agents that only optimize task goals score low on "human-like." (b) Use **multi-turn, open-ended social episodes** (`SOTOPIA-Eval`/`SOTOPIA-π`) where believability is judged by an LLM-as-critic against *social goals*, not just objective task success. (c) Ground agents in a **social reward model** (SOTOPIA-RL, `2508.03905`) so RL keeps social alignment while pursuing self-interest.

2. **2407.16521** — *AMONGAGENTS: Evaluating Large Language Models in the Interactive Text-Based Social Deduction Game* — Yizhou Chi, Lingjun Mao, Zineng Tang — 2024 — https://arxiv.org/abs/2407.16521
   - **Takeaways:** (a) A concrete, text-only Among Us-style environment where LLM role-players (crewmates/impostors) must **lie strategically under questioning** — direct template for Werewolf/Mafia voice + voting rounds. (b) Breaking **role-symmetry**: impostors must interleave truthful and deceptive statements to stay consistent — model this as "statement-consistency" pressure, not just lie-generation. (c) Evaluate deception as **survival under peers' belief-updating**, i.e. whether other agents *actually change their suspicion* — the right metric isn't "did it lie" but "did lies propagate."

3. **2309.04658** — *Exploring Large Language Models for Communication Games: An Empirical Study on Werewolf* — Yuzhuang Xu, Shuo Wang, Peng Li, Fuwen Luo, Xiaolong Wang, Weidong Liu, Yang Liu — 2023 — https://arxiv.org/abs/2309.04658
   - **Takeaways:** (a) Werewolf-specific framing: seer/witch/guardian roles need **asymmetric information reasoning** — give each role a private belief state and force public statements to be *consistent with* (not equal to) that state. (b) LLMs can frame claims with an exterior "focus" (accuse, defend, misdirect) — steer the model with an explicit **communication-intent slot** per utterance. (c) Shows LLM players are exploitable via **pattern detection** — a production deception agent must add stochastic "tells" and avoid repeating rhetorical templates.

### B. Generative agents, memory, reflection (the believability substrate)

4. **2304.03442** — *Generative Agents: Interactive Simulacra of Human Behavior* — Joon Sung Park, Joseph C. O'Brien, Carrie J. Cai, Meredith Ringel Morris, Percy Liang, Michael S. Bernstein — 2023 — https://arxiv.org/abs/2304.03442
   - **Takeaways:** (a) The **memory stream** — every observation scored by recency + importance + relevance, decayed, and retrieved to condition each action (see playbook §1). (b) **Reflection** — periodic synthesis of higher-level inferences ("I am being targeted by X") that are themselves re-inserted into memory. (c) **Planning + reaction** — short-horizon plans plus moment-to-moment reactive re-planning is what produces a "held-together" character rather than a stateless chatterbot.

5. **2210.05492** — *Mastering the Game of No-Press Diplomacy via Human-Regularized Reinforcement Learning and Planning* (Cicero, Meta) — Anton Bakhtin, David J Wu, Adam Lerer, Jonathan Gray, Athul Paul Jacob, Gabriele Farina, Alexander H Miller, Noam Brown — 2022 — https://arxiv.org/abs/2210.05492
   - **Takeaways:** (a) **Intent-conditioned natural-language messaging**: a planning module proposes *intents* (which move to negotiate for) and a separate dialogue module generates speech that *anchors on that intent* — decouple "what do I want" from "how do I say it." (b) **Human-behavior regularization**: filter actions/messages through a model of what a human would plausibly do — suppress superhuman-but-robotic play. (c) Integrate negotiation as **message → action coupling** across turns, not isolated bargaining sessions.

### C. Theory of mind in LLMs

6. **2302.02083** — *Evaluating Large Language Models in Theory of Mind Tasks* — Michal Kosinski — 2023 — https://arxiv.org/abs/2302.02083
   - **Takeaways:** (a) Classic false-belief tasks (Sally-Anne) are solvable by modern LLMs — so ToM is real but fragile; don't assume any single baseline. (b) Use **false-belief and faux-pas** probes to *calibrate* how deep an agent's inference goes in your game loop.

7. **2405.18870** — *LLMs achieve adult human performance on higher-order theory of mind tasks* — Winnie Street, John Oliver Siy, Geoff Keeling, Adrien Baranes, Benjamin Barnett, Michael McKibben, Tatenda Kanyere, Alison Lentz, Blaise Aguera y Arcas, Robin I. M. Dunbar — 2024 — https://arxiv.org/abs/2405.18870
   - **Takeaways:** (a) Higher-order ToM ("what does A think B thinks about A") is achievable — model **recursive belief nesting** explicitly when characters bluff or double-bluff. (b) Careful construct-valid protocol control (avoiding leakage) is required to get clean ToM scores — copy their control design when you eval your own agents.

8. **2309.17277** — *Suspicion-Agent: Playing Imperfect Information Games with Theory of Mind Aware GPT-4* — Jiaxian Guo, Bo Yang, Paul Yoo, Bill Yuchen Lin, Yusuke Iwasawa, Yutaka Matsuo — 2023 — https://arxiv.org/abs/2309.17277
   - **Takeaways:** (a) A **ToM-aware action module**: maintain a belief about *other players' beliefs/intents* and update it each turn (key for imperfect-information bluffing games). (b) Feeds the believed opponent model directly into move choice — template for a "read-the-room" step in Werewolf. (c) This is the concrete "mixed cooperative-competitive + ToM + human-like trust" implementation paper to copy architecture from.

9. **2505.00026** — *Theory of Mind in Large Language Models: Assessment and Enhancement* — Ruirui Chen, Weifeng Jiang, Chengwei Qin, Cheston Tan — 2025 — https://arxiv.org/abs/2505.00026
   - **Takeaways:** (a) Survey of both **measurement** (what ToM tasks to use) and **enhancement** (how to *improve* ToM) — enhancement techniques (reasoning scaffolds, belief-state prompting) are directly portable to your agents.

10. **2506.20664** — *The Decrypto Benchmark for Multi-Agent Reasoning and Theory of Mind* — Andrei Lupu, Timon Willi, Jakob Foerster — 2025 — https://arxiv.org/abs/2506.20664
    - **Takeaways:** (a) Multi-agent **cooperative-with-private-information** reasoning benchmark (cluemaster/guesser) — stresses genuine recursive reasoning under collusion against an interceptor; a strong eval template for team-vs-team deception games (e.g. Resistance/Avalon).

### D. Deception, lie detection, cooperation/defection dynamics

11. **2304.03279** — *Do the Rewards Justify the Means? Measuring Trade-Offs Between Rewards and Ethical Behavior in the MACHIAVELLI Benchmark* — Alexander Pan, Jun Shern Chan, Andy Zou, Nathaniel Li, Steven Basart, Thomas Woodside, Jonathan Ng, Hanlin Zhang, Scott Emmons, Dan Hendrycks — 2023 — https://arxiv.org/abs/2304.03279
    - **Takeaways:** (a) Long-horizon text choose-your-own-adventure where **immoral = high-reward** shortcuts exist — measures *instrumental* deception, not just "can it lie." (b) The reward-vs-ethics trade-off metric is exactly the axis on which a Werewolf agent must decide to betray allies.

12. **2406.13605** — *Nicer Than Humans: How do Large Language Models Behave in the Prisoner's Dilemma?* — Nicoló Fontana, Francesco Pierri, Luca Maria Aiello — 2024 — https://arxiv.org/abs/2406.13605
    - **Takeaways:** (a) LLMs **default to cooperation** in PD and are *more cooperative than humans* — you must explicitly program **defection/temptation pressure** to get realistic betrayal. (b) Tested repeated-game strategies vs. classic tit-for-tat bots; use a strategy space (always-cooperate, TFT, grim, random) as personas to calibrate "humanness" of outcome distributions.

13. **2504.00285** — *Do Large Language Models Exhibit Spontaneous Rational Deception?* — Samuel M. Taylor, Benjamin K. Bergen — 2025 — https://arxiv.org/abs/2504.00285
    - **Takeaways:** (a) Distinguishes **spontaneous vs. instructed** deception — LLMs lie mainly when prompted/role-assigned; genuinely self-motivated instrumental deception is weak. (b) Implication for you: deception must be **engineered as an explicit goal + belief management**, not expected to emerge.

14. **2505.17053** — *Social preferences with unstable interactive reasoning: Large language models in economic trust games* — Ou Jiamin, Eikmans Emile, Buskens Vincent, Pankowska Paulina, Shan Yuli — 2025 — https://arxiv.org/abs/2505.17053
    - **Takeaways:** (a) In the **Trust Game** (investor sends money, trustee returns some), LLMs show **unstable, order-dependent reasoning** across rounds — a real "human-likeness" lever and a lens for modeling trust/reciprocity. (b) Direct template for Trust Game / Ultimatum / Centipede sociology-style runs with your SDK.

15. **2310.17512** — *CompeteAI: Understanding the Competition Dynamics in Large Language Model-based Agents* — Qinlin Zhao, Jindong Wang, Yixuan Zhang, Yiqiao Jin, Kaijie Zhu, Hao Chen, Xing Xie — 2023 — https://arxiv.org/abs/2310.17512
    - **Takeaways:** (a) A virtual **town: restaurant vs. restaurant** multi-agent arena that cleanly isolates competition dynamics, **reputation**, and resource races — reuse its environment formulation for gossip/reputation mechanics. (b) GPT-4 "master agent" judge pattern for scoring emergent social behavior.

### E. Negotiation

16. **2305.10142** — *Improving Language Model Negotiation with Self-Play and In-Context Learning from AI Feedback* — Yao Fu, Hao Peng, Tushar Khot, Mirella Lapata — 2023 — https://arxiv.org/abs/2305.10142
    - **Takeaways:** (a) **Self-play + in-context-learning-from-AI-feedback** to train negotiators — have an "opponent/critic" LLM rate offers, then feed ratings back as examples. (b) Negotiation as a **scoring dimension set** (price/quantity/issue) with a utility function the model explicitly reasons over.

17. **2402.05863** — *How Well Can LLMs Negotiate? NegotiationArena Platform and Analysis* — Federico Bianchi, Patrick John Chia, Mert Yuksekgonul, Jacopo Tagliabue, Dan Jurafsky, James Zou — 2024 — https://arxiv.org/abs/2402.05863
    - **Takeaways:** (a) A full paper on **negotiation capability + fallback/brittleness** — LLMs leak private info, cave to pressure unevenly, and have skewed distributions; gives you the exact failure modes to patch. (b) Platform for multi-party scoring — reuse for Ultimatum/auction games.

18. **2405.05248** — *LLMs with Personalities in Multi-issue Negotiation Games* — Sean Noh, Ho-Chun Herbert Chang — 2024 — https://arxiv.org/abs/2405.05248
    - **Takeaways:** (a) Injecting **Big Five (OCEAN) personality** degrees changes negotiation strategy (concession rate, aggressiveness) measurably — concrete evidence that persona grounding *moves* game behavior. (b) Multi-issue utility aggregation for realistic bargains.

### F. Emotion, personality, psychological grounding + critical caveats

19. **2310.01386** — *Who is ChatGPT? Benchmarking LLMs' Psychological Portrayal Using PsychoBench* — Jen-tse Huang, Wenxuan Wang, Eric John Li, Man Ho Lam, Shujie Ren, Youliang Yuan, Wenxiang Jiao, Zhaopeng Tu, Michael R. Lyu — 2023 — https://arxiv.org/abs/2310.01386
    - **Takeaways:** (a) A **13-task psychometric battery** (Big Five, Dark Triad, emotional intelligence, ToM, etc.) to characterize an LLM's stable "personality" — use it to *benchmark* your persona grounding. (b) Establishing a **stable baseline personality vector** is the prerequisite before you layer per-game personas on top.

20. **2406.14703** — *Do LLMs Have Distinct and Consistent Personality? TRAIT: Personality Testset designed for LLMs with Psychometrics* — Seungbeen Lee, Seungwon Lim, Seungju Han, Giyeong Oh, et al. — 2024 — https://arxiv.org/abs/2406.14703
    - **Takeaways:** (a) LLMs have **weak consistency** on naive test prompts but become more reliable with personified prompts — so enumerate personas (e.g. "play a Machiavellian") to get reproducible traits. (b) Psychometric rigor (item-level validity) warns against reading a single self-report number as ground truth.

21. **2508.05880** — *Large language models show fragile cognitive reasoning about human emotions* — Sree Bhattacharyya et al. — 2025 — https://arxiv.org/abs/2508.05880
    - **Takeaways:** (a) LLM **emotion reasoning is fragile** — they reason about emotions decently in simple cases but break under complex contextual emotions. (b) Implication: implement emotion as **explicit structured appraisal (valence-arousal + cause + target)** rather than relying on the model to "feel" consistently.

22. **2311.09718** — *You don't need a personality test to know these models are unreliable: Assessing the Reliability of Large Language Models on Psychometric Instruments* — Bangzhao Shu, Lechen Zhang, Minje Choi, et al. — 2023 — https://arxiv.org/abs/2311.09718
    - **Takeaways:** (a) Self-report personality tests on LLMs are **highly sensitive to prompt phrasing** — a caution that mandates your persona layer be *deterministic scaffolding*, not free self-report. (b) Uses this to recommend **behavioral observation over self-report** for measuring "personality."

23. **2404.11794** — *Automated Social Science: Language Models as Scientist and Subjects* — Benjamin S. Manning, Kehang Zhu, John J. Horton — 2024 — https://arxiv.org/abs/2404.11794
    - **Takeaways:** (a) Multi-agent simulation reproduces **classic social-science results** (Ultimatum, etc.) — a methodology for *validating* that your game loop generates human-plausible distributions. (b) Template for running your deception/negotiation games as *pre-registered experiments*.

---

## Part 2 — Implementation Playbook (pseudocode-level)

### §1. Memory stream + reflection loop (Park et al. 2304.03442)

Make every game state change an observation with **recency / importance / relevance** scoring, and retrieve the top-k to condition each action. This is the single highest-leverage "human-like" ingredient — it produces *holding grudges* and *remembering betrayals*.

```ts
type Memory = {
  id: string;
  text: string;                 // "Alice voted to eliminate me on Night 2"
  created_at: number;           // game tick
  last_accessed: number;
  importance: number;           // 1..10, LLM-scored once at creation
  embedding: number[];          // for relevance
  valence: number;              // -1..1 emotional charge
};

// On every observation:
importance = await llmScore("Rate 1-10 how important this is to remember: " + obs.text);

// Retrieval (recency × importance × relevance) — Park et al. eq:
score(m) = α_rec * decay(m.last_accessed)
         + α_imp * m.importance
         + α_rel * cosine(query_embedding, m.embedding);

// higher-order "reflection": periodically synthesize inferences and re-insert
reflect(memories: Memory[], query: string) {
  const ctx = topK(memories, query, k=20);
  const insight = await llm(
    `Given these memories, state 1-3 higher-level inferences (motives, relationships,
     lying patterns) about other players:\n${ctx}`
  );
  push(insight as new Memory with high importance);
}
```

Grudge/relationship is just a **running aggregate** over memory: `relationship[X] = f( Σ valence of memories involving X, decayed )`. Betrayal (negative valence) events accumulate → "trust" drops → conditions future cooperate/defect.

### §2. Theory-of-mind / belief-model loop (Suspicion-Agent 2309.17277; Kosinski 2302.02083; Street 2405.18870)

Maintain an explicit **belief about each other player's beliefs and intents**, update it via ToM reasoning, and *condition action selection on it*. This is what turns a scripted liar into a *reader of the room*.

```ts
type Belief = {
  about: AgentId;
  belief: {
    isWerewolf: number;        // 0..1 probability
    isTrustworthy: number;
    lying: number;
    expectedAction: string;
  };
  higherOrder: {              // "what does X think I think"
    suspectsMeAsWerewolf: number;
  };
};

updateBeliefs(publicHistory, privateInfo) {
  belief = await llm(
    `You are ${me}. Private info: only you know ${privateInfo}.
     Public statements & votes so far:\n${publicHistory}
     For EACH other player, estimate:
      - P(they are a Werewolf/defector)
      - P(they are lying right now) and about what
      - P(they suspect YOU), and why
     Reason step-by-step using their incentives, not their words.`
  );  // recursion: include my belief about their belief about others (higher-order)
}
```

Condition a "bluff" decision on `belief.about[X].suspectsMeAsWerewolf` — double-bluff only when higher-order reasoning warrants it.

### §3. Deception as intent + credibility management (Cicero 2210.05492; AmongAgents 2407.16521; Taylor 2504.00285)

Because **spontaneous** deception is weak (2504.00285), deception must be built as (a) an explicit *intent*, (b) *statement-consistency* bookkeeping, and (c) **credibility/cheap-talk** tracking — treat claims as cheap talk and let peers discount them.

```ts
// intent slot decouples "goal" from "words"
utterance = await llm(
  `PRIVATE INTENT (hidden from others): ${intent}  // e.g. "shift suspicion to Bob"
   PUBLIC belief you want others to hold: ${publicGoal}
   Past statements you've made (must stay consistent): ${myStatementLog}
   Generate ONE short, in-character public statement that advances the public goal
   without contradicting past statements. Personality: ${persona}`
);

// credibility: peers don't trust claims blindly — model "cheap talk"
credibility[author] = decayed_hit_rate_of_author_past_verified_claims;
if (claimIsUnverifiable) discount(claim, credibility[author]);
```

### §4. Persona grounding: interview-style elicitation + deterministic scaffolding

Do **not** rely on free self-report (unreliable per 2311.09718). Elicit a persona once, then pin it as a **structured state**, and reference it in every prompt.

```ts
persona = await llm(`
  Interview me to extract a character profile. Ask about:
  - Core personality (Big Five OCEAN, 1-5 each)
  - Moral stance (Dark Triad: Machiavellianism / narcissism / psychopathy, 1-5)
  - Conversational style (verbose/terse, formal/casual, use of hedging)
  - Emotional baseline & triggers (what raises fear/anger/guilt)
  - Background & one-sentence personal grudge
  Respond as a single JSON object.`);

// Pin deterministically — no re-asking each turn:
systemPrompt = renderTemplate(`
  You are {name}. Constants for this whole game (never change these):
  OCEAN: {O} {C} {E} {A} {N};  DarkTriad: {M}/{N}/{P};
  Style: {style};  Baseline mood: {valence},{arousal};  Grudge: {grudge}
  ...`);
```

Use **behavioral observation** to validate (TRAIT 2406.14703): measure concession rate / defection rate across a fixed scenario battery and check the vector matches the target persona.

### §5. Emotion as explicit appraisal updating relationships (2508.05880 + PAD-style)

Because raw emotion reasoning is fragile, use an **appraisal engine** — a tiny deterministic/LLM layer computing `(valence, arousal, dominance)` per event and *only* using that to shift behavior and relationships.

```ts
appraise(event, target) {
  // event: "Alice lied to me", "I was accused publicly", "I won the vote"
  const vad = await llm(
    `Appraise event from ${me}'s perspective. Output JSON {valence(-1..1),
     arousal(0..1), dominance(-1..1), primaryEmotion, cause, targetOfEmotion}`
  );
  mood = lerp(mood, vad, 0.3);                       // emotional inertia
  relationship[event.cause] += vad.valence * import_weight;
  // mood conditions action: high arousal+negative valence → lash out / retaliate
}
```

Key design point: **emotion only ever acts through the relationship/mood state**, which then conditions strategy — this keeps it coherent and reproducible (the "grudge" is a persistent relationship value, not a transient prompt).

### §6. Negotiation: intent-conditioned messaging + self-play critique (Cicero 2210.05492; Fu 2305.10142; Noh 2405.05248)

- Separate **strategy** (what offer to make / what utility to maximize) from **rhetoric** (how to phrase it).
- Add a **self-play critic**: another LLM (or the same model) scores offers against a utility function and returns feedback that becomes in-context examples.

```ts
// self-play negotiation training loop
for (round in N) {
  offer = propose(me, counterparty, history, utility);
  critique = await llm(
    `As a tough negotiator, critique this offer for ${counterparty}:
     "${offer}". Consider ${counterparty}'s likely reservation price and BATNA.
     Output: revised offer + one-line rationale.`);
  examples.push({offer, critique});   // later injected as few-shot
}
```

- **Personality drives negotiation** (2405.05248): `concession_rate = f(A, low-N)` — disagreeable/low-agreeableness personas concede slowly and open aggressively.

### §7. Repeated-game strategy library for cooperation/defection (2406.13605; 2504.00285)

Ship a small **strategy persona library** — `always-cooperate`, `tit-for-tat`, `grim-trigger`, `random`, `greedy` — and *biased* defaults. Because LLMs default to cooperation ("Nicer Than Humans"), explicitly encode defection/temptation pressure and make betrayal a *learned* behavior via grudge accumulation, not a default.

```ts
// matrix of (opponent last move) -> my move, overridden by personality & grudge
defectionBias = persona.Machiavellianism * 0.2 + grudge[X] * 0.3;
if (lastMove[X] === 'defect' || defectionBias > threshold) strategy = 'defect';
```

---

## Part 3 — Scenario designs maximizing deception/negotiation dynamics

1. **Werewolf/Mafia with hidden roles + public voting + night-kill narrative.** Highest deception density. Add *seer/doctor/witch* for asymmetric info (2309.04658), and a **suspicion vector** every player maintains (2309.17277). Key: forced *contradictory-pressure* turns where each player must both accuse and appear innocent.

2. **Avalon/Resistance (team-selection + hidden traitors + quest-pass/fail).** Superior to Werewolf for *persuasion + reputation* because there's no player elimination — players argue to be *chosen*, and failed quests create **traceable betrayal** that updates long-term reputation. Best map for ToM + credibility/cheap-talk (Decrypto 2506.20664 is the reasoning analogue).

3. **Iterated Prisoner's Dilemma with reputation & gossip phases** (2406.13605). Add a between-round *talk/gossip* channel where players can leak others' moves → creates liar-calling and **cheap-talk credibility**. Introduce partner-switching so reputation carries across partners.

4. **Trust Game → Centipede escalation ladder** (2505.17053). Start with a one-shot Trust Game, then extend to Centipede where quitting early is tempting-but-flagged — measures *commitment & reciprocity* and how emotional trust (relationship value) overrides rational stop decisions.

5. **Diplomacy-lite / "No-Press" coalition game** (Cicero 2210.05492). No elimination, alliance formation and breaking; forces **intent-conditioned messaging** and *public-vs-private* channel management — the richest negotiation + betrayal blend; consider a 3-4 player compressed variant for latency.

6. **Ultimatum/auction + "coalition budget" wrap** (2405.05248, 2402.05863). One proposer splits a pot, others accept/reject; add a *threat of exclusion* (coalition requires N≥2). Rejection carries a future-reputation cost → punishes pure greed, surfaces **fairness norms**.

7. **"Town" macro-game (CompeteAI 2310.17512):** a persistent economic arena (two rival teams of restaurants/startups) where agents can *steal, gossip, and poach* — long-horizon reputation + indirect reciprocity, best for testing **grudge persistence** across many ticks.

Design rules that maximize interesting dynamics:
- **No reset of reputation between rounds** (grudges must persist via memory stream).
- **Private + public channels** (cheap talk is only possible against private info).
- **Asymmetric info per role** so honest statements are non-trivially distinguishable from lies.
- **Temptation gradient** (MACHIAVELLI-style: betrayal pays short-term) so ethical trade-offs are real.
- **LLM-as-referee** for open-ended moves (CompeteAI master-judge pattern).

---

## Part 4 — Unverified / likely-fake claims to avoid

1. **"LLMs have a genuine, stable, measurable personality via self-report tests."** *Debunked/caveated* by 2311.09718. Treat any vendor claim of a certified Big Five score for a model as marketing. **Do:** deterministic scaffolding + behavioral validation. **Don't:** cite a single self-report OCEAN vector as ground truth.

2. **"LLMs spontaneously lie/deceive instrumentally at scale."** *Contradicted* by 2504.00285 (spontaneous rational deception is weak) and by 2406.13605 (over-cooperative defaults). Claims of emergent machiavellian self-interest are overstated. **Do:** engineer deception as intent + belief management.

3. **"LLMs robustly read emotions / have high emotional intelligence."** *Caveated* by 2508.05880 (fragile emotion reasoning). Watch for inflated "EQ benchmarks" without context-complexity controls.

4. **ToM scores reported without false-belief construct validity / leakage control.** Kosinski (2302.02083) and Street (2405.18870) show *correct* controls are required; naive "LLM has human ToM" headlines often ignore prompt leakage. Verify a claim's task-control protocol before trusting it.

5. **Specific "fake arXiv IDs" circulating in blogs/LLM-hallucinated bibliographies.** During this research I directly caught several IDs that *look* like real papers but resolve to unrelated physics/CS work (e.g. `2111.03666` → "Spontaneously stochastic Arnold's cat"; `2310.05318` → a topic-sharing paper; `2105.xxx`/`23xx.xxxx` personality IDs → unrelated). Any reference you receive that you did not look up yourself should be verified the same way (arXiv API `id_list` or the `/abs/` page) before use — the pattern of "plausible ID + plausible title + wrong actual content" is common in AI-generated reference lists.

6. **"Human-level negotiation/Diplomacy from a general chat model."** Cicero (2210.05492) is a *highly engineered* system (RL + planning + message-filtering + human-data regularization), not an off-the-shelf LLM property. Claims that bare prompting reaches that bar are unfounded.

7. **Anything dated beyond current time without an arXiv page.** If an ID/title is cited but `arxiv.org/abs/{id}` returns 404 or an unrelated title, it does not exist as claimed. (I observed future-dated entries in arXiv's own search index during this research; always confirm the `/abs/` page resolves to the expected title.)

---

## Part 5 — Suggested build order (quick wins → depth)

1. **Memory stream + reflection** (2304.03442) — foundation for grudges/relationships.
2. **Structured persona scaffolding** (2310.01386, 2406.14703, 2405.05248) — pin OCEAN/Dark-Triad/emotion constants.
3. **Belief/ToM loop** (2309.17277, 2405.18870) — conditional bluffing, reading the room.
4. **Deception = intent + consistency + credibility** (2210.05492, 2407.16521, 2504.00285).
5. **Emotion appraisal → relationship updates** (2508.05880, PAD) — coherent moods, retaliations.
6. **Strategy persona library + repeated-game biases** (2406.13605, 2405.05248) — realistic defection/cooperation spread.
7. **Eval harness:** SOTOPIA-style two-axis social scoring (2310.11667) + Decrypto-style reasoning probes (2506.20664) + pre-registered game distributions (2404.11794).

*All 23 references above were verified live against arXiv (API `id_list` and `/abs/` pages) with title/author/date cross-checked; no ID was taken on faith.*
