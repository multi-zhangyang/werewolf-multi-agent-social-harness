import { isHybrid, psychologyFromEvent } from "./psychology";
import type { WorldEvent } from "./types";

/** Compare pre-commitment self-report with the ledger; a discrepancy is not proof of intent. */
export function commitmentAudit(events: WorldEvent[]) {
  return events.filter(e => e.type === "action" && e.data.action === "pledge_return").map(pledge => {
    const round = Number(pledge.data.round);
    const thought = events.findLast(e => e.seq < pledge.seq && e.actorId === pledge.actorId && e.data.stageId === `${round}:pledge` && psychologyFromEvent(e));
    const state = psychologyFromEvent(thought);
    const intent = state && isHybrid(state) ? state.commitmentIntent : undefined;
    const outcome = events.find(e => e.seq > pledge.seq && e.data.round === round && (e.data.commitment as { actorId?: string } | undefined)?.actorId === pledge.actorId);
    const result = outcome?.data.commitment as { promised: number; returned: number; kept: boolean } | undefined;
    return { id: pledge.id, actorId: pledge.actorId, round, declaredPercent: Number(pledge.data.amount), intent,
      plannedPercent: intent?.plannedReturnPercent,
      promiseAbovePlan: intent ? Number(pledge.data.amount) > intent.plannedReturnPercent : undefined,
      status: result ? result.kept ? "kept" as const : "breached" as const : "pending" as const,
      promisedPoints: result?.promised, returnedPoints: result?.returned,
      sourceIds: [thought?.id, pledge.id, outcome?.id].filter((id): id is string => Boolean(id)),
    };
  });
}
