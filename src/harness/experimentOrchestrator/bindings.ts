import { compareSocialDomainAdapterManifests } from "../domainAdapter";
import {
  createGenericExperimentExecutionAttestation,
  validateGenericExperimentExecutionAttestation,
  validateGenericExperimentExecutionEvidence,
  validateGenericExperimentProvenance,
  type GenericExperimentProvenanceV1,
  type NormalizedGenericExperimentSpecV1
} from "../experimentSpec";
import type { HarnessEvaluationContext, HarnessEvaluator } from "../evaluation";
import { hashStableJsonValue, hashStableState } from "../hash";
import { validateSocialEpisodeArtifact } from "../social";
import type { TournamentEpisodeContext, TournamentEpisodeLifecycle } from "../tournamentRunner";
import type { HarnessEvaluationReport } from "../types";
import type {
  GenericEpisodeEnvelope,
  GenericExperimentAttemptErrorClassification,
  GenericExperimentEpisodeContext,
  GenericExperimentExecutionAdapter
} from "./types";

export function resolveEvaluators<
  TState,
  TMetrics,
  TSocialEpisode,
  TAgent,
  TTrajectory
>(
  spec: NormalizedGenericExperimentSpecV1,
  available: Array<HarnessEvaluator<TState, TMetrics, TSocialEpisode, unknown, TAgent, TTrajectory>>
): Array<HarnessEvaluator<TState, TMetrics, TSocialEpisode, unknown, TAgent, TTrajectory>> {
  const byId = new Map<string, HarnessEvaluator<TState, TMetrics, TSocialEpisode, unknown, TAgent, TTrajectory>>();
  for (const evaluator of available) {
    if (byId.has(evaluator.id)) throw new Error(`Generic experiment evaluator registry contains duplicate id ${evaluator.id}.`);
    byId.set(evaluator.id, evaluator);
  }
  const missing = spec.evaluatorIds.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`Generic experiment evaluator registry is missing: ${missing.join(", ")}.`);
  return spec.evaluatorIds.map((id) => byId.get(id)!);
}

export function assertArtifactBinding(
  artifact: GenericEpisodeEnvelope,
  spec: NormalizedGenericExperimentSpecV1,
  status: TournamentEpisodeLifecycle,
  context: TournamentEpisodeContext
): void {
  if (!artifact || typeof artifact !== "object") throw new Error("Generic experiment adapter did not return an episode artifact.");
  if (artifact.status !== status || artifact.socialEpisode.status !== status) {
    throw new Error(`Generic experiment episode ${context.index} lifecycle does not match its canonical artifact.`);
  }
  if (artifact.socialEpisode.domainId !== spec.domainId) {
    throw new Error(`Generic experiment episode ${context.index} artifact domainId does not match the normalized spec.`);
  }
  if (artifact.socialEpisode.schedulerMode !== spec.schedulerMode) {
    throw new Error(`Generic experiment episode ${context.index} scheduler does not match the normalized spec.`);
  }
  const socialStructureErrors = validateSocialEpisodeArtifact(artifact.socialEpisode);
  if (socialStructureErrors.length) {
    throw new Error(
      `Generic experiment episode ${context.index} social artifact structure failed: ${socialStructureErrors.join(" ")}`
    );
  }
  if (
    !artifact.socialEpisode.runtimeActorIds ||
    artifact.socialEpisode.runtimeActorIds.length !== spec.actorCount
  ) {
    throw new Error(`Generic experiment episode ${context.index} runtime actor count does not match the normalized spec.`);
  }
  const executionEvidenceErrors = validateGenericExperimentExecutionEvidence(
    spec,
    artifact.socialEpisode,
    `episode ${context.index} socialEpisode`
  );
  if (executionEvidenceErrors.length) {
    throw new Error(`Generic experiment episode ${context.index} execution binding failed: ${executionEvidenceErrors.join(" ")}`);
  }
  if (!artifact.executionAttestation) {
    throw new Error(`Generic experiment episode ${context.index} is missing its execution attestation.`);
  }
  const attestationErrors = validateGenericExperimentExecutionAttestation(
    artifact.executionAttestation,
    spec,
    artifact.socialEpisode,
    `episode ${context.index} executionAttestation`
  );
  if (attestationErrors.length) {
    throw new Error(`Generic experiment episode ${context.index} execution attestation failed: ${attestationErrors.join(" ")}`);
  }
  const adapterErrors = compareSocialDomainAdapterManifests(
    spec.domainAdapter,
    artifact.socialEpisode.domainAdapter,
    { recordedPath: "normalized experiment adapter", runtimePath: "episode artifact adapter" }
  );
  if (adapterErrors.length) {
    throw new Error(`Generic experiment episode ${context.index} adapter binding failed: ${adapterErrors.join(" ")}`);
  }
}

