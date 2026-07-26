import type { GameEvent } from "../core/types";
import { isSafeHarnessCheckpointBoundary } from "../harness/episodeArtifacts";
import { isSocialStepCommitted, type SocialEpisodeArtifact, type SocialHarnessStep } from "../harness/social";
import type {
  WerewolfPostgameEventLedgerDto,
  WerewolfPostgameEventLedgerEntryDto
} from "./artifactProjection";

type LedgerView = WerewolfPostgameEventLedgerDto["projection"]["view"];

/**
 * This is a security allowlist, rather than a presentation dictionary for
 * every domain event.  In particular, private night actions and postgame
 * `game.created` are intentionally absent.  Never replace this with a
 * `GameEvent.payload` formatter: public event payloads can still contain
 * postgame-only facts such as a winner, role, or source id.
 */
const SAFE_PUBLIC_EVENT_LABELS: Partial<Record<GameEvent["type"], string>> = {
  "phase.changed": "阶段已切换",
  "night.resolved": "夜晚结果已公布",
  "speech.submitted": "公开发言已记录",
  "vote.cast": "放逐投票已记录",
  "sheriff.vote_cast": "警长投票已记录",
  "sheriff.elected": "警长产生",
  "sheriff.vacated": "警长职位空缺",
  "last_words.submitted": "遗言已记录",
  "player.died": "玩家出局",
  "hunter.shot": "猎人开枪结果已公布",
  "game.ended": "游戏结束"
};

export function projectWerewolfPostgameEventLedger(input: {
  events: readonly GameEvent[];
  episode?: Pick<SocialEpisodeArtifact, "steps">;
  view: LedgerView;
  authority: WerewolfPostgameEventLedgerDto["authority"];
}): WerewolfPostgameEventLedgerDto {
  const resolveNativeBoundary =
    input.view === "postgame-redacted" && input.episode
      ? createNativeBoundaryResolver(input.episode.steps)
      : undefined;
  const entries = input.events
    .map((event) => projectEntry(event, input.view, resolveNativeBoundary))
    .filter((entry): entry is WerewolfPostgameEventLedgerEntryDto => entry !== null)
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));

  return {
    artifactVersion: "server.werewolf-postgame-event-ledger.v1",
    kind: "werewolf-postgame-event-ledger",
    authority: input.authority,
    projection: {
      view: input.view,
      privateEvidenceRedacted: true,
      postgameTruthRedacted: input.view === "truth-redacted"
    },
    entries
  };
}

function projectEntry(
  event: GameEvent,
  view: LedgerView,
  resolveNativeBoundary: ((eventSeq: number) => WerewolfPostgameEventLedgerEntryDto["nativeBoundary"] | undefined) | undefined
): WerewolfPostgameEventLedgerEntryDto | null {
  const safeLabel = event.visibility === "public" ? SAFE_PUBLIC_EVENT_LABELS[event.type] : undefined;
  if (!safeLabel) return null;

  const nativeBoundary = view === "postgame-redacted" && resolveNativeBoundary ? resolveNativeBoundary(event.seq) : undefined;

  return {
    id: event.id,
    seq: event.seq,
    day: event.day,
    phase: event.phase,
    eventType: event.type,
    visibility: "public",
    safeLabel,
    ...(nativeBoundary ? { nativeBoundary } : {})
  };
}

/**
 * Link an event only to the end of its recorded committed native batch.
 * A parallel batch has several rows but one atomic environment transition;
 * pointing at an intermediate row would create a prefix the replay endpoint
 * is forbidden to build.
 *
 * The resolver preserves the exact first-matching-step semantics of the
 * previous per-event `steps.findIndex(...)` scan, but pre-indexes the
 * committed event-seq ranges once so ledger projection is O(steps + events)
 * instead of O(events x steps).
 */
function createNativeBoundaryResolver(
  steps: readonly SocialHarnessStep[]
): (eventSeq: number) => WerewolfPostgameEventLedgerEntryDto["nativeBoundary"] | undefined {
  interface CommittedInterval {
    start: number;
    end: number;
    stepIndex: number;
  }
  const intervals: CommittedInterval[] = [];
  for (const [stepIndex, step] of steps.entries()) {
    if (!isSocialStepCommitted(step) || step.eventSeqRange === undefined) continue;
    intervals.push({ start: step.eventSeqRange[0], end: step.eventSeqRange[1], stepIndex });
  }
  // Sort by range start, keeping the original step order for equal starts so
  // an overlapping range still resolves to the first matching step.
  const byStart = intervals
    .map((interval, order) => ({ ...interval, order }))
    .sort((left, right) => left.start - right.start || left.order - right.order);
  // Prefix maximum of range ends: lets a lookup stop scanning left as soon as
  // no earlier-starting interval can still contain the queried seq.
  const maxEndUpTo: number[] = new Array<number>(byStart.length);
  let runningMaxEnd = Number.NEGATIVE_INFINITY;
  for (const [index, interval] of byStart.entries()) {
    if (interval.end > runningMaxEnd) runningMaxEnd = interval.end;
    maxEndUpTo[index] = runningMaxEnd;
  }
  const boundaryByStepIndex = new Map<number, WerewolfPostgameEventLedgerEntryDto["nativeBoundary"] | undefined>();

  const boundaryForStepIndex = (sourceIndex: number): WerewolfPostgameEventLedgerEntryDto["nativeBoundary"] | undefined => {
    if (boundaryByStepIndex.has(sourceIndex)) return boundaryByStepIndex.get(sourceIndex);
    const source = steps[sourceIndex];
    let boundary: WerewolfPostgameEventLedgerEntryDto["nativeBoundary"] | undefined;
    if (source) {
      let boundaryIndex = sourceIndex;
      if (source.batchId) {
        while (steps[boundaryIndex + 1]?.batchId === source.batchId) {
          boundaryIndex += 1;
        }
      }
      boundary = isSafeHarnessCheckpointBoundary(steps, boundaryIndex) ? { nativeStepCount: boundaryIndex + 1 } : undefined;
    }
    boundaryByStepIndex.set(sourceIndex, boundary);
    return boundary;
  };

  return (eventSeq: number) => {
    // Binary search for the last interval with start <= eventSeq, then walk
    // left across any preceding intervals that also contain the seq to find
    // the first matching step (identical to the original findIndex result).
    let low = 0;
    let high = byStart.length - 1;
    let candidate = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (byStart[mid]!.start <= eventSeq) {
        candidate = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    let bestStepIndex = -1;
    for (let index = candidate; index >= 0; index -= 1) {
      if (maxEndUpTo[index]! < eventSeq) break;
      const interval = byStart[index]!;
      if (interval.end >= eventSeq && (bestStepIndex === -1 || interval.stepIndex < bestStepIndex)) {
        bestStepIndex = interval.stepIndex;
      }
    }
    if (bestStepIndex < 0) return undefined;
    return boundaryForStepIndex(bestStepIndex);
  };
}
