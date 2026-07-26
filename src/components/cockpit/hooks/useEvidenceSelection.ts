import { useCallback, type Dispatch, type SetStateAction } from "react";

import type {
  AgentHarnessState,
  HarnessEvaluationWarning,
  HarnessMetricRecord
} from "../../../harness/types";
import type { SocialMessage } from "../../../harness/social";
import {
  inspectorFromAgent,
  inspectorFromMessage,
  inspectorFromSocialStep,
  readSocialCommitStatus
} from "../appInspectors";
import type { InspectorItem, ProjectedMatchArtifact } from "../appShared";
import type { SetActionStatus } from "./useCockpitStatus";

// Stable fallbacks: without them every render of an artifact-less cockpit
// produces fresh `[]` identities, defeating React.memo on the workspaces.
const EMPTY_AGENTS: AgentHarnessState[] = [];
const EMPTY_MESSAGES: SocialMessage[] = [];
const EMPTY_METRICS: HarnessMetricRecord[] = [];
const EMPTY_WARNINGS: HarnessEvaluationWarning[] = [];

/**
 * Evidence cursors over the loaded artifact: the selected native step, the
 * selected agent and click-to-inspect handlers for steps, agents and social
 * messages.
 */
export function useEvidenceSelection({
  artifact,
  selectedStepIndex,
  setSelectedStepIndex,
  selectedAgentId,
  setSelectedAgentId,
  revealInspector,
  setActionStatus
}: {
  artifact: ProjectedMatchArtifact | null;
  selectedStepIndex: number;
  setSelectedStepIndex: Dispatch<SetStateAction<number>>;
  selectedAgentId: string;
  setSelectedAgentId: Dispatch<SetStateAction<string>>;
  revealInspector: (nextInspector: InspectorItem) => void;
  setActionStatus: SetActionStatus;
}) {
  const selectedStep = artifact?.socialEpisode?.steps?.[selectedStepIndex] ?? null;
  const agents = artifact?.agents ?? EMPTY_AGENTS;
  const selectedAgent = selectedAgentId ? agents.find((agent) => agent.playerId === selectedAgentId) ?? null : agents[0] ?? null;
  const messages = artifact?.socialEpisode?.messages ?? EMPTY_MESSAGES;
  const metrics = artifact?.evaluationReport?.metrics ?? EMPTY_METRICS;
  const warnings = artifact?.evaluationReport?.warnings ?? EMPTY_WARNINGS;

  const handleSelectStep = useCallback(
    (index: number) => {
      const step = artifact?.socialEpisode.steps[index];
      setSelectedStepIndex(index);
      if (step) {
        revealInspector(inspectorFromSocialStep(step, index));
        setActionStatus(
          `已选择 native step：#${index + 1} · ${step.actorId} · ${readSocialCommitStatus(step)}`
        );
      }
    },
    [artifact?.socialEpisode.steps, revealInspector, setActionStatus]
  );

  const handleSelectAgent = useCallback(
    (agent: AgentHarnessState) => {
      setSelectedAgentId(agent.playerId);
      revealInspector(inspectorFromAgent(agent));
      setActionStatus(`已选择 agent：${agent.playerId}`);
    },
    [revealInspector, setActionStatus]
  );

  const handleSelectMessage = useCallback(
    (message: SocialMessage) => {
      revealInspector(inspectorFromMessage(message));
      setActionStatus(`已选择社会消息：#${message.seq} · ${message.senderId}`);
    },
    [revealInspector, setActionStatus]
  );

  return {
    selectedStep,
    agents,
    selectedAgent,
    messages,
    metrics,
    warnings,
    handleSelectStep,
    handleSelectAgent,
    handleSelectMessage
  };
}