/**
 * Adapters build domain artifacts; the control plane owns experiment identity.
 * A legacy-style unbound artifact is copied and bound here. An adapter that
 * already supplied provenance must match exactly, so this never overwrites a
 * contradictory claim.
 */
export function bindArtifactToExperiment<TArtifact extends GenericEpisodeEnvelope>(
  artifact: TArtifact,
  experiment: GenericExperimentProvenanceV1,
  context: TournamentEpisodeContext,
  assignmentResolution: import("../social").SocialAssignmentResolutionEvidence | undefined
): TArtifact {
  if (!artifact || typeof artifact !== "object") {
    throw new Error("Generic experiment adapter did not return an episode artifact.");
  }
  const canonical = structuredClone(artifact);
  if (
    assignmentResolution !== undefined &&
    canonical.socialEpisode.assignmentResolution !== undefined &&
    hashStableJsonValue(canonical.socialEpisode.assignmentResolution) !== hashStableJsonValue(assignmentResolution)
  ) {
    throw new Error(`Generic experiment episode ${context.index} assignment resolution contradicts control-plane evidence.`);
  }
  if (assignmentResolution !== undefined) {
    canonical.socialEpisode.assignmentResolution = structuredClone(assignmentResolution);
  } else if (canonical.socialEpisode.assignmentResolution !== undefined) {
    throw new Error(
      `Generic experiment episode ${context.index} supplied assignment resolution without a reviewed adapter resolution hook.`
    );
  }
  let bound: TArtifact;
  if (canonical.experiment !== undefined) {
    const errors = validateGenericExperimentProvenance(
      canonical.experiment,
      `episode ${context.index} artifact.experiment`
    );
    if (errors.length) {
      throw new Error(`Generic experiment episode ${context.index} provenance is invalid: ${errors.join(" ")}`);
    }
    if (hashStableJsonValue(canonical.experiment) !== hashStableJsonValue(experiment)) {
      throw new Error(`Generic experiment episode ${context.index} provenance does not match the normalized spec.`);
    }
    bound = canonical;
  } else {
    bound = {
      ...canonical,
      experiment: structuredClone(experiment)
    };
  }
  const executionAttestation = createGenericExperimentExecutionAttestation(
    experiment.spec,
    bound.socialEpisode,
    { assignmentResolutionRequired: experiment.assignmentResolutionRequired === true }
  );
  if (
    bound.executionAttestation !== undefined &&
    hashStableJsonValue(bound.executionAttestation) !== hashStableJsonValue(executionAttestation)
  ) {
    throw new Error(`Generic experiment episode ${context.index} execution attestation contradicts runner-authored evidence.`);
  }
  return {
    ...bound,
    executionAttestation
  };
}

export function createEpisodeContext(
  context: TournamentEpisodeContext,
  spec: NormalizedGenericExperimentSpecV1,
  experiment: GenericExperimentProvenanceV1,
  abortSignal: AbortSignal
): GenericExperimentEpisodeContext {
  return {
    ...context,
    spec: structuredClone(spec),
    experiment: structuredClone(experiment),
    specHash: experiment.specHash,
    abortSignal
  };
}

