import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EconomicScenario } from "./scenarios/economic";
import { WerewolfScenario } from "./scenarios/werewolf";
import { SignalingScenario } from "./scenarios/signaling";
import { SocietyStore, tokenHash, type StoredRun } from "./store";
import { latestPsychology, psychologicalStateSchema, hybridProposalSchema, psychologyVersion, type PsychologicalState } from "./psychology";
import { reduceMind } from "./cognition";
import { validatePredictions } from "./predictions";
import { initialMind } from "./psychology-setup";
import { enterEpisode, finishEpisode, integrateExperience, type AgentMind } from "../agents/cognition";
import { historicalMind, ledgerExperience, psychologyProjection } from "./agent-state";
import { fact, RunError, visible, type Character, type Channel, type EventDraft, type Memory, type Opportunity, type Participant, type ParticipantFactory, type RunSpec, type ScenarioAdapter, type Stage, type TurnContext, type TurnResult, type Viewer, type WorldEvent } from "./types";

interface Conversation { channel: Channel; participants: string[]; ready: string[]; }
interface PendingHuman { opportunity: Opportunity; context: TurnContext; resolve(result: TurnResult): void; reject(error: Error): void; }
export const humanActionSchema = z.object({ opportunityId: z.string(), action: z.string(), input: z.record(z.string(), z.unknown()).default({}) }).strict();

export class SocietyRun {
  readonly world: ScenarioAdapter;
  private participants = new Map<string, Participant>();
  private inboxes = new Map<string, WorldEvent[]>();
  private conversations = new Map<string, Conversation>();
  private humans = new Map<string, PendingHuman>();
  private active = new Map<string, Opportunity>();
  private listeners = new Set<() => void>();
  private abort = new AbortController();
  private finishedActions = new Set<string>();
  private stageId = "";
  private turns = 0;
  private waking?: () => void;
  private task?: Promise<void>;
  private jobs = new Set<Promise<void>>();
  private inherited = new Map<string, Memory[]>();
  private priorContext = new Map<string, Memory[]>();
  private minds = new Map<string, PsychologicalState>();
  private cognitions = new Map<string, AgentMind>();
  private transactionOpen = false;
  private setupApplied = false;

