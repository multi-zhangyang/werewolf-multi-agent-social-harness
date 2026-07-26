import type {
  MatchComparisonArtifact,
  MatchComparisonEvidenceIdentityFilter,
  MatchComparisonNumericDeltaFilter,
  MatchComparisonPromotionFilter,
  MatchComparisonRowFilter,
  MatchComparisonRowGroup,
  MatchComparisonView
} from "../harness/matchComparison";
import { HttpError, optionalSingleQueryString } from "./httpValidation";
import { isRecord } from "./jsonUtil";

/**
 * The comparison registry is a discoverable API surface. Safe projections can
 * be listed together because truth-redacted is strictly narrower than the
 * default postgame-redacted research view; full/debug records require an
 * explicit view=full request and are never newly persisted by this server.
 */
export function comparisonIsVisibleInRegistry(comparison: MatchComparisonArtifact, requestedView: MatchComparisonView): boolean {
  if (requestedView === "full") return true;
  if (comparison.view === "full") return false;
  if (requestedView === "truth-redacted") return comparison.view === "truth-redacted";
  return true;
}

export function downloadRequested(query: unknown): boolean {
  const record = isRecord(query) ? query : {};
  const raw = optionalSingleQueryString(record, "download");
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "download";
}

export function comparisonFormatFromQuery(query: unknown): "json" | "markdown" {
  const record = isRecord(query) ? query : {};
  const raw = optionalSingleQueryString(record, "format");
  if (raw === undefined || raw === "json") return "json";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "markdown" || normalized === "md") return "markdown";
  throw new HttpError(400, 'format must be "json" or "markdown"');
}

export function filteredComparisonRequested(
  query: unknown,
  filter: Required<MatchComparisonRowFilter>
): boolean {
  const record = isRecord(query) ? query : {};
  const raw = optionalSingleQueryString(record, "filtered");
  if (raw !== undefined) {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "filtered") {
      return true;
    }
    if (normalized === "0" || normalized === "false" || normalized === "no") {
      return false;
    }
    throw new HttpError(400, 'filtered must be "1", "true", "yes", "0", "false", or "no"');
  }
  return (
    filter.group !== "all" ||
    filter.changedOnly ||
    filter.promotion !== "all" ||
    filter.evidenceIdentity !== "all" ||
    filter.numericDelta !== "all"
  );
}

export function comparisonRowFilterFromQuery(query: unknown): Required<MatchComparisonRowFilter> {
  const record = isRecord(query) ? query : {};
  return {
    group: comparisonGroupFilterFromQuery(record),
    changedOnly: comparisonChangedOnlyFromQuery(record),
    promotion: comparisonPromotionFilterFromQuery(record),
    evidenceIdentity: comparisonEvidenceIdentityFilterFromQuery(record),
    numericDelta: comparisonNumericDeltaFilterFromQuery(record)
  };
}

export function comparisonGroupFilterFromQuery(
  query: Record<string, unknown>
): "all" | MatchComparisonRowGroup {
  const raw = optionalSingleQueryString(query, "group");
  if (raw === undefined || raw === "all") return "all";
  if (raw === "summary" || raw === "metric" || raw === "metric_evidence") return raw;
  throw new HttpError(400, 'group must be "all", "summary", "metric", or "metric_evidence"');
}

export function comparisonChangedOnlyFromQuery(query: Record<string, unknown>): boolean {
  const raw = optionalSingleQueryString(query, "changedOnly");
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  throw new HttpError(400, 'changedOnly must be "1", "true", "yes", "0", "false", or "no"');
}

export function comparisonPromotionFilterFromQuery(
  query: Record<string, unknown>
): MatchComparisonPromotionFilter {
  const raw = optionalSingleQueryString(query, "promotion");
  if (raw === undefined || raw === "all") return "all";
  if (
    raw === "changed" ||
    raw === "scorecard" ||
    raw === "diagnostic" ||
    raw === "benchmark_only" ||
    raw === "missing"
  ) {
    return raw;
  }
  throw new HttpError(
    400,
    'promotion must be "all", "changed", "scorecard", "diagnostic", "benchmark_only", or "missing"'
  );
}

export function comparisonEvidenceIdentityFilterFromQuery(
  query: Record<string, unknown>
): MatchComparisonEvidenceIdentityFilter {
  const raw = optionalSingleQueryString(query, "evidenceIdentity");
  if (raw === undefined || raw === "all") return "all";
  if (raw === "changed") return raw;
  throw new HttpError(400, 'evidenceIdentity must be "all" or "changed"');
}

export function comparisonNumericDeltaFilterFromQuery(
  query: Record<string, unknown>
): MatchComparisonNumericDeltaFilter {
  const raw = optionalSingleQueryString(query, "numericDelta");
  if (raw === undefined || raw === "all") return "all";
  if (raw === "changed") return raw;
  throw new HttpError(400, 'numericDelta must be "all" or "changed"');
}
