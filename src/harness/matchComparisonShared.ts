/**
 * Browser-safe pure contracts and projections for comparison artifacts.
 *
 * The server constructs comparison truth in `matchComparison.ts`; this module
 * deliberately contains no artifact hashing, evaluator, filesystem, or Node
 * imports so the Cockpit can use the exact same display and selection rules.
 */

export type MatchComparisonView = "full" | "postgame-redacted" | "truth-redacted";
export type MatchComparisonValue = string | number | boolean | null;
export type MatchComparisonRowGroup = "summary" | "metric" | "metric_evidence";
export type MatchComparisonPromotionClass = "scorecard" | "diagnostic" | "benchmark_only" | "missing";
export type MatchComparisonPromotionChangeField =
  | "class"
  | "eligibility"
  | "reasons"
  | "catalogDecisionId"
  | "policy"
  | "catalog"
  | "resolution";

/**
 * Fixed, redaction-safe provenance from a recorded metric promotion decision.
 * Catalog rationales, evaluator metadata, and free-form evidence descriptions
 * are intentionally not part of a comparison projection.
 */
export interface MatchComparisonPromotionDecisionSnapshot {
  policyId: string;
  policyVersion: string;
  policyHash: string;
  catalogId: string;
  catalogVersion: string;
  catalogHash: string;
  catalogDomainId: string;
  eligibleForScorecard: boolean;
  reasons: string[];
  catalogDecisionId: string | null;
  resolution: "recorded" | "legacy_recomputed";
}

export interface MatchComparisonPromotionDetails {
  baseline: MatchComparisonPromotionDecisionSnapshot | null;
  candidate: MatchComparisonPromotionDecisionSnapshot | null;
  changed: boolean;
  changedFields: MatchComparisonPromotionChangeField[];
}

export interface MatchComparisonRowPromotion {
  baseline: MatchComparisonPromotionClass;
  candidate: MatchComparisonPromotionClass;
  details?: MatchComparisonPromotionDetails;
}
export type MatchComparisonPromotionFilter =
  | "all"
  | "changed"
  | "scorecard"
  | "diagnostic"
  | "benchmark_only"
  | "missing";
export type MatchComparisonEvidenceIdentityFilter = "all" | "changed";
export type MatchComparisonNumericDeltaFilter = "all" | "changed";

export interface MatchComparisonRowFilter {
  group?: "all" | MatchComparisonRowGroup;
  changedOnly?: boolean;
  promotion?: MatchComparisonPromotionFilter;
  evidenceIdentity?: MatchComparisonEvidenceIdentityFilter;
  numericDelta?: MatchComparisonNumericDeltaFilter;
}

export interface MatchComparisonRowFilterCandidate {
  group?: MatchComparisonRowGroup;
  delta?: number;
  changed: boolean;
  promotion?: MatchComparisonRowPromotion;
  evidence?: {
    onlyBaselineIds: string[];
    onlyCandidateIds: string[];
  };
}

export function defaultMatchComparisonRowFilter(): Required<MatchComparisonRowFilter> {
  return {
    group: "all",
    changedOnly: false,
    promotion: "all",
    evidenceIdentity: "all",
    numericDelta: "all"
  };
}

export function normalizeMatchComparisonRowFilter(
  filter: MatchComparisonRowFilter = {}
): Required<MatchComparisonRowFilter> {
  return {
    group: filter.group ?? "all",
    changedOnly: Boolean(filter.changedOnly),
    promotion: filter.promotion ?? "all",
    evidenceIdentity: filter.evidenceIdentity ?? "all",
    numericDelta: filter.numericDelta ?? "all"
  };
}

export function parseMatchComparisonRowFilterFromSearchParams(
  search: string | URLSearchParams
): Required<MatchComparisonRowFilter> {
  const params = toSearchParams(search);
  const defaults = defaultMatchComparisonRowFilter();
  return {
    group: parseGroup(params.get("compareGroup"), defaults.group),
    changedOnly: parseBoolean(params.get("compareChangedOnly"), defaults.changedOnly),
    promotion: parsePromotion(params.get("comparePromotion"), defaults.promotion),
    evidenceIdentity: parseEvidenceIdentity(params.get("compareEvidenceIdentity"), defaults.evidenceIdentity),
    numericDelta: parseNumericDelta(params.get("compareNumericDelta"), defaults.numericDelta)
  };
}

