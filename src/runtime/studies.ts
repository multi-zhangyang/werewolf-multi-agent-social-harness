import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EconomicScenario } from "./scenarios/economic";
import { reduceMind } from "./cognition";
import { hybridProposalSchema, psychologicalStateSchema, type PsychologicalState } from "./psychology";
import { scorePredictions, validatePredictions } from "./predictions";
import { redact, sourceHash } from "./cases";
import { SocietyStore } from "./store";
import { RunService } from "./run";
import { cognitivePhasesSchema, runSpecSchema, visible, type Character, type EventDraft, type Participant, type ParticipantFactory, type RunSpec, type TurnContext, type WorldEvent } from "./types";
import type { ModelReceipt } from "./model";
import { memoryMatchScore, memoryQueryTerms } from "./memory-search";
import { finishEpisode, integrateExperience, type AgentMind } from "../agents/cognition";
import { ledgerExperience, psychologyProjection } from "./agent-state";

export const studySpecSchema = z.object({
  kind: z.enum(["repair", "calibration", "free"]).default("repair"),
  repeats: z.number().int().min(1).max(20).default(5),
  modelProfileId: z.string().min(1).optional(),
  effort: z.enum(["low", "medium"]).default("low"),
  context: z.enum(["compact", "expanded"]).default("compact"),
  timeoutMs: z.number().int().min(1000).max(3600000).default(2400000),
  concurrency: z.number().int().min(1).max(3).default(2),
  phases: cognitivePhasesSchema.optional(),
  requestTimeoutMs: z.number().int().min(1000).max(360000).optional(),
  inertia: z.number().min(0).max(1).default(.6),
  decay: z.number().min(0).max(1).default(.1),
}).strict();
export type StudySpec = z.infer<typeof studySpecSchema>;
export type RepairCondition = "silence" | "apology" | "compensation";
export type Mechanism = "hybrid" | "instant" | "off";
export interface TrialSummary {
  id: string; group: string; condition: RepairCondition | "pledge" | "free"; mechanism: Mechanism;
  agreeableness: number; repeat: number; context: "compact" | "expanded"; effort: "low" | "medium";
  status: "queued" | "running" | "completed" | "failed" | "stopped";
  durationMs?: number; error?: string; inputTokens?: number; outputTokens?: number; calls?: number; truncations?: number; toolErrors?: number;
  returnedShare?: number; repair?: number; investment?: number; score?: number; runId?: string;
  forecasts?: number; scoredForecasts?: number; meanBrier?: number;
}
export interface StudyRecord { id: string; spec: StudySpec; sourceHash: string; createdAt: string; status: "running" | "completed" | "stopped" | "interrupted"; trials: TrialSummary[]; prefixes?: Array<{ group: string; caseRunId: string; calls: number; inputTokens: number; outputTokens: number; truncations: number; error?: string }>; error?: string; }
export interface TrialResult extends TrialSummary { events: WorldEvent[]; predictions: ReturnType<typeof scorePredictions>; cognition?: AgentMind; receipts: ModelReceipt[]; errors: string[]; }

export function studyCharacters(agreeableness: number): Character[] {
  const base: Character = { id: "self", name: "林", persona: "你与另一位参与者进行有实际积分结算的重复交易。", goals: ["获得收益", "理解对方是否值得继续合作"], values: ["收益", "公平", "关系"], voice: "简短自然，回应眼前的人", temperament: { openness: .5, conscientiousness: .5, extraversion: .5, agreeableness, neuroticism: .5 } };
  return [base, { ...structuredClone(base), id: "peer", name: "陈", temperament: { ...base.temperament!, agreeableness: .5 } }];
}
export function trialSpec(study: StudySpec, trial: TrialSummary): RunSpec {
  const phase = { effort: trial.effort };
  return runSpecSchema.parse({ scenario: "trust-game", mode: "experiment", worldId: trial.id, trustProtocol: "pledge-repair", rounds: 3,
    roster: ["self", "peer"].map(characterId => ({ characterId, modelProfileId: study.modelProfileId })),
    budgets: { discussionTurns: 2, maxTurns: 8 },
    experiment: { psychology: trial.mechanism === "off" ? "off" : "hybrid", personality: "full", speaking: "round-robin", relationshipMemory: true },
    cognition: { inertia: trial.mechanism === "instant" ? 0 : study.inertia, decay: trial.mechanism === "instant" ? 0 : study.decay, context: trial.context, requestTimeoutMs: study.requestTimeoutMs, phases: { psychology: phase, action: phase, discussion: phase, ...(study.kind === "calibration" ? {} : study.phases) } } });
}

