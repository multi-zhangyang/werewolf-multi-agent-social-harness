import express from "express";
import type { MatchArtifactView } from "./artifactProjection";
import { HttpError, optionalSingleQueryString } from "./httpValidation";
import { isRecord } from "./jsonUtil";

export function artifactViewFromQuery(
  query: unknown,
  request: express.Request,
  artifactAccessBindHost: string
): MatchArtifactView {
  const record = isRecord(query) ? query : {};
  const view = optionalSingleQueryString(record, "view");
  // `postgame-redacted` is a local research projection: it retains final
  // roles, teams, and night truth while removing private cognition evidence.
  // A remotely reachable default must therefore degrade to the strict public
  // projection rather than silently treating an omitted query as research
  // authorization. Cockpit requests against the default loopback server keep
  // their existing postgame-review default.
  if (view === undefined) {
    return hasLocalResearchArtifactAccess(request, artifactAccessBindHost) ? "postgame-redacted" : "truth-redacted";
  }
  if (view === "full") {
    assertLocalFullArtifactAccess(request, artifactAccessBindHost);
    return "full";
  }
  if (view === "postgame-redacted") {
    assertLocalPostgameArtifactAccess(request, artifactAccessBindHost);
    return "postgame-redacted";
  }
  if (view === "truth-redacted") return "truth-redacted";
  throw new HttpError(400, `Unsupported artifact view: ${view}`);
}

export function checkpointArtifactViewFromQuery(
  query: unknown,
  request: express.Request,
  artifactAccessBindHost: string
): MatchArtifactView {
  const record = isRecord(query) ? query : {};
  if (optionalSingleQueryString(record, "view") === undefined) return "truth-redacted";
  return artifactViewFromQuery(query, request, artifactAccessBindHost);
}

export function assertLocalFullArtifactAccess(request: express.Request, artifactAccessBindHost: string): void {
  if (isLoopbackBindHost(artifactAccessBindHost) && isLoopbackAddress(request.socket.remoteAddress)) return;
  throw new HttpError(
    403,
    "Full artifact view is available only through a loopback-only local debug server.",
    "full_artifact_view_local_only"
  );
}

export function assertLocalResearchArtifactAccess(request: express.Request, artifactAccessBindHost: string): void {
  if (hasLocalResearchArtifactAccess(request, artifactAccessBindHost)) return;
  throw new HttpError(
    403,
    "Tournament research artifacts are available only through a loopback-only local debug server.",
    "tournament_research_artifacts_local_only"
  );
}

/**
 * `/api/matches` is the local research operator registry. Its summaries
 * intentionally include model/profile and execution-progress metadata, so a
 * remotely reachable spectator must use the strict `/live` route instead.
 */
export function assertLocalOperatorRegistryAccess(request: express.Request, artifactAccessBindHost: string): void {
  if (hasLocalResearchArtifactAccess(request, artifactAccessBindHost)) return;
  throw new HttpError(
    403,
    "Match registry access is available only through a loopback-only local operator server.",
    "operator_match_registry_local_only"
  );
}

export function hasLocalResearchArtifactAccess(request: express.Request, artifactAccessBindHost: string): boolean {
  return isLoopbackBindHost(artifactAccessBindHost) && isLoopbackAddress(request.socket.remoteAddress);
}

export function assertLocalPostgameArtifactAccess(request: express.Request, artifactAccessBindHost: string): void {
  if (hasLocalResearchArtifactAccess(request, artifactAccessBindHost)) return;
  throw new HttpError(
    403,
    "Postgame-redacted artifact views are available only through a loopback-only local research server.",
    "postgame_artifact_view_local_only"
  );
}

/**
 * Native replay is more sensitive than a truth-redacted match projection:
 * exact scheduler progress, batch density, and deterministic hashes can leak
 * hidden role/action cadence. Keep both replay endpoints local even when the
 * normal match list and truth-redacted artifact APIs are externally served.
 */
export function assertLocalPostgameReplayAccess(request: express.Request, artifactAccessBindHost: string): void {
  if (hasLocalResearchArtifactAccess(request, artifactAccessBindHost)) return;
  throw new HttpError(
    403,
    "Native replay review is available only through a loopback-only local research server.",
    "postgame_replay_local_only"
  );
}

export function isLoopbackBindHost(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

export function setArtifactProjectionResponseHeaders(res: express.Response, view: MatchArtifactView): void {
  // Even the redacted research projection may contain postgame truth. Do not
  // leave any artifact projection in browser or intermediary caches.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (view === "full") res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
}
