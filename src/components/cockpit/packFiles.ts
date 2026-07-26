import type { TournamentArtifactSetSummary } from "./cockpitTypes";
import { isRecord } from "./formatters";

export function flattenTournamentPackFiles(files: Record<string, unknown> | null | undefined): string[] {
  if (!files || typeof files !== "object") return [];
  const values: string[] = [];
  for (const value of Object.values(files)) {
    if (typeof value === "string" && value.length > 0) values.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.length > 0) values.push(item);
      }
    }
  }
  return [...new Set(values)].sort();
}

export function tournamentPackAggregateFiles(pack: TournamentArtifactSetSummary): Array<{
  key: string;
  file: string;
  available: boolean;
  href: string | null;
}> {
  const preferred = [
    "manifest.json",
    "leaderboard.json",
    "benchmark_statistics.json",
    "tournament_comparison.json",
    "tournament_comparison.md",
    "summary.md",
    "cost_latency.json",
    "assignment.json"
  ];
  const registered = new Set(flattenTournamentPackFiles(pack.files));
  const downloads = pack.downloads ?? {};
  return preferred.map((file) => {
    const key = fileKeyForTournamentFile(file);
    const downloadCandidate = downloads[key] ?? downloads[file];
    const href = typeof downloadCandidate === "string" && downloadCandidate.length > 0 ? downloadCandidate : null;
    return {
      key: file,
      file,
      available: registered.has(file) || Boolean(href),
      href
    };
  });
}

export function fileKeyForTournamentFile(file: string): string {
  switch (file) {
    case "manifest.json":
      return "manifest";
    case "leaderboard.json":
      return "leaderboard";
    case "benchmark_statistics.json":
      return "benchmarkStatistics";
    case "tournament_comparison.json":
      return "tournamentComparison";
    case "tournament_comparison.md":
      return "tournamentComparisonMarkdown";
    case "summary.md":
      return "summaryMarkdown";
    case "cost_latency.json":
      return "costLatency";
    case "assignment.json":
      return "assignment";
    default:
      return file;
  }
}

export const DEFAULT_SHARE_ALLOWLIST = [
  "manifest.json",
  "assignment.json",
  "leaderboard.json",
  "benchmark_statistics.json",
  "tournament_comparison.json",
  "tournament_comparison.md",
  "summary.md",
  "episodes.csv",
  "agents.csv",
  "metrics.csv",
  "leaderboard.csv"
];

export function matrixArtifactDownloadEntries(downloads: Record<string, unknown>): Array<{ key: string; label: string; href: string }> {
  const entries: Array<{ key: string; label: string; href: string }> = [];
  for (const [key, value] of Object.entries(downloads)) {
    if (typeof value === "string") {
      entries.push({ key, label: key, href: value });
      continue;
    }
    if (key === "tournaments" && Array.isArray(value)) {
      for (const item of value) {
        if (!isRecord(item) || typeof item.cellId !== "string" || typeof item.manifest !== "string") continue;
        entries.push({ key: `tournament:${item.cellId}`, label: `tournament ${item.cellId}`, href: item.manifest });
      }
    }
  }
  return entries;
}