export function assertEvaluationContextBinding(
  context: HarnessEvaluationContext<unknown, unknown, unknown, unknown, unknown>,
  artifact: GenericEpisodeEnvelope,
  episode: TournamentEpisodeContext
): void {
  if (context.id !== artifact.runId || context.status !== artifact.status) {
    throw new Error(`Generic experiment episode ${episode.index} evaluation identity does not match its artifact.`);
  }
  if (
    hashStableState(context.initialState) !== hashStableState(artifact.initialState) ||
    hashStableState(context.finalState) !== hashStableState(artifact.finalState)
  ) {
    throw new Error(`Generic experiment episode ${episode.index} evaluation state does not match its artifact.`);
  }
  if (!Array.isArray(context.agents) || hashStableState(context.agents) !== hashStableState(artifact.agents)) {
    throw new Error(`Generic experiment episode ${episode.index} evaluation agents do not match its artifact.`);
  }
  if (
    context.socialEpisode !== undefined
  ) {
    const contextEpisode = structuredClone(context.socialEpisode) as { assignmentResolution?: unknown };
    const artifactEpisode = structuredClone(artifact.socialEpisode);
    delete contextEpisode.assignmentResolution;
    delete artifactEpisode.assignmentResolution;
    if (hashStableState(contextEpisode) !== hashStableState(artifactEpisode)) {
      throw new Error(`Generic experiment episode ${episode.index} evaluation social episode does not match its artifact.`);
    }
  }
}

export function assertEvaluationReportBinding(
  report: HarnessEvaluationReport,
  evaluatorIds: readonly string[],
  episode: TournamentEpisodeContext,
  evaluators?: readonly { id: string; version: string }[]
): void {
  const registry = report.evaluatorRegistry ?? [];
  if (registry.length !== evaluatorIds.length) {
    throw new Error(`Generic experiment episode ${episode.index} evaluator registry is incomplete.`);
  }
  const registryById = new Map(registry.map((recorded) => [recorded.id, recorded]));
  if (registryById.size !== registry.length) {
    throw new Error(`Generic experiment episode ${episode.index} evaluator registry contains duplicate ids.`);
  }
  const runtimeEvaluatorById = new Map((evaluators ?? []).map((evaluator) => [evaluator.id, evaluator]));
  for (const evaluatorId of evaluatorIds) {
    const recorded = registryById.get(evaluatorId);
    const runtimeEvaluator = runtimeEvaluatorById.get(evaluatorId);
    if (
      !recorded ||
      (runtimeEvaluator !== undefined && recorded.version !== runtimeEvaluator.version)
    ) {
      throw new Error(`Generic experiment episode ${episode.index} evaluator identity does not match its registry.`);
    }
  }
}

export function assertEvaluationAdapter(
  adapter: GenericExperimentExecutionAdapter<unknown, unknown, GenericEpisodeEnvelope>["evaluation"] | undefined,
  spec: NormalizedGenericExperimentSpecV1
): void {
  if (!adapter) {
    if (spec.evaluatorIds.length) {
      throw new Error("Generic experiment evaluator registry is missing for the normalized evaluator set.");
    }
    return;
  }
  const hasPrecomputedReport = typeof adapter.reportForEpisode === "function";
  const hasRuntimeRegistry = Array.isArray(adapter.evaluators) && typeof adapter.contextForEpisode === "function";
  if (hasPrecomputedReport === hasRuntimeRegistry) {
    throw new Error(
      "Generic experiment evaluation adapter must provide exactly one of reportForEpisode or evaluators/contextForEpisode."
    );
  }
}

export function assertAttemptErrorClassification(
  value: GenericExperimentAttemptErrorClassification
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Domain attempt error classifier must return a closed classification record.");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "code" || keys[1] !== "decision") {
    throw new Error("Domain attempt error classifier returned unsupported fields.");
  }
  if (value.decision !== "safe-to-retry" && value.decision !== "terminal") {
    throw new Error("Domain attempt error classifier decision is invalid.");
  }
  if (typeof value.code !== "string" || value.code.length > 96 || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value.code)) {
    throw new Error("Domain attempt error classifier code is not a safe closed machine code.");
  }
}