/** A controlled prefix is reconstructed through legal commands, never by editing balances. */
export class RepairSandbox {
  readonly world: EconomicScenario;
  readonly characters: Character[];
  events: WorldEvent[] = [];
  mind?: PsychologicalState;
  cognition?: AgentMind;
  private activations = new Set<string>();
  receipts: ModelReceipt[] = [];
  errors: string[] = [];
  private serial = 0;
  constructor(readonly id: string, readonly spec: RunSpec, agreeableness: number, readonly saveCase: SocietyStore["saveCase"]) {
    this.characters = studyCharacters(agreeableness);
    this.world = new EconomicScenario("trust-game", this.characters, 3, "pledge-repair");
    this.phase();
  }
  emit(draft: EventDraft) {
    const event = { ...structuredClone(draft), id: `${this.id}/${++this.serial}`, runId: this.id, seq: this.events.length + 1, at: "" };
    this.events.push(event);
    if (this.cognition && visible(event, { actorId: "self" })) { const experience = ledgerExperience(event, this.spec, "self"); if (experience) integrateExperience(this.cognition, experience); }
    return event;
  }
  phase() {
    const stage = this.world.stage(); if (!stage) return;
    this.emit({ type: "phase", visibility: "public", text: stage.label, data: { round: stage.round, stageId: stage.id, world: this.world.publicState() } });
    this.emit({ type: "fact", visibility: ["self"], text: this.world.observe("self"), data: { identityScope: this.id, stageId: stage.id, round: stage.round } });
  }
  advance() { for (const e of this.world.advance()) this.emit(e); this.phase(); }
  apply(actorId: string, name: string, amount: number, scripted = true) { for (const e of this.world.apply(actorId, name, { amount })) this.emit({ ...e, data: { ...e.data, scripted } }); }
  bootstrap() {
    this.advance(); this.apply("peer", "pledge_return", 50); this.advance();
    this.apply("self", "invest", 6); this.advance(); this.advance(); this.apply("peer", "return_funds", 0); this.advance();
  }
  intervention(condition: RepairCondition) {
    if (condition !== "silence") this.emit({ type: "message", actorId: "peer", visibility: "public", text: "刚才是我反悔了。对不起，我想继续合作。", data: { channel: "public", scripted: true, round: 1 } });
    this.advance(); this.apply("peer", "repair_transfer", condition === "compensation" ? 9 : 0); this.advance();
  }
  fork(id: string) {
    const fork = new RepairSandbox(id, this.spec, this.characters[0].temperament!.agreeableness, this.saveCase);
    fork.world.restore(this.world.checkpoint()); fork.events = structuredClone(this.events); fork.mind = structuredClone(this.mind); fork.serial = this.serial;
    // A counterfactual branch is the same psychological moment, not a new environment.
    // Rebind episode-local state without decay, closing plans or forgetting role beliefs.
    if (this.cognition) {
      fork.cognition = structuredClone(this.cognition);
      const originalEpisode = fork.cognition.episode; fork.cognition.episode = id;
      for (const item of [...fork.cognition.plans, ...fork.cognition.memories, ...fork.cognition.predictions,
        ...fork.cognition.decisions, ...Object.values(fork.cognition.relationships), ...Object.values(fork.cognition.episodeBeliefs ?? {})]) if (item.episode === originalEpisode) item.episode = id;
      fork.cognition.cursors[id] = fork.cognition.cursors[originalEpisode] ?? 0;
    }
    return fork;
  }
  async turn(participant: Participant, signal: AbortSignal, appraisalOnly = false) {
    signal.throwIfAborted();
    const stage = this.world.stage()!; const actions = this.world.actions("self");
    const evidence = this.events.filter(e => visible(e, { actorId: "self" }) && ["action", "fact", "message"].includes(e.type));
    const ownOpinions = () => this.events.filter(e => e.type === "note" && e.actorId === "self" && e.data.kind !== "psychology").map(e => ({ id: e.id, characterId: "self", runId: e.runId, kind: "note" as const, text: e.text, at: e.at, sourceIds: e.data.sourceIds as string[], about: e.data.about as string[], sources: this.events.filter(source => (e.data.sourceIds as string[]).includes(source.id) && visible(source, { actorId: "self" })) }));
    const opinions = ownOpinions();
    const allowed = new Set(evidence.map(e => e.id)); const submitted = new Set<string>(); let saved = false;
    const c: TurnContext = { character: this.characters[0], worldObservation: this.world.observation("self"), observation: this.world.observe("self"), recent: evidence, inbox: [], memories: opinions, psychology: this.mind, cognition: this.cognition, signal, appraisalOnly,
      lookupEvidence: id => this.events.find(event => event.id === id && visible(event, { actorId: "self" })),
      commitActivation: activation => {
        signal.throwIfAborted();
        if (activation.id !== c.opportunity.id || activation.actorId !== "self" || activation.stageId !== stage.id || this.activations.has(activation.id)) throw new Error("无效或重复的实验激活");
        const before = { world: this.world.checkpoint(), events: structuredClone(this.events), mind: structuredClone(this.mind), cognition: structuredClone(this.cognition), serial: this.serial };
        try {
          if (activation.cognition) {
            this.cognition = structuredClone(activation.cognition);
            const frontier = this.events.at(-1)?.seq ?? 0;
            const known = new Set(before.cognition?.predictions.map(p => p.id));
            for (const prediction of this.cognition.predictions) if (!known.has(prediction.id)) prediction.afterSeq = frontier;
            for (const event of this.events) if (visible(event, { actorId: "self" })) { const experience = ledgerExperience(event, this.spec, "self"); if (experience) integrateExperience(this.cognition, experience); }
            this.mind = psychologyProjection(this.cognition, stage.id);
            this.emit({ type: "note", actorId: "self", visibility: ["self"], text: this.cognition.appraisal?.interpretation ?? "心理状态",
              data: { kind: "psychology", version: this.cognition.version, cognition: this.cognition, psychology: this.mind, sourceIds: this.cognition.appraisal?.sourceIds ?? [], stageId: stage.id, round: stage.round } });
          }
          for (const pending of activation.calls) {
            const action = actions.find(a => a.name === pending.name);
            if (!action || submitted.has(action.name)) throw new Error("实验激活包含非法或重复行动");
            const { amount } = action.parameters.parse(pending.args) as { amount: number };
            this.apply("self", action.name, amount, false); submitted.add(action.name);
          }
          if (!appraisalOnly && actions.some(a => !submitted.has(a.name))) throw new Error("实验激活未完成全部行动");
          this.activations.add(activation.id);
        } catch (error) { this.world.restore(before.world); this.events = before.events; this.mind = before.mind; this.cognition = before.cognition; this.serial = before.serial; submitted.clear(); throw error; }
      },
      opportunity: { id: `${this.id}/turn-${this.events.length}`, actorId: "self", stage, channel: stage.kind === "discussion" ? "public" : "private", recipients: stage.kind === "discussion" ? ["self", "peer"] : ["self"], actions, communications: [] },
      recordModelResponse: receipt => this.receipts.push(receipt), recordDecisionCase: record => this.saveCase(record),
      recordHarnessEvent: event => this.emit({ type: "trace", actorId: "self", visibility: "research", text: "sdk-harness", data: { ...event, harness: true, opportunityId: c.opportunity.id } }),
      recordToolError: (name, error) => this.errors.push(`${name}: ${error}`),
      call: async (name, args) => {
        signal.throwIfAborted();
        if (name === "update_mind") {
          if (saved || this.spec.experiment.psychology === "off") throw new Error("状态不可重复保存");
          const proposal = (this.spec.experiment.psychology === "hybrid" ? hybridProposalSchema : psychologicalStateSchema).parse(args);
          if ("conflict" in proposal) validatePredictions(proposal, this.spec, "self", evidence);
          if (proposal.sourceIds.some(id => !allowed.has(id)) || proposal.relationships.some(r => r.targetId !== "peer") || "conflict" in proposal && proposal.relationships.some(r => r.sourceIds.some(id => !allowed.has(id)))) throw new Error("无效的心理证据或关系对象");
          this.mind = this.spec.experiment.psychology === "hybrid" ? reduceMind(this.mind, proposal, stage.id, this.spec.cognition?.inertia, this.spec.cognition?.decay) : psychologicalStateSchema.parse(proposal);
          this.emit({ type: "note", actorId: "self", visibility: ["self"], text: this.mind.appraisal, data: { kind: "psychology", psychology: this.mind, stageId: stage.id, round: stage.round } }); saved = true; return this.mind;
        }
        if (actions.some(a => a.name === name) && !submitted.has(name)) { const { amount } = actions.find(a => a.name === name)!.parameters.parse(args) as { amount: number }; this.apply("self", name, amount, false); submitted.add(name); return { accepted: true, world: this.world.publicState() }; }
        if (name === "wait") {
          if (actions.some(a => !submitted.has(a.name))) throw new Error("当前需要提交实际行动；选择0也须通过对应行动工具提交，不能用等待代替。");
          return {};
        }
        if (name === "recall_memory") {
          const { query, about } = z.object({ query: z.string().max(200), about: z.string().nullable() }).parse(args);
          const experiences = evidence.map(e => ({ text: e.text, sourceIds: [e.id], kind: "experience", about: e.actorId ? [e.actorId] : [], sources: [e] }));
          const terms = memoryQueryTerms(query);
          return [...ownOpinions().toReversed(), ...experiences.toReversed()].filter(m => !about || m.about.includes(about))
            .map(m => ({ memory: m, score: memoryMatchScore(m.text, terms) })).filter(m => m.score > 0)
            .sort((a, b) => b.score - a.score).slice(0, 12).map(m => m.memory);
        }
        if (name === "remember") {
          const note = z.object({ text: z.string().trim().min(1).max(1500), sourceIds: z.array(z.string()).min(1).max(12), about: z.array(z.string()).max(12) }).strict().parse(args);
          if (note.sourceIds.some(id => !allowed.has(id) && !ownOpinions().some(m => m.id === id)) || note.about.some(id => !this.characters.some(c => c.id === id))) throw new Error("记忆只能引用自己收到的事实、发言或自身旧笔记，以及在场人物");
          this.emit({ type: "note", actorId: "self", visibility: ["self"], text: note.text, data: { ...note, stageId: stage.id, round: stage.round } }); return { accepted: true };
        }
        throw new Error("该工具当前不可用");
      },
    };
    const result = await participant.turn(c);
    if (actions.some(a => !submitted.has(a.name))) throw new Error("未提交合法行动");
    if (result.text && !appraisalOnly && stage.kind === "discussion") this.emit({ type: "message", actorId: "self", visibility: "public", text: result.text, data: { channel: "public", stageId: stage.id, round: stage.round } });
  }
  async finish(participant: Participant, signal: AbortSignal) {
    while (this.world.stage()) {
      const stage = this.world.stage()!;
      if (stage.kind === "action") {
        if (stage.actors.includes("self")) await this.turn(participant, signal);
        else for (const action of this.world.actions("peer")) this.apply("peer", action.name, action.name === "pledge_return" ? 50 : action.name === "invest" ? 6 : action.name === "return_funds" ? Math.floor(Number(this.world.publicState().investment) * 1.5) : 0);
      } else if (stage.id === "1:after-repair") await this.turn(participant, signal);
      this.advance();
    }
    if (this.cognition) {
      finishEpisode(this.cognition); this.mind = psychologyProjection(this.cognition, "done");
      this.emit({ type: "note", actorId: "self", visibility: ["self"], text: "已结算并保存实际反馈",
        data: { kind: "psychology", cognition: this.cognition, psychology: this.mind, sourceIds: this.cognition.appraisal?.sourceIds ?? [], stageId: "done", round: this.spec.rounds } });
    }
  }
}