export function applyMatchComparisonRowFilterToSearchParams(
  filter: MatchComparisonRowFilter,
  search: string | URLSearchParams = ""
): URLSearchParams {
  const params = toSearchParams(search);
  const normalized = normalizeMatchComparisonRowFilter(filter);
  setOrDeleteParam(params, "compareGroup", normalized.group === "all" ? null : normalized.group);
  setOrDeleteParam(params, "compareChangedOnly", normalized.changedOnly ? "1" : null);
  setOrDeleteParam(params, "comparePromotion", normalized.promotion === "all" ? null : normalized.promotion);
  setOrDeleteParam(
    params,
    "compareEvidenceIdentity",
    normalized.evidenceIdentity === "all" ? null : normalized.evidenceIdentity
  );
  setOrDeleteParam(params, "compareNumericDelta", normalized.numericDelta === "all" ? null : normalized.numericDelta);
  return params;
}

export type MatchComparisonDeepLinkView = "postgame-redacted" | "truth-redacted";

export function buildMatchComparisonFilterDeepLink(options: {
  origin: string;
  pathname: string;
  hash?: string;
  search?: string;
  filter: MatchComparisonRowFilter;
  workspace?: string;
  baselineId?: string;
  candidateId?: string;
  view?: MatchComparisonDeepLinkView;
}): string {
  const params = applyMatchComparisonRowFilterToSearchParams(options.filter, options.search ?? "");
  setOrDeleteParam(params, "workspace", options.workspace?.trim() || null);
  setOrDeleteParam(params, "compareBaseline", options.baselineId?.trim() || null);
  setOrDeleteParam(params, "compareCandidate", options.candidateId?.trim() || null);
  setOrDeleteParam(
    params,
    "compareView",
    options.view && options.view !== "postgame-redacted" ? options.view : null
  );
  params.delete("tab");
  const query = params.toString();
  return `${options.origin}${options.pathname}${query ? `?${query}` : ""}${options.hash ?? ""}`;
}

export function parseMatchComparisonDeepLinkSelection(
  search: string | URLSearchParams
): { baselineId?: string; candidateId?: string; view?: MatchComparisonDeepLinkView } {
  const raw =
    typeof search === "string"
      ? search.includes("?")
        ? search.slice(search.indexOf("?") + 1)
        : search
      : search.toString();
  const query = raw.includes("#") ? raw.slice(0, raw.indexOf("#")) : raw;
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  const baselineId = params.get("compareBaseline")?.trim() || undefined;
  const candidateId = params.get("compareCandidate")?.trim() || undefined;
  const view = parseDeepLinkView(params.get("compareView"));
  return {
    ...(baselineId ? { baselineId } : {}),
    ...(candidateId ? { candidateId } : {}),
    ...(view ? { view } : {})
  };
}

export interface MatchComparisonSelectionSource {
  view: string;
  baseline: { matchId?: string | null; runId?: string | null };
  candidate: { matchId?: string | null; runId?: string | null };
}

export function isMatchComparisonSelectionCurrent<T extends MatchComparisonSelectionSource>(options: {
  comparison: T | null | undefined;
  baselineId?: string | null;
  candidateId?: string | null;
  view?: MatchComparisonDeepLinkView | string | null;
}): boolean {
  const comparison = options.comparison;
  const baselineId = options.baselineId?.trim() || "";
  const candidateId = options.candidateId?.trim() || "";
  if (!comparison || !baselineId || !candidateId) return false;
  const baselineMatches = comparison.baseline.matchId === baselineId || comparison.baseline.runId === baselineId;
  const candidateMatches = comparison.candidate.matchId === candidateId || comparison.candidate.runId === candidateId;
  return baselineMatches && candidateMatches && (!options.view || comparison.view === options.view);
}

