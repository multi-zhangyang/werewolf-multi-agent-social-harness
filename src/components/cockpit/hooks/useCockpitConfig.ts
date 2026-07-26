import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import { apiJson } from "../appInspectors";
import type { ArtifactView, ConfigResponse } from "../appShared";
import { createCockpitExperimentDraft, type CockpitExperimentDraft } from "../experimentDraft";

/**
 * Owns the `/api/config` handshake: capability flags, model roster and the
 * selected default model. `loadConfig` also hydrates the initial experiment
 * draft placeholder and downgrades the artifact view when the connection has
 * no local research projection capability.
 */
export function useCockpitConfig({
  artifactView,
  setArtifactView,
  setExperimentDraft
}: {
  artifactView: ArtifactView;
  setArtifactView: Dispatch<SetStateAction<ArtifactView>>;
  setExperimentDraft: Dispatch<SetStateAction<CockpitExperimentDraft>>;
}) {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [selectedModel, setSelectedModel] = useState("");

  const models = useMemo(() => config?.models ?? config?.provider?.models ?? [], [config]);
  const operatorRegistryEnabled = config?.capabilities?.operatorRegistry === true;
  const canUsePostgameArtifact = config?.capabilities?.postgameArtifact === true;
  const canUsePostgameReplay = config?.capabilities?.postgameReplay === true;
  const canExportMatchArtifacts = config?.capabilities?.artifactExport?.match === true;
  const canUseCheckpointControls =
    artifactView === "postgame-redacted" &&
    config?.capabilities?.operatorRegistry === true &&
    config.capabilities.checkpointCreate === true &&
    config.capabilities.checkpointFork === true;

  const loadConfig = useCallback(async () => {
    const nextConfig = await apiJson<ConfigResponse>("/api/config");
    setConfig(nextConfig);
    if (nextConfig.capabilities?.postgameArtifact !== true) {
      setArtifactView((current) => current === "postgame-redacted" ? "truth-redacted" : current);
    }
    const nextModels = nextConfig.models ?? nextConfig.provider?.models ?? [];
    setSelectedModel((current) => {
      if (current && (!nextModels.length || nextModels.includes(current))) return current;
      const profileModel = nextConfig.defaultProfiles?.find((profile) => profile.model && (!nextModels.length || nextModels.includes(profile.model)))?.model;
      return profileModel ?? nextModels[0] ?? current;
    });
    setExperimentDraft((current) => {
      // Preserve an operator's in-progress heterogeneous roster. The initial
      // empty placeholder is the only case that gets hydrated from config.
      const isInitialPlaceholder =
        current.profiles.length === 1 &&
        current.profiles[0]?.id === "research-agent-1" &&
        !current.profiles[0]?.model.trim() &&
        current.profiles[0]?.temperature === 0.7 &&
        current.assignment.strategy === "profile-rotation";
      if (!isInitialPlaceholder) return current;
      return createCockpitExperimentDraft({
        defaultProfiles: nextConfig.defaultProfiles,
        models: nextModels,
        selectedModel: nextConfig.defaultProfiles?.[0]?.model ?? nextModels[0]
      });
    });
    return nextConfig;
  }, []);

  return {
    config,
    models,
    selectedModel,
    operatorRegistryEnabled,
    canUsePostgameArtifact,
    canUsePostgameReplay,
    canExportMatchArtifacts,
    canUseCheckpointControls,
    loadConfig
  };
}