export function trialResult(trial: TrialSummary, box: RepairSandbox, started: number, error?: unknown): TrialResult {
  const own = box.events.filter(e => e.type === "action" && e.actorId === "self" && e.data.scripted !== true);
  const amount = (action: string, round: number) => own.find(e => e.data.action === action && e.data.round === round)?.data.amount as number | undefined;
  const returned = amount("return_funds", 2);
  const invested = box.events.find(e => e.type === "action" && e.data.action === "invest" && e.data.round === 2)?.data.amount as number | undefined;
  return redact({ ...trial, status: error ? "failed" : "completed", error: error ? error instanceof Error ? error.message : String(error) : undefined,
    durationMs: Date.now() - started, inputTokens: box.receipts.reduce((n, r) => n + r.inputTokens, 0), outputTokens: box.receipts.reduce((n, r) => n + r.outputTokens, 0), calls: box.receipts.length,
    truncations: box.receipts.filter(r => r.finishReason === "length" || r.finishReason === "incomplete" || r.outputError === "truncated").length, toolErrors: box.errors.length,
    returnedShare: returned === undefined || !invested ? undefined : returned / (invested * 3), repair: amount("repair_transfer", 2), investment: amount("invest", 3), score: trial.condition === "free" ? (box.events.findLast(e => e.data.scores)?.data.scores as Record<string, number> | undefined)?.self : box.world.publicState().scores.self,
    events: box.events, predictions: scorePredictions(box.events), cognition: box.cognition,
    forecasts: box.cognition?.predictions.length, scoredForecasts: box.cognition?.learning.scored,
    meanBrier: box.cognition?.learning.scored ? box.cognition.learning.brierSum / box.cognition.learning.scored : undefined,
    receipts: box.receipts, errors: box.errors });
}

