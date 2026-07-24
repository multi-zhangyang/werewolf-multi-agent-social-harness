import type { PostgameMatchProjectionDto, SocialNetworkProjectionDto } from "../../server/artifactProjection";

export function assertServerProjectedArtifactContract(artifact: PostgameMatchProjectionDto, label: string): void {
  const view = artifact.projection?.view;
  if (
    (view !== "postgame-redacted" && view !== "truth-redacted") ||
    artifact.projection.privateEvidenceRedacted !== true
  ) {
    throw new Error(`${label} must be a postgame-redacted or truth-redacted projection.`);
  }
  if (view === "truth-redacted" && artifact.projection.postgameTruthRedacted !== true) {
    throw new Error(`${label} truth-redacted projection must set postgameTruthRedacted=true.`);
  }
  if (view === "postgame-redacted" && artifact.projection.postgameTruthRedacted === true) {
    throw new Error(`${label} postgame-redacted projection must keep postgame truth.`);
  }
  if (
    artifact.socialEpisode.exposureSummary?.schemaVersion !== "server.social-exposure-summary.v1" ||
    artifact.socialEpisode.exposureSummary.privateEvidenceRedacted !== true ||
    artifact.socialEpisode.exposureSummary.source !== "scoped_observation"
  ) {
    throw new Error(`${label} must include a redacted server social exposure summary.`);
  }
  assertSocialNetworkProjection(artifact.socialNetwork, view, label);
}

function assertSocialNetworkProjection(
  network: SocialNetworkProjectionDto,
  view: "postgame-redacted" | "truth-redacted",
  label: string
): void {
  if (
    !network ||
    network.artifactVersion !== "server.social-network-projection.v1" ||
    network.kind !== "social-network-projection" ||
    network.authority !== "server-owned-match-artifact" ||
    network.scope !== "final-agent-snapshot" ||
    network.projection?.view !== view
  ) {
    throw new Error(`${label} must include a matching server-owned social-network projection.`);
  }
  if (
    !Array.isArray(network.nodes) ||
    !Array.isArray(network.relationshipEdges) ||
    !Array.isArray(network.communicationEdges) ||
    !Array.isArray(network.exposureEdges)
  ) {
    throw new Error(`${label} social-network collections are malformed.`);
  }
  const modes = network.modes;
  if (
    !isMode(modes?.relationships) ||
    !isMode(modes?.communication) ||
    !isMode(modes?.exposure)
  ) {
    throw new Error(`${label} social-network modes are malformed.`);
  }
  const nodeIds = new Set<string>();
  for (const node of network.nodes) {
    if (!node || typeof node.id !== "string" || !node.id || nodeIds.has(node.id)) {
      throw new Error(`${label} social-network nodes contain an invalid or duplicate id.`);
    }
    for (const count of [
      node.sentMessageCount,
      node.deliveryCount,
      node.receivedMessageCount,
      node.observedMessageCount,
      node.observationCount,
      node.relationshipCount
    ]) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(`${label} social-network node counts must be non-negative integers.`);
      }
    }
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of network.relationshipEdges) {
    if (
      !claimEdgeId(edgeIds, edge?.id) ||
      !nodeIds.has(edge.sourceId) ||
      !nodeIds.has(edge.targetId) ||
      !Array.isArray(edge.evidenceRefs) ||
      typeof edge.updatedAt !== "string"
    ) {
      throw new Error(`${label} social-network relationship edge references an unknown node.`);
    }
    for (const value of [edge.trust, edge.suspicion, edge.affinity, edge.influence, edge.debt, edge.respect, edge.threat]) {
      if (!Number.isFinite(value) || value < -1 || value > 1) {
        throw new Error(`${label} social-network relationship dimensions must be finite signed scores.`);
      }
    }
  }
  for (const edge of network.communicationEdges) {
    if (
      !claimEdgeId(edgeIds, edge?.id) ||
      !nodeIds.has(edge.sourceId) ||
      !nodeIds.has(edge.targetId) ||
      typeof edge.channelId !== "string" ||
      !edge.channelId ||
      !isVisibility(edge.visibility) ||
      !isCount(edge.messageCount) ||
      !isUniqueSafeIntegerArray(edge.messageSeqs) ||
      edge.messageCount !== edge.messageSeqs.length
    ) {
      throw new Error(`${label} social-network communication edge is malformed.`);
    }
  }
  for (const edge of network.exposureEdges) {
    if (
      !claimEdgeId(edgeIds, edge?.id) ||
      !nodeIds.has(edge.sourceId) ||
      !nodeIds.has(edge.targetId) ||
      typeof edge.channelId !== "string" ||
      !edge.channelId ||
      !isVisibility(edge.visibility) ||
      !isCount(edge.uniqueMessageCount) ||
      !isCount(edge.observationCount) ||
      !isCount(edge.evidenceCount) ||
      !Array.isArray(edge.messageRefs) ||
      edge.messageRefs.some((ref) => !ref || typeof ref.id !== "string" || !ref.id || !isCount(ref.seq)) ||
      edge.uniqueMessageCount !== edge.messageRefs.length ||
      !Array.isArray(edge.actionKinds) ||
      !Array.isArray(edge.traceIds) ||
      !isUniqueSafeIntegerArray(edge.turnIndexes)
    ) {
      throw new Error(`${label} social-network exposure edge is malformed.`);
    }
  }
  if (
    modes.relationships.recordCount !== network.relationshipEdges.length ||
    modes.communication.recordCount !== network.communicationEdges.length ||
    modes.exposure.recordCount !== network.exposureEdges.length
  ) {
    throw new Error(`${label} social-network mode counts do not match projected edges.`);
  }
  if (
    view === "truth-redacted" &&
    (modes.relationships.available ||
      modes.communication.available ||
      modes.exposure.available ||
      network.relationshipEdges.length > 0 ||
      network.communicationEdges.length > 0 ||
      network.exposureEdges.length > 0 ||
      network.nodes.some((node) => node.profileId !== undefined || node.policyName !== undefined || node.relationshipCount !== 0))
  ) {
    throw new Error(`${label} truth-redacted social-network projection exposed private social evidence.`);
  }
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isMode(value: unknown): value is SocialNetworkProjectionDto["modes"]["relationships"] {
  if (!value || typeof value !== "object") return false;
  const mode = value as Record<string, unknown>;
  return typeof mode.available === "boolean" && isCount(mode.recordCount) && (mode.reason === undefined || typeof mode.reason === "string");
}

function isVisibility(value: unknown): value is "public" | "team" | "private" | "postgame" {
  return value === "public" || value === "team" || value === "private" || value === "postgame";
}

function claimEdgeId(ids: Set<string>, value: unknown): value is string {
  if (typeof value !== "string" || !value || ids.has(value)) return false;
  ids.add(value);
  return true;
}

function isUniqueSafeIntegerArray(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.some((item) => !isCount(item))) return false;
  return new Set(value).size === value.length;
}
