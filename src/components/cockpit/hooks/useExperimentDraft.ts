import { useMemo, useState } from "react";

import { DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER } from "../../../harness/types";
import {
  buildCockpitExperimentRequest,
  createCockpitExperimentDraft,
  type CockpitExperimentDraft
} from "../experimentDraft";
import { DEFAULT_MAX_TRANSITIONS, DEFAULT_TIMEOUT_SECONDS } from "../appShared";

/**
 * Owns the experiment orchestration draft plus the shared run limits
 * (maxTransitions / timeout / joint phase scheduler) and the roster composer
 * drawer flag.
 */
export function useExperimentDraft() {
  // This is only a request draft for the existing experiment control plane.
  // It must never become a browser-side source of resolved role/seat truth.
  const [experimentDraft, setExperimentDraft] = useState<CockpitExperimentDraft>(() => createCockpitExperimentDraft());
  const [rosterComposerOpen, setRosterComposerOpen] = useState(false);
  const [maxTransitions, setMaxTransitions] = useState(DEFAULT_MAX_TRANSITIONS);
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(DEFAULT_TIMEOUT_SECONDS));
  const [jointPhaseScheduler, setJointPhaseScheduler] = useState<"aec-batched-decision" | "parallel">(DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER);

  const experimentRequest = useMemo(() => buildCockpitExperimentRequest(experimentDraft), [experimentDraft]);

  return {
    experimentDraft,
    setExperimentDraft,
    rosterComposerOpen,
    setRosterComposerOpen,
    maxTransitions,
    setMaxTransitions,
    timeoutSeconds,
    setTimeoutSeconds,
    jointPhaseScheduler,
    setJointPhaseScheduler,
    experimentRequest
  };
}
