import express from "express";
import { providerConfigSummaryFromEnv, providerDiagnosticSummaryFromEnv } from "../../agents/providerRegistry";
import { DEFAULT_CONFIG } from "../../core/roles";
import { POLICY_NAMES, profilesFromModels } from "../../harness/profiles";
import { hasLocalResearchArtifactAccess } from "../artifactAccess";
import type { ServerContext } from "../context";

export function registerSystemRoutes(app: express.Express, context: ServerContext): void {
const { artifactAccessBindHost, tournamentArtifactBaseDir, matrixArtifactBaseDir, checkpointArtifactBaseDir, matchArtifactBaseDir } = context;

app.get("/api/health", (_req, res) => {
  const provider = providerConfigSummaryFromEnv();
  res.json({
    ok: true,
    service: "werewolf-multi-agent-arena",
    provider: providerDiagnosticSummaryFromEnv(),
    models: provider.models
  });
});

app.get("/api/config", (req, res) => {
  const provider = providerConfigSummaryFromEnv();
  const localResearchAccess = hasLocalResearchArtifactAccess(req, artifactAccessBindHost);
  res.json({
    defaultConfig: DEFAULT_CONFIG,
    models: provider.models,
    policyNames: POLICY_NAMES,
    defaultProfiles: profilesFromModels(provider.models, Number(process.env.AGENT_TEMPERATURE ?? 0.7)),
    provider: providerDiagnosticSummaryFromEnv(),
    artifactExport: {
      tournamentConfigured: Boolean(tournamentArtifactBaseDir),
      matrixConfigured: Boolean(matrixArtifactBaseDir),
      checkpointConfigured: Boolean(checkpointArtifactBaseDir),
      matchConfigured: Boolean(matchArtifactBaseDir)
    },
    capabilities: {
      operatorRegistry: localResearchAccess,
      postgameArtifact: localResearchAccess,
      postgameReplay: localResearchAccess,
      checkpointCreate: localResearchAccess,
      checkpointFork: localResearchAccess,
      artifactExport: {
        // Match artifacts can be downloaded from the canonical in-process
        // registry even when an optional disk export directory is absent.
        match: localResearchAccess,
        tournament: localResearchAccess && Boolean(tournamentArtifactBaseDir),
        matrix: localResearchAccess && Boolean(matrixArtifactBaseDir)
      }
    }
  });
});
}