  constructor(readonly record: StoredRun, readonly store: SocietyStore, factory: ParticipantFactory) {
    this.world = record.spec.scenario === "werewolf" ? new WerewolfScenario(record.characters, record.spec.rounds, record.spec.seed)
      : record.spec.scenario === "signaling-game" ? new SignalingScenario(record.characters, record.spec.rounds, record.spec.seed, record.spec.signalingIncentives)
      : new EconomicScenario(record.spec.scenario, record.characters, record.spec.rounds, record.spec.trustProtocol);
    for (const c of record.characters) {
      this.inboxes.set(c.id, []);
      const snapshot = store.snapshot(record.spec.initialSnapshots[c.id] ?? "");
      this.inherited.set(c.id, snapshot ? store.memories(snapshot.memoryIds) : []);
      if (record.spec.experiment.relationshipMemory && record.spec.experiment.psychology !== "off") {
        const previous = latestPsychology(this.inherited.get(c.id)!.flatMap(m => m.sourceIds.flatMap(id => { const event = store.event(id); return event && visible(event, { actorId: c.id }) ? [event] : []; })), c.id);
        if (previous) this.minds.set(c.id, previous);
        this.cognitions.set(c.id, enterEpisode(snapshot?.cognition ?? historicalMind(previous, c.id, record.id), c.id, record.id));
      } else if (record.spec.experiment.psychology !== "off") {
        this.cognitions.set(c.id, enterEpisode(undefined, c.id, record.id));
      }
      this.priorContext.set(c.id, this.inherited.get(c.id)!.filter(m => m.kind === "experience" && m.sourceIds.some(id => {
        const source = store.event(id); return source && visible(source, { actorId: c.id }) && !source.data.identityScope && (source.type === "message" || source.type === "action" || source.data.settlement);
      })).slice(-6));
      if (!record.spec.roster.find(s => s.characterId === c.id)!.human) {
        const participant = factory(c, record.spec, record.id);
        this.participants.set(c.id, participant);
        if (participant.configuration) (record.modelConfigs ??= {})[c.id] = participant.configuration;
      }
    }
  }
  get id() { return this.record.id; }
  get status() { return this.record.status; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify() { for (const f of this.listeners) f(); this.waking?.(); this.waking = undefined; }
  private assertOpen() { if (this.abort.signal.aborted || !["running", "paused"].includes(this.status)) throw new RunError("对局已经结束"); }
  private emit(draft: EventDraft) {
    this.assertOpen();
    const recipients = this.record.characters.filter(c => visible({ ...draft } as WorldEvent, { actorId: c.id })).map(c => c.id);
    const event = this.store.append(this.id, draft, recipients);
    for (const id of recipients) {
      this.inboxes.get(id)!.push(event);
      const mind = this.cognitions.get(id); const experience = ledgerExperience(event, this.record.spec, id);
      if (mind && experience && integrateExperience(mind, experience)) this.store.saveCognition(this.id, mind);
    }
    if (!this.transactionOpen) this.notify(); return event;
  }
  start() {
    if (this.task) return this.task;
    this.task = this.drive().catch(error => {
      if (!this.abort.signal.aborted) this.finish("incomplete", error instanceof Error ? error.message : String(error));
    });
    return this.task;
  }
  async settled() { await this.task; await Promise.allSettled(this.jobs); }
  private async drive() {
    while (!this.abort.signal.aborted) {
      if (this.status === "paused") { await new Promise<void>(resolve => { this.waking = resolve; }); continue; }
      const stage = this.world.stage();
      if (!stage) {
        await this.reviewEpisode();
        this.assertOpen();
        this.store.db.transaction(() => {
          for (const mind of this.cognitions.values()) {
            finishEpisode(mind); this.store.saveCognition(this.id, mind);
            if (mind.appraisal) this.emit({ type: "note", actorId: mind.actorId, visibility: [mind.actorId], text: "本局结果已反馈到学习记录",
              data: { kind: "psychology", version: mind.version, finalized: true, round: this.record.spec.rounds, stageId: "finished",
                cognition: mind, psychology: psychologyProjection(mind, "finished"), sourceIds: mind.appraisal.sourceIds } });
          }
          this.store.complete(this.record);
        })();
        this.finish("completed", "对局结束"); return;
      }
      if (stage.id !== this.stageId && this.jobs.size === 0) this.openStage(stage);
      let launched = false;
      const discussionLimit = Math.min(stage.turnLimit ?? Infinity, this.record.spec.budgets.discussionTurns);
      if (stage.kind === "discussion" && this.turns < discussionLimit) {
        for (const conversation of this.conversations.values()) {
          if (this.turns >= discussionLimit) break;
          if ([...this.active.values()].some(o => o.channel === conversation.channel && o.recipients.join() === conversation.participants.join())) continue;
          const actorId = conversation.ready.find(id => !this.active.has(id));
          if (!actorId) continue;
          conversation.ready = conversation.ready.filter(id => id !== actorId);
          this.launch(stage, actorId, conversation); launched = true;
        }
      } else if (stage.kind === "action") {
        for (const actorId of stage.actors) if (!this.active.has(actorId) && !this.finishedActions.has(actorId)) { this.launch(stage, actorId); launched = true; }
      }
      if (launched || this.jobs.size) { await Promise.race([...this.jobs, new Promise<void>(resolve => { this.waking = resolve; })]); continue; }
      for (const event of this.world.advance()) this.emit(event);
    }
  }
  private async reviewEpisode() {
    const outcomes = this.store.events(this.id).filter(event => event.data.settlement === true);
    const round = Math.max(1, ...outcomes.map(event => Number(event.data.round) || 1));
    for (const character of this.record.characters) {
      if (!this.participants.get(character.id)?.reviewAtEpisodeEnd) continue;
      while (this.status === "paused" && !this.abort.signal.aborted) await new Promise<void>(resolve => { this.waking = resolve; });
      this.assertOpen();
      const stage: Stage = { id: "episode-review", label: "整局私有复盘", round, kind: "discussion", actors: [character.id], channel: "private" };
      const opportunity: Opportunity = { id: randomUUID(), actorId: character.id, stage, channel: "private", recipients: [character.id], actions: [], communications: [] };
      this.active.set(character.id, opportunity); this.notify();
      try { await this.activate(opportunity, true); }
      finally { this.active.delete(character.id); this.notify(); }
    }
  }
  private openStage(stage: Stage) {
    this.stageId = stage.id; this.turns = 0; this.finishedActions.clear(); this.conversations.clear();
    if (stage.kind === "discussion") this.conversations.set("main", { channel: stage.channel, participants: [...stage.actors], ready: [...stage.actors] });
    this.emit({ type: "phase", text: stage.label, visibility: stage.channel === "team" ? stage.actors : "public", data: { round: stage.round, stageId: stage.id, world: this.world.publicState() } });
    for (const c of this.record.characters) this.emit(fact(this.world.observe(c.id), { identityScope: this.id, stageId: stage.id }, [c.id]));
    if (!this.setupApplied) {
      this.setupApplied = true;
      for (const [actorId, setup] of Object.entries(this.record.spec.psychologySetup ?? {})) {
        const source = this.emit({ type: "fact", actorId, visibility: [actorId], text: "心理初态由研究者设定；它不是本局已发生的经历，也不是对方意图的事实。", data: { psychologySetup: setup, stageId: stage.id, round: stage.round } });
        const state = initialMind(setup, source.id, stage.id, this.record.spec);
        this.minds.set(actorId, state);
        this.cognitions.set(actorId, historicalMind(state, actorId, this.id));
        this.emit({ type: "note", actorId, visibility: [actorId], text: state.appraisal, data: { kind: "psychology", origin: "researcher-intervention", psychology: state, sourceIds: [source.id], stageId: stage.id, round: stage.round } });
      }
    }
  }
  private launch(stage: Stage, actorId: string, conversation?: Conversation) {
    this.turns++;
    const opportunity: Opportunity = { id: randomUUID(), actorId, stage: structuredClone(stage), channel: conversation?.channel ?? "private", recipients: conversation?.participants ?? [actorId], actions: this.world.actions(actorId), communications: [] };
    for (const channel of ["public", "private", "team"] as const) {
      if (channel === opportunity.channel && channel !== "private") continue;
      const recipients = this.record.characters.map(c => c.id).filter(id => id !== actorId && this.world.canMessage(actorId, channel, [id]));
      if (channel === "private" && opportunity.channel === "private" && recipients.length === 1 && opportunity.recipients.length === 2 && opportunity.recipients.includes(recipients[0])) continue;
      if (recipients.length || channel === "public" && this.world.canMessage(actorId, channel, [])) opportunity.communications.push({ channel, recipients });
    }
    this.active.set(actorId, opportunity);
    const job = this.activate(opportunity).catch(error => { if (!this.abort.signal.aborted) this.finish("incomplete", error instanceof Error ? error.message : String(error)); }).finally(() => {
      this.active.delete(actorId); this.jobs.delete(job); this.notify();
    });
    this.jobs.add(job); this.notify();
  }
  private async activate(opportunity: Opportunity, episodeReview = false) {
    const actorId = opportunity.actorId;
    const started = Date.now();
    const completed = new Set<string>();
    let waited = false;
    let yielded = false;
    let psychologyEventId: string | undefined;
    const executeCall = (name: string, args: Record<string, unknown>): unknown => {
      this.assertOpen();
      if (episodeReview) throw new RunError("整局复盘只可原子保存私有心理记录，不能执行世界动作或发送消息");
      if (waited || yielded || this.active.get(actorId)?.id !== opportunity.id) throw new RunError("本次行动机会已结束");
      let result: unknown;
      if (name === "wait") {
        if (opportunity.actions.some(a => !completed.has(a.name))) throw new RunError("当前需要提交实际行动；选择0也须通过对应行动工具提交，不能用等待代替。");
        waited = true; result = "";
      }
      else if (name === "send_message") {
        const input = z.object({ channel: z.enum(["public", "private", "team"]), recipients: z.array(z.string()).max(12), text: z.string().trim().min(1).max(8000) }).strict().parse(args);
        const sameRecipients = [actorId, ...input.recipients].every(id => opportunity.recipients.includes(id)) && opportunity.recipients.every(id => id === actorId || input.recipients.includes(id));
        if (input.channel === opportunity.channel && (input.channel !== "private" || sameRecipients)) throw new RunError("当前对话请直接回复；send_message仅用于联系其他频道或另一组私聊对象");
        result = this.message(opportunity, input.channel, input.recipients, input.text, true);
        yielded = true;
      } else if (name === "recall_memory") {
        const { query, about } = z.object({ query: z.string().max(200), about: z.string().nullable() }).parse(args);
        const allowed = this.record.spec.experiment.relationshipMemory ? this.memories(actorId) : this.store.currentMemories(this.id, actorId).filter(m => m.kind === "experience");
        result = this.store.recall(actorId, allowed, query, about ?? undefined).map(m => this.memoryEvidence(m, actorId));
      } else if (name === "update_mind") {
        if (!this.participants.has(actorId) || this.record.spec.experiment.psychology === "off" || psychologyEventId) throw new RunError("本次心理状态已保存，或当前不启用 Agent 心理机制");
        const hybrid = this.record.spec.experiment.psychology === "hybrid";
        const proposal = hybrid ? hybridProposalSchema.parse(args) : psychologicalStateSchema.parse(args);
        if ("conflict" in proposal) validatePredictions(proposal, this.record.spec, actorId, this.store.events(this.id).filter(e => visible(e, { actorId })));
        const mind: PsychologicalState = hybrid ? reduceMind(this.minds.get(actorId), proposal, opportunity.stage.id, this.record.spec.cognition?.inertia, this.record.spec.cognition?.decay) : psychologicalStateSchema.parse(proposal);
        const experiences = this.record.spec.experiment.relationshipMemory ? this.memories(actorId) : this.store.currentMemories(this.id, actorId);
        const sources = new Set(experiences.flatMap(m => m.sourceIds).filter(id => { const e = this.store.event(id); return e && visible(e, { actorId }) && ["message", "action", "fact"].includes(e.type); }));
        if (proposal.sourceIds.some(id => !sources.has(id)) || "conflict" in proposal && proposal.relationships.some(r => r.sourceIds.some(id => !sources.has(id)))) throw new RunError("心理评价只能引用自己实际收到的事实与发言");
        const targets = mind.relationships.map(r => r.targetId);
        if (new Set(targets).size !== targets.length || targets.some(id => id === actorId || !this.inboxes.has(id))) throw new RunError("关系判断须对应不同的在场他人");
        const event = this.emit({ type: "note", actorId, visibility: [actorId], text: mind.appraisal, data: { kind: "psychology", version: hybrid ? "hybrid-v1" : psychologyVersion, psychology: mind, sourceIds: mind.sourceIds, opportunityId: opportunity.id, stageId: opportunity.stage.id, round: opportunity.stage.round } });
        psychologyEventId = event.id;
        this.minds.set(actorId, structuredClone(mind));
        this.store.addMemory({ id: randomUUID(), characterId: actorId, runId: this.id, kind: "note", at: event.at, text: mind.appraisal, sourceIds: [event.id], about: targets });
        result = mind;
      } else if (name === "remember") {
        const note = z.object({ text: z.string().trim().min(1).max(1500), sourceIds: z.array(z.string()).min(1).max(12), about: z.array(z.string()).max(12) }).strict().parse(args);
        const sources = new Set(this.memories(actorId).flatMap(m => m.sourceIds));
        if (note.sourceIds.some(id => !sources.has(id)) || note.about.some(id => !this.inboxes.has(id))) throw new RunError("记忆只能引用自己收到的经历和在场人物");
        const event = this.emit({ type: "note", actorId, visibility: [actorId], text: note.text, data: { sourceIds: note.sourceIds, about: note.about } });
        const memory: Memory = { id: randomUUID(), characterId: actorId, runId: this.id, kind: "note", at: event.at, ...note };
        this.store.addMemory(memory); result = memory;
      } else {
        if (!opportunity.actions.some(a => a.name === name) || completed.has(name)) throw new RunError("这项行动当前不可用或已经提交");
        if (this.world.stage()?.id !== opportunity.stage.id) throw new RunError("行动阶段已经改变");
        const events = this.world.apply(actorId, name, args); completed.add(name);
        result = events.map(event => this.emit(event));
      }
      if (name !== "wait") this.emit({ type: "trace", actorId, visibility: "research", text: name, data: { input: args, result, opportunityId: opportunity.id } });
      return result;
    };
    const context: TurnContext = {
      character: this.record.characters.find(c => c.id === actorId)!, opportunity, observation: this.world.observe(actorId) + "\n在场人物：" + this.record.characters.map(c => `${c.name}=${c.id}`).join("；"),
      worldObservation: this.world.observation?.(actorId),
      ...(episodeReview ? { appraisalOnly: true, episodeReview: true } : {}),
      inbox: this.inboxes.get(actorId)!.splice(0), recent: this.store.events(this.id).filter(e => visible(e, { actorId }) && ["message", "fact", "action"].includes(e.type))
        .filter((event, index, events) => index >= events.length - 28 || episodeReview && (event.data.settlement === true || event.type === "action" && event.actorId === actorId)),
      memories: this.record.spec.experiment.relationshipMemory ? [...this.priorContext.get(actorId)!, ...this.memories(actorId).filter(m => m.kind === "note" && !m.sourceIds.some(id => this.store.event(id)?.data.kind === "psychology")).slice(-8)].map(m => this.memoryEvidence(m, actorId)) : [], signal: this.abort.signal, call: async (name, args) => executeCall(name, args),
      psychology: this.minds.has(actorId) ? structuredClone(this.minds.get(actorId)!) : undefined,
      cognition: this.cognitions.has(actorId) ? structuredClone(this.cognitions.get(actorId)!) : undefined,
      lookupEvidence: id => { const event = this.store.event(id); return event && visible(event, { actorId }) ? event : undefined; },
      commitActivation: activation => {
        this.assertOpen();
        const validStage = episodeReview ? this.world.stage() === undefined : this.world.stage()?.id === opportunity.stage.id;
        if (activation.id !== opportunity.id || activation.actorId !== actorId || activation.stageId !== opportunity.stage.id || !validStage || this.active.get(actorId)?.id !== opportunity.id) throw new RunError("激活与当前行动机会不匹配");
        if (this.store.activationCommitted(activation.id)) throw new RunError("本次激活已经提交");
        if (activation.cognition && (activation.cognition.actorId !== actorId || activation.cognition.episode !== this.id)) throw new RunError("心理状态不属于当前人物与对局");
        if (episodeReview && (activation.calls.length || activation.text || activation.waited !== true || !activation.cognition?.episodeReviews?.some(review => review.episode === this.id && review.opportunityId === opportunity.id))) throw new RunError("整局复盘必须完成正式私有记录，且不能包含动作或发言");
        if (new Set(activation.calls.map(c => c.name)).size !== activation.calls.length) throw new RunError("激活中存在重复行动");
        if (opportunity.stage.kind === "action" && opportunity.actions.some(a => !activation.calls.some(c => c.name === a.name))) throw new RunError("激活缺少必需行动");
        const before = { world: this.world.checkpoint(), cognitions: structuredClone(this.cognitions), minds: structuredClone(this.minds), inboxes: structuredClone(this.inboxes), conversations: structuredClone(this.conversations), completed: [...completed], waited, yielded, psychologyEventId };
        this.transactionOpen = true;
        try {
          this.store.db.transaction(() => {
            if (activation.cognition) {
              const mind = structuredClone(activation.cognition);
              const known = new Set(this.cognitions.get(actorId)?.predictions.map(p => p.id));
              const existing = this.store.events(this.id); const frontier = existing.at(-1)?.seq ?? 0;
              // New predictions start at commit time, never score an outcome that arrived during generation.
              for (const prediction of mind.predictions) if (!known.has(prediction.id) && prediction.episode === this.id) prediction.afterSeq = frontier;
              for (const event of existing) if (visible(event, { actorId })) { const experience = ledgerExperience(event, this.record.spec, actorId); if (experience) integrateExperience(mind, experience); }
              this.cognitions.set(actorId, mind);
              const projection = psychologyProjection(mind, opportunity.stage.id);
              if (projection) this.minds.set(actorId, projection);
              const review = episodeReview ? mind.episodeReviews?.find(item => item.episode === this.id && item.opportunityId === opportunity.id) : undefined;
              const event = this.emit({ type: "note", actorId, visibility: [actorId], text: review?.summary ?? mind.appraisal?.interpretation ?? "本次心理与计划",
                data: { kind: "psychology", version: mind.version, cognition: mind, psychology: projection, ...(review ? { episodeReview: review } : {}), sourceIds: review?.sourceIds ?? mind.appraisal?.sourceIds ?? [], opportunityId: opportunity.id, stageId: opportunity.stage.id, round: opportunity.stage.round } });
              psychologyEventId = event.id; this.store.saveCognition(this.id, mind);
            }
            for (const pending of activation.calls) executeCall(pending.name, pending.args);
            if (activation.text) {
              if (opportunity.stage.kind !== "discussion") throw new RunError("当前不是发言机会");
              this.message(opportunity, opportunity.channel, opportunity.recipients.filter(id => id !== actorId), activation.text); yielded = true;
            }
            if (activation.waited) { if (opportunity.stage.kind === "action") throw new RunError("必需行动不能等待"); waited = true; }
            this.store.commitActivation(activation.id, this.id, actorId);
          })();
        } catch (error) {
          this.world.restore(before.world); this.cognitions = before.cognitions; this.minds = before.minds; this.inboxes = before.inboxes; this.conversations = before.conversations;
          completed.clear(); before.completed.forEach(name => completed.add(name)); waited = before.waited; yielded = before.yielded; psychologyEventId = before.psychologyEventId; throw error;
        } finally { this.transactionOpen = false; }
        this.notify();
      },
      recordDecisionCase: record => this.store.saveCase(record),
      recordHarnessEvent: event => { this.emit({ type: "trace", actorId, visibility: "research", text: "sdk-harness", data: { ...event, harness: true, opportunityId: opportunity.id } }); },
      recordToolError: (toolName, message) => { this.emit({ type: "trace", actorId, visibility: "research", text: toolName, data: { toolError: true, message, opportunityId: opportunity.id } }); },
      recordModelResponse: receipt => {
        if (!this.abort.signal.aborted) this.emit({ type: "trace", actorId, visibility: "research", text: "model-response", data: { ...receipt, opportunityId: opportunity.id } });
      },
    };
    const participant = this.participants.get(actorId);
    const result = participant ? await participant.turn(context) : await this.humanTurn(context);
    this.assertOpen();
    if (episodeReview && (!this.store.activationCommitted(opportunity.id) || result.text)) throw new RunError("整局复盘未完成正式提交，不能推进人物快照");
    if (opportunity.stage.kind === "action" && opportunity.actions.some(a => !completed.has(a.name))) {
      this.emit({ type: "trace", actorId, visibility: "research", text: "missing-action", data: { output: result.text, waited, required: opportunity.actions.map(a => a.name), ...result, durationMs: Date.now() - started } });
      throw new RunError(`${context.character.name}未完成${opportunity.actions.map(a => a.label).join("、")}`);
    }
    const text = result.text?.trim();
    if (text && !waited && !yielded && !result.waited) {
      if (opportunity.stage.kind === "discussion") this.message(opportunity, opportunity.channel, opportunity.recipients.filter(id => id !== actorId), text);
      else this.emit({ type: "trace", actorId, visibility: [actorId], text: "action-response", data: { text, stageId: opportunity.stage.id } });
    }
    if (opportunity.stage.kind === "action") this.finishedActions.add(actorId);
    this.emit({ type: "trace", actorId, visibility: "research", text: "turn", data: { durationMs: Date.now() - started, inputTokens: result.inputTokens ?? 0, outputTokens: result.outputTokens ?? 0, waited: !yielded && (waited || result.waited || !text), yielded, psychologyEventId, modelProfileId: this.record.spec.roster.find(s => s.characterId === actorId)?.modelProfileId, opportunityId: opportunity.id } });
  }
  private message(opportunity: Opportunity, channel: Channel, recipients: string[], text: string, addressed = false) {
    const actorId = opportunity.actorId;
    const others = [...new Set(recipients.filter(id => id !== actorId))];
    if (channel === "private" && !others.length) throw new RunError("请选择交流对象");
    if (!this.world.canMessage(actorId, channel, others)) throw new RunError("当前不能向这个频道或对象发消息");
    const latest = this.store.events(this.id).filter(e => e.type === "message" && visible(e, { actorId }) && others.every(id => visible(e, { actorId: id })) && e.data.channel === channel).at(-1);
    const event = this.emit({ type: "message", actorId, visibility: channel === "public" ? "public" : [actorId, ...others], text, data: { channel, recipients: others, ...(latest ? { replyTo: latest.id } : {}), stageId: opportunity.stage.id } });
    const participants = channel === "public" ? this.world.stage()!.actors : [...new Set([actorId, ...others])].sort();
    const key = channel === this.world.stage()?.channel && participants.length === this.world.stage()!.actors.length ? "main" : `${channel}:${participants.join(",")}`;
    const existing = this.conversations.get(key);
    const explicitlyAddressed = addressed ? others : participants.filter(id => id !== actorId && text.includes(this.record.characters.find(c => c.id === id)!.name));
    const fairOrder = [...(existing?.ready ?? []), ...participants.filter(id => id !== actorId), actorId];
    const order = this.record.spec.experiment.speaking === "round-robin" ? fairOrder : [...explicitlyAddressed, ...fairOrder];
    this.conversations.set(key, { channel, participants, ready: [...new Set(order)].filter(id => participants.includes(id)) });
    return event;
  }
  memories(actorId: string) {
    const prior = this.inherited.get(actorId) ?? [];
    return [...prior, ...this.store.currentMemories(this.id, actorId)];
  }
  private memoryEvidence(memory: Memory, actorId: string): Memory {
    return { ...memory, sources: memory.sourceIds.flatMap(id => { const event = this.store.event(id); return event && visible(event, { actorId }) ? [event] : []; }) };
  }
  private humanTurn(context: TurnContext): Promise<TurnResult> {
    return new Promise((resolve, reject) => {
      let elapsed = 0;
      const timer = setInterval(() => { if (this.status === "running") elapsed += 1000; if (elapsed >= this.record.spec.budgets.humanTimeoutMs) { clean(); reject(new RunError("等待真人行动超时")); } }, 1000);
      const abort = () => { clearTimeout(timer); this.humans.delete(context.character.id); reject(new RunError("对局已结束")); };
      this.abort.signal.addEventListener("abort", abort, { once: true });
      const clean = () => { clearTimeout(timer); this.abort.signal.removeEventListener("abort", abort); this.humans.delete(context.character.id); };
      this.humans.set(context.character.id, { context, opportunity: context.opportunity, resolve: result => { clean(); resolve(result); }, reject: error => { clean(); reject(error); } });
      this.notify();
    });
  }
  async humanAction(actorId: string, body: z.infer<typeof humanActionSchema>) {
    this.assertOpen();
    if (this.status !== "running") throw new RunError("请先恢复对局");
    const pending = this.humans.get(actorId);
    if (!pending || body.opportunityId !== pending.opportunity.id) throw new RunError("行动机会已结束或已经提交");
    if (body.action === "speak") {
      if (pending.opportunity.stage.kind !== "discussion") throw new RunError("请先完成当前行动");
      const { text } = z.object({ text: z.string().trim().min(1).max(8000) }).parse(body.input);
      pending.resolve({ text });
    } else if (body.action === "wait") {
      if (pending.opportunity.stage.kind === "action") throw new RunError("当前需要提交行动");
      pending.resolve({ waited: true });
    } else {
      await pending.context.call(body.action, body.input);
      if (body.action === "send_message" || !this.world.actions(actorId).length) pending.resolve({});
    }
  }
  control(action: "pause" | "resume" | "stop") {
    this.assertOpen();
    if (action === "stop") { this.finish("stopped", "对局已停止"); return; }
    this.record.status = action === "pause" ? "paused" : "running"; this.store.setStatus(this.id, this.status);
    this.emit({ type: "status", visibility: "public", text: action === "pause" ? "已暂停" : "已恢复", data: { status: this.status } }); this.notify();
  }
  private finish(status: "completed" | "incomplete" | "stopped", message: string) {
    if (this.abort.signal.aborted) return;
    this.record.status = status; this.store.setStatus(this.id, status);
    const reason = message.startsWith("模型输出未完成：") ? message.slice("模型输出未完成：".length) : message.includes("未完成") ? "必需行动未提交" : /[Mm]ax turns/.test(message) ? "达到行动预算" : /timeout|timed out/i.test(message) ? "模型响应超时" : "模型调用失败";
    this.store.append(this.id, { type: "status", visibility: "public", text: status === "incomplete" ? `对局未完成：${reason}` : message, data: { status, world: this.world.publicState() } }, []);
    if (status === "incomplete") this.store.append(this.id, { type: "trace", visibility: "research", text: message.slice(0, 800), data: { error: true } }, []);
    this.abort.abort(); this.notify();
  }
  view(viewer: Viewer) {
    const base = replayView(this.record, this.store, viewer);
    return { ...base, world: this.world.publicState(), active: [...this.active.values()].filter(o => this.participants.has(o.actorId) && (viewer.research || o.actorId === viewer.actorId || o.stage.kind === "discussion" && o.channel === "public")).map(o => ({ actorId: o.actorId })), opportunities: [...this.humans.values()].filter(h => viewer.research || h.opportunity.actorId === viewer.actorId).map(h => ({ ...h.opportunity, actions: h.opportunity.actions.map(({ parameters: _parameters, ...a }) => a) })), memories: viewer.actorId ? this.memories(viewer.actorId) : [] };
  }
}

export function replayView(record: StoredRun, store: SocietyStore, viewer: Viewer) {
  const events = store.events(record.id).filter(e => visible(e, viewer));
  const world = events.findLast(e => e.data.world)?.data.world ?? {};
  const memories = viewer.actorId ? [...store.memories(store.snapshot(record.spec.initialSnapshots[viewer.actorId] ?? "")?.memoryIds ?? []), ...store.currentMemories(record.id, viewer.actorId)] : [];
  return { id: record.id, status: record.status, createdAt: record.createdAt, scenario: record.spec.scenario, characters: record.characters, mode: record.spec.mode, worldId: record.spec.worldId, ...(viewer.research ? { spec: record.spec, modelConfigs: record.modelConfigs } : {}), events, world, active: [] as { actorId: string }[], opportunities: [] as Omit<Opportunity, "actions">[] , memories };
}

export class RunService {
  readonly live = new Map<string, SocietyRun>();
  constructor(readonly store: SocietyStore, readonly factory: ParticipantFactory) {}
  create(spec: RunSpec, characters: Character[]) {
    if (new Set(characters.map(c => c.id)).size !== characters.length) throw new RunError("同一人物不能重复入场", 400);
    const initialSnapshots: Record<string, string> = {};
    for (const c of characters) {
      const head = this.store.head(spec.worldId, c.id);
      const id = spec.initialSnapshots[c.id] ?? (spec.mode === "continuity" ? head : undefined);
      if (id) {
        const snapshot = this.store.snapshot(id);
        if (!snapshot || snapshot.characterId !== c.id) throw new RunError("人物快照不匹配", 400);
        if (spec.mode === "continuity" && head && id !== head) throw new RunError("连续世界须从最新快照开始；旧快照请使用独立实验");
        initialSnapshots[c.id] = id;
      }
    }
    const ownerToken = randomUUID();
    const playerTokens = Object.fromEntries(spec.roster.filter(s => s.human).map(s => [s.characterId, randomUUID()]));
    const record: StoredRun = { id: randomUUID(), spec: { ...spec, initialSnapshots }, characters, status: "running", createdAt: new Date().toISOString(), ownerHash: tokenHash(ownerToken), playerHashes: Object.fromEntries(Object.entries(playerTokens).map(([id, token]) => [id, tokenHash(token)])) };
    const run = new SocietyRun(record, this.store, this.factory);
    this.store.create(record); this.live.set(run.id, run); void run.start();
    void run.settled().then(() => this.live.delete(run.id));
    return { run, ownerToken, playerTokens };
  }
  stopAll() { for (const run of this.live.values()) if (["running", "paused"].includes(run.status)) run.control("stop"); }
}
