import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import type { PostgameReplayFrameDto } from "../../../server/artifactProjection";
import { isSafeHarnessCheckpointBoundary } from "../../../harness/episodeArtifacts";
import {
  apiJson,
  assertServerReplayFrame,
  errorMessage,
  inspectorFromReplay,
  shortId
} from "../appInspectors";
import type {
  ArtifactView,
  InspectorItem,
  ProjectedMatchArtifact,
  ReplayFrameLoadState,
  ReplayFrameResponse,
  ReplayResponse
} from "../appShared";
import type { SetActionStatus } from "./useCockpitStatus";

/**
 * Cursor state is presentation-only. The server owns replay, state hashes,
 * redaction, and native batch-boundary validation.
 */
export function useReplayState() {
  const [replay, setReplay] = useState<ReplayResponse | null>(null);
  const [replayFrame, setReplayFrame] = useState<PostgameReplayFrameDto | null>(null);
  const [replayFrameCursorIndex, setReplayFrameCursorIndex] = useState<number | null>(null);
  const [replayFrameLoadState, setReplayFrameLoadState] = useState<ReplayFrameLoadState>("idle");
  const [replayFrameError, setReplayFrameError] = useState<string | null>(null);
  const replayFrameLoadSeqRef = useRef(0);

  return {
    replay,
    setReplay,
    replayFrame,
    setReplayFrame,
    replayFrameCursorIndex,
    setReplayFrameCursorIndex,
    replayFrameLoadState,
    setReplayFrameLoadState,
    replayFrameError,
    setReplayFrameError,
    replayFrameLoadSeqRef
  };
}

/**
 * Server-side replay validation plus the batch-boundary replay-frame cursor
 * for the currently loaded artifact.
 */
export function useReplayActions({
  artifact,
  currentMatchId,
  artifactView,
  canUsePostgameReplay,
  setReplay,
  replayFrameLoadSeqRef,
  setReplayFrame,
  setReplayFrameCursorIndex,
  setReplayFrameLoadState,
  setReplayFrameError,
  setInspector,
  setActionStatus,
  setBusy
}: {
  artifact: ProjectedMatchArtifact | null;
  currentMatchId: string;
  artifactView: ArtifactView;
  canUsePostgameReplay: boolean;
  setReplay: Dispatch<SetStateAction<ReplayResponse | null>>;
  replayFrameLoadSeqRef: RefObject<number>;
  setReplayFrame: Dispatch<SetStateAction<PostgameReplayFrameDto | null>>;
  setReplayFrameCursorIndex: Dispatch<SetStateAction<number | null>>;
  setReplayFrameLoadState: Dispatch<SetStateAction<ReplayFrameLoadState>>;
  setReplayFrameError: Dispatch<SetStateAction<string | null>>;
  setInspector: Dispatch<SetStateAction<InspectorItem | null>>;
  setActionStatus: SetActionStatus;
  setBusy: Dispatch<SetStateAction<string | null>>;
}) {
  const handleReplay = useCallback(async () => {
    if (!currentMatchId) {
      setActionStatus("无法复现：尚未选择 run。");
      return;
    }
    if (!canUsePostgameReplay || artifactView !== "postgame-redacted") {
      setReplay(null);
      setActionStatus("当前连接没有 postgame replay 权限；未发送复现请求。");
      return;
    }
    setBusy("replay");
    try {
      const nextReplay = await apiJson<ReplayResponse>(`/api/matches/${encodeURIComponent(currentMatchId)}/replay`, {
        method: "POST",
        body: JSON.stringify({ stopOnMismatch: true })
      });
      setReplay(nextReplay);
      setInspector(inspectorFromReplay(nextReplay));
      const ok = Boolean(nextReplay.summary?.ok);
      setActionStatus(
        ok
          ? `原生复现通过：${nextReplay.summary?.replayedSteps ?? 0} steps / ${nextReplay.summary?.replayedBatches ?? 0} batches，state=${String(nextReplay.summary?.finalHashMatchesArtifact ?? nextReplay.summary?.finalHashMatchesExpected ?? false)}，messages=${String(nextReplay.summary?.messagesHashMatchesExpected ?? false)}`
          : `复现失败：mismatch=${nextReplay.summary?.mismatchCount ?? "unknown"}`,
        ok ? null : nextReplay.error ?? "replay validator reported mismatch"
      );
    } catch (nextError) {
      setActionStatus("复现请求失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [artifactView, canUsePostgameReplay, currentMatchId, setActionStatus]);

  const handleLoadReplayFrame = useCallback(
    async (index: number) => {
      if (!artifact || !currentMatchId) {
        setActionStatus("无法定位回放帧：尚未选择带工件的 run。");
        return;
      }
      if (!canUsePostgameReplay || artifactView !== "postgame-redacted") {
        setActionStatus("当前连接没有 postgame replay frame 权限；未发送请求。");
        return;
      }
      const step = artifact.socialEpisode.steps[index];
      if (!step) {
        setActionStatus("无法定位回放帧：原生步骤不存在。");
        return;
      }
      if (!isSafeHarnessCheckpointBoundary(artifact.socialEpisode.steps, index)) {
        setActionStatus("该步骤处于原子并行批次中间；只能在完整批次末尾定位服务端回放局面。");
        return;
      }
      const requestSeq = replayFrameLoadSeqRef.current + 1;
      replayFrameLoadSeqRef.current = requestSeq;
      setReplayFrame(null);
      setReplayFrameLoadState("loading");
      setReplayFrameError(null);
      setBusy("replay-frame");
      try {
        const response = await apiJson<ReplayFrameResponse>(`/api/matches/${encodeURIComponent(currentMatchId)}/replay/frame`, {
          method: "POST",
          body: JSON.stringify({ nativeStepCount: index + 1 })
        });
        if (requestSeq !== replayFrameLoadSeqRef.current) return;
        assertServerReplayFrame(response.frame, step, index + 1);
        setReplayFrame(response.frame);
        setReplayFrameCursorIndex(index);
        setReplayFrameLoadState("idle");
        setActionStatus(
          `已定位服务端回放帧：native #${index + 1} · state=${shortId(response.frame.cursor.stateHash)} · messages=${response.frame.cursor.messageCount}`
        );
      } catch (nextError) {
        if (requestSeq !== replayFrameLoadSeqRef.current) return;
        const message = errorMessage(nextError);
        setReplayFrameLoadState("error");
        setReplayFrameError(message);
        setActionStatus("服务端回放帧加载失败", message);
      } finally {
        if (requestSeq === replayFrameLoadSeqRef.current) setBusy(null);
      }
    },
    [artifact, artifactView, canUsePostgameReplay, currentMatchId, setActionStatus]
  );

  return { handleReplay, handleLoadReplayFrame };
}
