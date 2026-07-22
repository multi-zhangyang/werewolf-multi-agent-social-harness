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
  const entries = input.events
    .map((event) => projectEntry(event, input))
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
  input: {
    episode?: Pick<SocialEpisodeArtifact, "steps">;
    view: LedgerView;
  }
): WerewolfPostgameEventLedgerEntryDto | null {
  const safeLabel = event.visibility === "public" ? SAFE_PUBLIC_EVENT_LABELS[event.type] : undefined;
  if (!safeLabel) return null;

  const nativeBoundary =
    input.view === "postgame-redacted" && input.episode
      ? nativeBoundaryForEventSeq(input.episode.steps, event.seq)
      : undefined;

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
 */
function nativeBoundaryForEventSeq(
  steps: readonly SocialHarnessStep[],
  eventSeq: number
): WerewolfPostgameEventLedgerEntryDto["nativeBoundary"] | undefined {
  const sourceIndex = steps.findIndex(
    (step) =>
      isSocialStepCommitted(step) &&
      step.eventSeqRange !== undefined &&
      step.eventSeqRange[0] <= eventSeq &&
      eventSeq <= step.eventSeqRange[1]
  );
  if (sourceIndex < 0) return undefined;

  const source = steps[sourceIndex];
  if (!source) return undefined;
  let boundaryIndex = sourceIndex;
  if (source.batchId) {
    while (steps[boundaryIndex + 1]?.batchId === source.batchId) {
      boundaryIndex += 1;
    }
  }
  if (!isSafeHarnessCheckpointBoundary(steps, boundaryIndex)) return undefined;
  return { nativeStepCount: boundaryIndex + 1 };
}
