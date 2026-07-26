import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import { apiJson, errorMessage } from "../appInspectors";
import type { ArtifactView, MatchRecord } from "../appShared";
import { readLiveMatchProjection, type LiveMatchProjection } from "../werewolfLiveProjection";
import type { SetActionStatus } from "./useCockpitStatus";

/**
 * Live state is a disposable server projection, never a browser GameState
 * or a substitute for the artifact/replay authority.
 */
export function useLiveProjectionState() {
  const [liveMatchId, setLiveMatchId] = useState<string | null>(null);
  const [liveProjection, setLiveProjection] = useState<LiveMatchProjection | null>(null);
  const [livePollError, setLivePollError] = useState<string | null>(null);
  const livePollSeqRef = useRef(0);

  return {
    liveMatchId,
    setLiveMatchId,
    liveProjection,
    setLiveProjection,
    livePollError,
    setLivePollError,
    livePollSeqRef
  };
}

/**
 * Polls `/api/matches/:id/live` while a live match id is active and hands off
 * to the terminal artifact authority once the server advertises one.
 */
export function useLiveMatchPolling({
  liveMatchId,
  livePollSeqRef,
  setLiveProjection,
  setLivePollError,
  loadArtifact,
  canUsePostgameArtifact,
  candidateId,
  setActionStatus
}: {
  liveMatchId: string | null;
  livePollSeqRef: RefObject<number>;
  setLiveProjection: Dispatch<SetStateAction<LiveMatchProjection | null>>;
  setLivePollError: Dispatch<SetStateAction<string | null>>;
  loadArtifact: (
    match: MatchRecord | string,
    view: ArtifactView,
    comparisonCandidateId?: string,
    options?: { preserveLiveUntilLoaded?: boolean }
  ) => Promise<void>;
  canUsePostgameArtifact: boolean;
  candidateId: string;
  setActionStatus: SetActionStatus;
}) {
  useEffect(() => {
    if (!liveMatchId) return;
    const pollSequence = livePollSeqRef.current + 1;
    livePollSeqRef.current = pollSequence;
    const abortController = new AbortController();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finishTerminalProjection = async (projection: Extract<LiveMatchProjection, { lifecycle: "completed" | "truncated" | "failed" }>) => {
      if (!projection.artifactAvailable) {
        // Keep the closed spectator shell mounted. There is no artifact
        // authority to load and no reason to fetch/render operator registry
        // metadata after an artifact-less terminal outcome.
        setActionStatus(
          projection.lifecycle === "failed"
            ? "实时局已失败，服务端未提供可加载的赛后工件。"
            : "实时局已结束，但服务端没有可加载的赛后工件。"
        );
        return;
      }
      // The terminal DTO's id is enough to fetch its postgame projection.
      // Do not consult `/api/matches` first: that is an operator registry and
      // must not be a spectator prerequisite or a live metadata side channel.
      if (disposed || pollSequence !== livePollSeqRef.current) return;
      void loadArtifact(
        projection.matchId,
        canUsePostgameArtifact ? "postgame-redacted" : "truth-redacted",
        candidateId,
        { preserveLiveUntilLoaded: true }
      );
    };

    const poll = async () => {
      try {
        const rawProjection = await apiJson<unknown>(`/api/matches/${encodeURIComponent(liveMatchId)}/live`, {
          signal: abortController.signal
        });
        if (disposed || pollSequence !== livePollSeqRef.current) return;
        const projection = readLiveMatchProjection(rawProjection, liveMatchId);
        setLiveProjection(projection);
        setLivePollError(null);
        if (projection.lifecycle === "running") {
          timer = setTimeout(() => void poll(), 900);
          return;
        }
        await finishTerminalProjection(projection);
      } catch (nextError) {
        if (disposed || abortController.signal.aborted || pollSequence !== livePollSeqRef.current) return;
        setLivePollError(errorMessage(nextError));
        timer = setTimeout(() => void poll(), 1_500);
      }
    };

    void poll();
    return () => {
      disposed = true;
      abortController.abort();
      if (timer) clearTimeout(timer);
    };
  }, [canUsePostgameArtifact, candidateId, liveMatchId, loadArtifact, setActionStatus]);
}
