// Historical state schema and replay compatibility. Live cognition is in src/agents/cognition.ts.
import { hybridProposalSchema, isHybrid, type HybridState, type PsychologicalState } from "./psychology";
import type { TurnContext, WorldEvent } from "./types";

const clamp = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 10000) / 10000;
const phases = ["discussion", "pledge", "invest", "response", "return", "reflection", "repair", "after-repair"];
function tick(id: string) { const [round, phase] = id.split(":"); return Number(round) * phases.length + Math.max(0, phases.indexOf(phase)); }

/** Pure reducer: neither wall time nor a provider retry advances the simulation. */
export function reduceMind(previous: PsychologicalState | undefined, input: unknown, stageId: string, inertia = .6, decay = .1): HybridState {
  const proposal = hybridProposalSchema.parse(input);
  const prior = previous && isHybrid(previous) ? previous : undefined;
  const processed = new Set(prior?.dynamics.processedIds ?? []);
  const allSources = [...new Set([...proposal.sourceIds, ...proposal.relationships.flatMap(r => r.sourceIds)])];
  const newSourceIds = allSources.filter(id => !processed.has(id));
  const steps = prior ? Math.max(0, tick(stageId) - tick(prior.dynamics.stageId)) : 0;
  const labels = [...new Set([...(prior?.emotions.map(e => e.emotion) ?? []), ...proposal.emotions.map(e => e.emotion)])];
  const emotions = labels.map(emotion => {
    const baseline = emotion === "calm" ? 1 : 0;
    const old = prior?.emotions.find(e => e.emotion === emotion)?.intensity ?? baseline;
    const relaxed = baseline + (old - baseline) * (1 - decay) ** steps;
    const target = proposal.emotions.find(e => e.emotion === emotion)?.intensity ?? relaxed;
    return { emotion, intensity: clamp(newSourceIds.length ? inertia * relaxed + (1 - inertia) * target : relaxed) };
  }).sort((a, b) => b.intensity - a.intensity);
  const relationships = proposal.relationships.map(r => {
    const old = prior?.relationships.find(p => p.targetId === r.targetId);
    return old && !r.sourceIds.some(id => !processed.has(id)) ? old : r;
  });
  for (const old of prior?.relationships ?? []) if (!relationships.some(r => r.targetId === old.targetId)) relationships.push(old);
  return { ...proposal, emotions, needs: newSourceIds.length ? proposal.needs : prior?.needs ?? proposal.needs, relationships,
    version: "hybrid-v1", dynamics: { stageId, processedIds: [...new Set([...processed, ...allSources])], inertia, decay, newSourceIds, proposalEmotions: proposal.emotions } };
}

/** Budget old memories before evidence for the current transaction. Claims stay claims. */
export function cognitiveInput(c: TurnContext, mode: "compact" | "expanded" = "compact") {
  const events = [...new Map([...c.recent, ...c.inbox, ...c.memories.flatMap(m => m.sources ?? [])]
    .filter(e => ["message", "fact", "action"].includes(e.type)).map(e => [e.id, e])).values()];
  const identity = events.findLast(e => e.data.identityScope)?.id;
  const evidence = events.filter(e => !e.data.identityScope || e.id === identity);
  const latest = evidence.filter(e => !e.data.identityScope);
  const currentRound = c.opportunity.stage.round;
  const anchors = evidence.filter(e => e.data.commitment || e.data.repair || e.data.settlement).slice(-8);
  const selected = mode === "expanded" ? events : evidence.filter(e => e.id === identity || latest.slice(-8).includes(e) || e.type !== "message" && (e.data.round === currentRound || anchors.includes(e)));
  const concise = (e: WorldEvent) => ({ id: e.id, runId: e.runId, kind: e.type, actorId: e.actorId, text: e.text, data: e.data });
  return { perspective: { id: c.character.id, name: c.character.name, currentRole: c.worldObservation?.facts.ownRole, stageId: c.opportunity.stage.id, instruction: "所有第一人称都是这个人物本人。对方发言中的我指说话人，不是你。当前阶段只能执行 legalActions；投资先于返还，最后一轮结束后没有再次交易。" },
    world: c.worldObservation ?? { actorId: c.character.id, rules: c.observation, stageId: c.opportunity.stage.id },
    evidence: selected.filter(e => e.type !== "message").map(concise),
    statements: selected.filter(e => e.type === "message").map(concise),
    priorExperience: c.memories.slice(mode === "compact" ? -4 : -12).map(m => ({ kind: m.kind === "note" ? "opinion" : "experience", text: m.text, sourceIds: m.sourceIds, runId: m.runId })),
    previousState: psychologyForPrompt(c.psychology),
  };
}
export function psychologyForPrompt(state?: PsychologicalState) {
  if (!state) return null;
  if (!isHybrid(state)) return state;
  const { dynamics: _dynamics, ...report } = state;
  return report;
}
