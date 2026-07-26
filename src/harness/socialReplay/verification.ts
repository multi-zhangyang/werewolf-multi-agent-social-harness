import { replaySocialEpisode } from "./replayEngine";
import { type SocialEnvironment } from "../social";
import { committedActorSnapshotBoundaryErrors } from "./support";
import { compareSocialDomainAdapterManifests, type SocialDomainAdapterManifest, validateSocialDomainAdapterManifest } from "../domainAdapter";
import { type HarnessEpisodeArtifactVerificationResult, type SocialArtifactVerificationRuntime, type SocialRecordedAgentStateValidator } from "./contracts";
import { type HarnessEpisodeArtifactEnvelope, validateHarnessEpisodeArtifactEnvelope } from "../episodeArtifacts";
/**
 * Strong, model-free acceptance boundary for a canonical generic episode
 * artifact. Structural validation remains separately available for parsers and
 * migrations, but persistence/fork/evaluation authorities should use this
 * verifier before accepting a domain artifact as replayable truth.
 */
export function verifyHarnessEpisodeArtifact<
  TState,
  TObservation,
  TPending,
  TCommand,
  TAgentState,
  TForkProvenance extends import("../episodeArtifacts").GenericForkProvenance | undefined
>(options: {
  artifact: HarnessEpisodeArtifactEnvelope<TState, TObservation, TPending, TCommand, TAgentState, TForkProvenance>;
  runtime: SocialArtifactVerificationRuntime<TState, TObservation, TPending, TCommand, TAgentState>;
}): HarnessEpisodeArtifactVerificationResult<TState> {
  const structureErrors = validateHarnessEpisodeArtifactEnvelope(options.artifact);
  const configurationErrors: string[] = [];
  const runtimeRecord = options.runtime && typeof options.runtime === "object"
    ? options.runtime as unknown as Record<string, unknown>
    : {};
  const policyRecord = runtimeRecord.recordedAgentState && typeof runtimeRecord.recordedAgentState === "object"
    ? runtimeRecord.recordedAgentState as Record<string, unknown>
    : undefined;
  const validationMode = policyRecord?.mode === "validate" || policyRecord?.mode === "none"
    ? policyRecord.mode
    : "invalid";
  for (const field of ["createEnvironment", "hashState", "hashMessages", "validateRecordedStep"] as const) {
    if (typeof runtimeRecord[field] !== "function") {
      configurationErrors.push(`${field} must be a function.`);
    }
  }
  if (runtimeRecord.eventSeq !== undefined && typeof runtimeRecord.eventSeq !== "function") {
    configurationErrors.push("eventSeq must be a function when provided.");
  }
  if (!policyRecord || validationMode === "invalid") {
    configurationErrors.push("recordedAgentState must declare mode=validate or mode=none.");
  } else if (validationMode === "validate" && typeof policyRecord.validator !== "function") {
    configurationErrors.push("recordedAgentState.validator must be a function in validate mode.");
  }
  if (!options.artifact.socialEpisode.domainAdapter) {
    configurationErrors.push("artifact socialEpisode.domainAdapter is required for canonical verification.");
  }
  configurationErrors.push(
    ...validateSocialDomainAdapterManifest(runtimeRecord.domainAdapter, "verification runtime adapter")
  );
  for (const mismatch of compareSocialDomainAdapterManifests(
    options.artifact.socialEpisode.domainAdapter,
    runtimeRecord.domainAdapter as SocialDomainAdapterManifest | undefined,
    { recordedPath: "artifact domain adapter", runtimePath: "verification runtime adapter" }
  )) {
    configurationErrors.push(`domain adapter binding: ${mismatch}`);
  }
  const hasRecordedAgentState =
    options.artifact.agents.length > 0 ||
    Boolean(options.artifact.agentSnapshotFrames?.length) ||
    options.artifact.socialEpisode.steps.some(
      (step) =>
        step.actorSnapshotsAfterStep !== undefined ||
        step.actorSnapshotsHashAfterStep !== undefined ||
        step.actorSnapshotFrameIdAfterStep !== undefined
    );
  if (validationMode === "none" && policyRecord) {
    if (typeof policyRecord.reason !== "string" || !policyRecord.reason.trim()) {
      configurationErrors.push("recordedAgentState.mode=none requires a nonempty reason.");
    }
    if (hasRecordedAgentState) {
      configurationErrors.push(
        "recordedAgentState.mode=none is not allowed because the artifact records durable actor state."
      );
    }
  }
  if (validationMode === "validate") {
    structureErrors.push(...committedActorSnapshotBoundaryErrors(options.artifact));
  }
  if (structureErrors.length || configurationErrors.length) {
    return {
      ok: false,
      validationMode,
      structureErrors,
      configurationErrors,
      mismatches: [
        ...structureErrors.map((error) => `Artifact structure: ${error}`),
        ...configurationErrors.map((error) => `Artifact verification configuration: ${error}`)
      ]
    };
  }

  let environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
  try {
    environment = options.runtime.createEnvironment(structuredClone(options.artifact.initialState));
  } catch {
    const message = "Artifact verification environment factory failed.";
    return {
      ok: false,
      validationMode,
      structureErrors,
      configurationErrors: [message],
      mismatches: [`Artifact verification configuration: ${message}`]
    };
  }
  const replay = replaySocialEpisode<TState, TObservation, TPending, TCommand, TAgentState>({
    episode: structuredClone(options.artifact.socialEpisode),
    environment,
    hashState: options.runtime.hashState,
    hashMessages: options.runtime.hashMessages,
    eventSeq: options.runtime.eventSeq,
    agentSnapshotFrames: options.artifact.agentSnapshotFrames
      ? structuredClone(options.artifact.agentSnapshotFrames)
      : undefined,
    validateRecordedStep: options.runtime.validateRecordedStep,
    validateRecordedAgentState:
      validationMode === "validate"
        ? (policyRecord!.validator as SocialRecordedAgentStateValidator<TState, TObservation, TPending, TCommand, TAgentState>)
        : undefined,
    domainAdapter: options.runtime.domainAdapter
  });
  return {
    ok: replay.ok,
    validationMode,
    structureErrors,
    configurationErrors,
    replay,
    mismatches: [...replay.mismatches]
  };
}