export function filterMatchComparisonRows<T extends MatchComparisonRowFilterCandidate>(
  rows: readonly T[],
  filter: MatchComparisonRowFilter = {}
): T[] {
  const normalized = normalizeMatchComparisonRowFilter(filter);
  return rows.filter((row) => {
    if (normalized.changedOnly && !row.changed) return false;
    if (normalized.group !== "all" && (row.group ?? "summary") !== normalized.group) return false;
    if (normalized.numericDelta === "changed" && row.delta === undefined) return false;
    if (
      normalized.evidenceIdentity === "changed" &&
      !((row.evidence?.onlyBaselineIds.length ?? 0) || (row.evidence?.onlyCandidateIds.length ?? 0))
    ) {
      return false;
    }
    if (normalized.promotion === "all") return true;
    if (normalized.promotion === "changed") {
      return Boolean(
        row.promotion && (row.promotion.details?.changed ?? row.promotion.baseline !== row.promotion.candidate)
      );
    }
    if (!row.promotion) return normalized.promotion === "missing";
    return row.promotion.baseline === normalized.promotion || row.promotion.candidate === normalized.promotion;
  });
}

export interface ComparisonRegistryLabelSource {
  comparisonId: string;
  view: string;
  baseline: { matchId?: string | null; runId?: string | null };
  candidate: { matchId?: string | null; runId?: string | null };
  summary: {
    rowCount: number;
    changedRowCount: number;
    numericDeltaCount?: number;
    promotionChangedMetricCount?: number;
    promotionProvenanceChangedMetricCount?: number;
    scorecardMetricDelta?: number;
    diagnosticMetricDelta?: number;
    benchmarkOnlyMetricDelta?: number;
    evidenceIdentityChangedMetricCount?: number;
    evidenceIdentityOnlyBaselineRefCount?: number;
    evidenceIdentityOnlyCandidateRefCount?: number;
    metricKeysCompared?: number;
    metricKeysEmitted?: number;
    metricKeysTruncated?: number;
    scorecardMetricKeysTruncated?: number;
    diagnosticMetricKeysTruncated?: number;
    benchmarkOnlyMetricKeysTruncated?: number;
    metricRowsMax?: number;
    socialStepsDelta?: number;
    committedStepsDelta?: number;
    rejectedStepsDelta?: number;
  };
}