export class StudyService {
  private jobs = new Map<string, { abort: AbortController; task: Promise<void> }>();
  constructor(readonly store: SocietyStore, readonly factory: ParticipantFactory, readonly runs?: RunService) {}
  create(input: unknown) {
    const spec = studySpecSchema.parse(input); const id = randomUUID(); const trials: TrialSummary[] = [];
    const add = (condition: TrialSummary["condition"], mechanism: Mechanism, agreeableness: number, repeat: number, context = spec.context, effort = spec.effort) => {
      const group = `${id}/${mechanism}/${agreeableness}/${repeat}/${context}/${effort}`;
      trials.push({ id: randomUUID(), group, condition, mechanism, agreeableness, repeat, context, effort, status: "queued" });
    };
    if (spec.kind === "repair") for (let repeat = 0; repeat < spec.repeats; repeat++) for (const mechanism of ["hybrid", "instant", "off"] as const) for (const trait of [.2, .8]) for (const condition of ["silence", "apology", "compensation"] as const) add(condition, mechanism, trait, repeat);
    if (spec.kind === "calibration") for (const context of ["compact", "expanded"] as const) for (const effort of ["low", "medium"] as const) for (const condition of ["pledge", "silence", "apology", "compensation"] as const) add(condition, "hybrid", .5, 0, context, effort);
    if (spec.kind === "free") for (let i = 0; i < 6; i++) add("free", "hybrid", i % 2 ? .8 : .2, i);
    const record: StudyRecord = { id, spec, sourceHash: sourceHash(), createdAt: new Date().toISOString(), status: "running", trials, prefixes: [] };
    this.store.saveStudy(record); const abort = new AbortController();
    const task = this.execute(record, abort.signal).catch(error => { record.status = abort.signal.aborted ? "stopped" : "interrupted"; record.error = redact(String(error)); this.store.saveStudy(record); }).finally(() => this.jobs.delete(id));
    this.jobs.set(id, { abort, task }); return record;
  }
  stop(id: string) { this.jobs.get(id)?.abort.abort(new Error("研究者停止批次")); }
  stopAll() { for (const id of this.jobs.keys()) this.stop(id); }
  recoverInterrupted() {
    for (const record of this.store.studies<StudyRecord>()) if (record.status === "running" && !this.jobs.has(record.id)) {
      record.status = "interrupted"; record.error = "进程已中断；已完成结果保留，未自动重新请求模型。";
      for (const trial of record.trials) if (["queued", "running"].includes(trial.status)) trial.status = "stopped";
      this.store.saveStudy(record);
    }
  }
  async settled(id: string) { await this.jobs.get(id)?.task; }
  async settledAll() { await Promise.allSettled([...this.jobs.values()].map(job => job.task)); }
  private async execute(record: StudyRecord, signal: AbortSignal) {
    const prefixes = new Map<string, RepairSandbox | Error>();
    const groups = [...new Set(record.trials.map(t => t.group))];
    const runGroup = async (group: string) => { for (const trial of record.trials.filter(t => t.group === group)) {
      if (signal.aborted) break;
      trial.status = "running"; this.store.saveStudy(record);
      const started = Date.now(); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(new Error("试验超时")), record.spec.timeoutMs);
      const combined = AbortSignal.any([signal, controller.signal]);
      const spec = trialSpec(record.spec, trial);
      let box = new RepairSandbox(trial.id, spec, trial.agreeableness, value => this.store.saveCase(value));
      let failure: unknown;
      try {
        if (record.spec.kind === "free") {
          const characters = studyCharacters(trial.agreeableness); characters[1].temperament!.agreeableness = trial.agreeableness === .2 ? .8 : .2;
          const run = (this.runs ?? new RunService(this.store, this.factory)).create(spec, characters).run; trial.runId = run.id;
          const stop = () => run.control("stop"); combined.addEventListener("abort", stop, { once: true });
          try { await run.settled(); } finally { combined.removeEventListener("abort", stop); }
          box.events = this.store.events(run.id); box.receipts = box.events.filter(e => e.text === "model-response").map(e => e.data as unknown as ModelReceipt);
          box.cognition = this.store.cognition(run.id, "self");
          box.errors = box.events.filter(e => e.data.toolError).map(e => String(e.data.message ?? e.text));
          if (run.status !== "completed") throw new Error(box.events.findLast(e => e.data.error)?.text ?? `对局${run.status}`);
        } else if (record.spec.kind === "calibration") {
          box.bootstrap(); box.intervention(trial.condition === "pledge" ? "silence" : trial.condition as RepairCondition);
          box.advance(); box.advance();
          if (trial.condition !== "pledge") { box.apply("self", "pledge_return", 50); box.advance(); box.apply("peer", "invest", 6); box.advance(); box.advance(); }
          await box.turn(this.factory(box.characters[0], spec, box.id), combined);
        } else {
          if (!prefixes.has(trial.group)) {
            const prefix = new RepairSandbox(randomUUID(), spec, trial.agreeableness, value => this.store.saveCase(value)); prefix.bootstrap();
            try { await prefix.turn(this.factory(prefix.characters[0], spec, prefix.id), combined, true); prefixes.set(trial.group, prefix); }
            catch (error) { prefixes.set(trial.group, error instanceof Error ? error : new Error(String(error))); box = prefix.fork(trial.id); throw error; }
            finally { record.prefixes!.push({ group: trial.group, caseRunId: prefix.id, calls: prefix.receipts.length, inputTokens: prefix.receipts.reduce((n, r) => n + r.inputTokens, 0), outputTokens: prefix.receipts.reduce((n, r) => n + r.outputTokens, 0), truncations: prefix.receipts.filter(r => r.finishReason === "length" || r.finishReason === "incomplete" || r.outputError === "truncated").length, error: prefixes.get(trial.group) instanceof Error ? redact(String(prefixes.get(trial.group))) : undefined }); }
          }
          const prefix = prefixes.get(trial.group)!; if (prefix instanceof Error) throw prefix;
          box = prefix.fork(trial.id); box.intervention(trial.condition as RepairCondition);
          await box.finish(this.factory(box.characters[0], spec, box.id), combined);
        }
      } catch (error) { failure = error; }
      finally { clearTimeout(timeout); }
      const result = trialResult(trial, box, started, failure); if (signal.aborted) result.status = "stopped";
      this.store.saveTrial(record.id, result); const { events: _events, predictions: _predictions, cognition: _cognition, receipts: _receipts, errors: _errors, ...summary } = result;
      Object.assign(trial, summary); this.store.saveStudy(record);
    } };
    await Promise.all(Array.from({ length: record.spec.concurrency }, async () => { while (!signal.aborted) { const group = groups.shift(); if (!group) break; await runGroup(group); } }));
    record.status = signal.aborted ? "stopped" : "completed";
    if (signal.aborted) for (const trial of record.trials) if (trial.status === "queued") trial.status = "stopped";
    this.store.saveStudy(record);
  }
}