/** Format a redaction-safe label using only registry-summary data. */
export function formatComparisonRegistryEntryLabel(
  entry: ComparisonRegistryLabelSource,
  options?: { shortIdLength?: number }
): string {
  const shortIdLength = options?.shortIdLength ?? 8;
  const shortId = (value: unknown): string => {
    if (typeof value !== "string" || !value) return "n/a";
    if (value.startsWith("match-comparison:")) {
      const hash = value.slice("match-comparison:".length);
      return hash ? `cmp:${hash.slice(0, shortIdLength)}` : "cmp:n/a";
    }
    return value.length <= 12 ? value : value.slice(0, shortIdLength);
  };
  const metric = (key: keyof ComparisonRegistryLabelSource["summary"], label: string) =>
    typeof entry.summary[key] === "number" ? ` · ${label}${entry.summary[key]}` : "";
  const evidenceOnly =
    typeof entry.summary.evidenceIdentityOnlyBaselineRefCount === "number" &&
    typeof entry.summary.evidenceIdentityOnlyCandidateRefCount === "number" &&
    (entry.summary.evidenceIdentityOnlyBaselineRefCount > 0 || entry.summary.evidenceIdentityOnlyCandidateRefCount > 0)
      ? ` · evidOnly ${entry.summary.evidenceIdentityOnlyBaselineRefCount}→${entry.summary.evidenceIdentityOnlyCandidateRefCount}`
      : "";
  const commitDensity =
    typeof entry.summary.committedStepsDelta === "number" && typeof entry.summary.rejectedStepsDelta === "number"
      ? ` · cΔ${entry.summary.committedStepsDelta}/rΔ${entry.summary.rejectedStepsDelta}`
      : typeof entry.summary.socialStepsDelta === "number"
        ? ` · sΔ${entry.summary.socialStepsDelta}`
        : "";
  const keys =
    typeof entry.summary.metricKeysEmitted === "number" && typeof entry.summary.metricKeysCompared === "number"
      ? ` · keys ${entry.summary.metricKeysEmitted}/${entry.summary.metricKeysCompared}`
      : "";
  const max =
    typeof entry.summary.metricRowsMax === "number" &&
    typeof entry.summary.metricKeysTruncated === "number" &&
    entry.summary.metricKeysTruncated > 0
      ? ` · max${entry.summary.metricRowsMax}`
      : "";
  const truncatedParts: string[] = [];
  if ((entry.summary.scorecardMetricKeysTruncated ?? 0) > 0) {
    truncatedParts.push(`scoreTrunc${entry.summary.scorecardMetricKeysTruncated}`);
  }
  if ((entry.summary.diagnosticMetricKeysTruncated ?? 0) > 0) {
    truncatedParts.push(`diagTrunc${entry.summary.diagnosticMetricKeysTruncated}`);
  }
  if ((entry.summary.benchmarkOnlyMetricKeysTruncated ?? 0) > 0) {
    truncatedParts.push(`benchTrunc${entry.summary.benchmarkOnlyMetricKeysTruncated}`);
  }
  if (truncatedParts.length === 0 && (entry.summary.metricKeysTruncated ?? 0) > 0) {
    truncatedParts.push(`trunc${entry.summary.metricKeysTruncated}`);
  }
  const truncated = truncatedParts.length > 0 ? ` · ${truncatedParts.join(" · ")}` : "";
  return `${shortId(entry.comparisonId)} · ${entry.view} · ${shortId(entry.baseline.matchId ?? entry.baseline.runId)}→${shortId(entry.candidate.matchId ?? entry.candidate.runId)} · Δ${entry.summary.changedRowCount}/${entry.summary.rowCount}${metric("numericDeltaCount", "numΔ")}${metric("promotionChangedMetricCount", "promoΔ")}${metric("promotionProvenanceChangedMetricCount", "provΔ")}${metric("scorecardMetricDelta", "scoreΔ")}${metric("diagnosticMetricDelta", "diagΔ")}${metric("benchmarkOnlyMetricDelta", "benchΔ")}${metric("evidenceIdentityChangedMetricCount", "evidΔ")}${evidenceOnly}${commitDensity}${keys}${max}${truncated}`;
}

export interface PackSeededComparisonRegistryEntry {
  comparisonId: string;
  createdAt?: string;
  baseline: { matchId?: string | null; runId?: string | null };
  candidate: { matchId?: string | null; runId?: string | null };
}

export function selectPackSeededComparisonId(
  entries: readonly PackSeededComparisonRegistryEntry[],
  packMatchIds: Iterable<string>
): string {
  const packIds = packMatchIds instanceof Set ? packMatchIds : new Set(packMatchIds);
  if (!entries.length || packIds.size < 2) return "";
  for (const entry of entries) {
    const baselineIds = [entry.baseline.matchId, entry.baseline.runId].filter(
      (value): value is string => typeof value === "string" && value.length > 0
    );
    const candidateIds = [entry.candidate.matchId, entry.candidate.runId].filter(
      (value): value is string => typeof value === "string" && value.length > 0
    );
    if (baselineIds.some((id) => packIds.has(id)) && candidateIds.some((id) => packIds.has(id))) {
      return entry.comparisonId;
    }
  }
  return "";
}

export function parseComparisonMatchIdsQuery(value: unknown): Set<string> | null {
  const rawValues = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter(isString) : [];
  const ids = new Set<string>();
  for (const raw of rawValues) {
    for (const part of raw.split(",")) {
      const id = part.trim();
      if (id) ids.add(id);
    }
  }
  return ids.size >= 2 ? ids : null;
}

export type ResolvePackSeededComparisonSource = "pack-scoped" | "full-registry-fallback" | "missing" | "none";

export interface ResolvePackSeededComparisonSelectionResult {
  comparisonId: string;
  source: ResolvePackSeededComparisonSource;
  degradedNotes: string[];
}

export function resolvePackSeededComparisonSelection(options: {
  packMatchIds: Iterable<string>;
  packScopedEntries?: readonly PackSeededComparisonRegistryEntry[] | null;
  packScopedRefreshOk?: boolean;
  fullEntries?: readonly PackSeededComparisonRegistryEntry[] | null;
}): ResolvePackSeededComparisonSelectionResult {
  const packIds = options.packMatchIds instanceof Set ? options.packMatchIds : new Set(options.packMatchIds);
  const fullEntries = Array.isArray(options.fullEntries) ? options.fullEntries : [];
  const packScopedEntries = Array.isArray(options.packScopedEntries) ? options.packScopedEntries : [];
  if (packIds.size < 2) return { comparisonId: "", source: "none", degradedNotes: [] };

  if (options.packScopedRefreshOk) {
    const packScopedId = selectPackSeededComparisonId(packScopedEntries, packIds);
    if (packScopedId) return { comparisonId: packScopedId, source: "pack-scoped", degradedNotes: [] };
    const degradedNotes = [
      packScopedEntries.length === 0
        ? "pack-scoped-comparison-empty-fallback"
        : "pack-scoped-comparison-no-match-fallback"
    ];
    const fullId = selectPackSeededComparisonId(fullEntries, packIds);
    return {
      comparisonId: fullId,
      source: fullId ? "full-registry-fallback" : "missing",
      degradedNotes
    };
  }

  const degradedNotes = options.packScopedRefreshOk === false ? ["pack-scoped-comparison-refresh-degraded"] : [];
  const fullId = selectPackSeededComparisonId(fullEntries, packIds);
  return {
    comparisonId: fullId,
    source: fullId ? "full-registry-fallback" : "missing",
    degradedNotes
  };
}

export interface TournamentPackListEntry {
  artifactSetId: string;
}

export type MergeExportedTournamentPackListNote = "ok" | "pack-list-stale" | "pack-list-refresh-degraded";

export interface MergeExportedTournamentPackListResult<T extends TournamentPackListEntry> {
  packs: T[];
  note: MergeExportedTournamentPackListNote;
}

export function mergeExportedTournamentPackList<T extends TournamentPackListEntry>(options: {
  exportedPack: T;
  listedPacks?: readonly T[] | null;
  listRefreshFailed?: boolean;
}): MergeExportedTournamentPackListResult<T> {
  if (options.listRefreshFailed) {
    return { packs: [options.exportedPack], note: "pack-list-refresh-degraded" };
  }
  const listedPacks = Array.isArray(options.listedPacks) ? options.listedPacks : [];
  return listedPacks.some((entry) => entry.artifactSetId === options.exportedPack.artifactSetId)
    ? { packs: [...listedPacks], note: "ok" }
    : { packs: [options.exportedPack, ...listedPacks], note: "pack-list-stale" };
}

function toSearchParams(search: string | URLSearchParams): URLSearchParams {
  return typeof search === "string"
    ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
    : new URLSearchParams(search);
}

function setOrDeleteParam(params: URLSearchParams, key: string, value: string | null): void {
  if (value === null || value === "") params.delete(key);
  else params.set(key, value);
}

function parseBoolean(raw: string | null, fallback: boolean): boolean {
  if (raw === null || raw === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return fallback;
}

function parseGroup(raw: string | null, fallback: "all" | MatchComparisonRowGroup): "all" | MatchComparisonRowGroup {
  return raw === "all" || raw === "summary" || raw === "metric" || raw === "metric_evidence" ? raw : fallback;
}

function parsePromotion(raw: string | null, fallback: MatchComparisonPromotionFilter): MatchComparisonPromotionFilter {
  return raw === "all" || raw === "changed" || raw === "scorecard" || raw === "diagnostic" || raw === "benchmark_only" || raw === "missing"
    ? raw
    : fallback;
}

function parseEvidenceIdentity(
  raw: string | null,
  fallback: MatchComparisonEvidenceIdentityFilter
): MatchComparisonEvidenceIdentityFilter {
  return raw === "all" || raw === "changed" ? raw : fallback;
}

function parseNumericDelta(
  raw: string | null,
  fallback: MatchComparisonNumericDeltaFilter
): MatchComparisonNumericDeltaFilter {
  return raw === "all" || raw === "changed" ? raw : fallback;
}

function parseDeepLinkView(raw: string | null): MatchComparisonDeepLinkView | undefined {
  return raw === "postgame-redacted" || raw === "truth-redacted" ? raw : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
