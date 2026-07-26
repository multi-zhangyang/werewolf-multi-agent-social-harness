import { round3 } from "./benchmarkStatistics";
import { sanitizePersistedProviderDiagnostics } from "../providerFailure";
import { redactSecrets } from "../redaction";
import { TournamentArtifactFiles, TournamentArtifactWriteResult } from "./model";
import { writeFile } from "node:fs/promises";
export function markdownTable(headers: string[], rows: string[][]): string {
  if (!rows.length) return "_No records._";
  const safeHeaders = headers.map(markdownTableCell);
  const safeRows = rows.map((row) => row.map(markdownTableCell));
  return [
    `| ${safeHeaders.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...safeRows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

function markdownTableCell(value: string): string {
  return markdownText(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function markdownText(value: string): string {
  const redacted = redactSecrets(value);
  return typeof redacted === "string" ? redacted : value;
}

export function ratio(numerator: number, denominator: number): string {
  return denominator ? String(round3(numerator / denominator)) : "0";
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export async function writeJson(filePath: string, value: unknown, overwrite: boolean): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(sanitizePersistedProviderDiagnostics(redactSecrets(value)), null, 2)}\n`, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

export async function writeJsonl(filePath: string, records: unknown[], overwrite: boolean): Promise<void> {
  const data = records.length
    ? `${records.map((record) => JSON.stringify(sanitizePersistedProviderDiagnostics(redactSecrets(record)))).join("\n")}\n`
    : "";
  await writeFile(filePath, data, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

export async function writeText(filePath: string, value: string, overwrite: boolean): Promise<void> {
  const redacted = redactSecrets(value);
  await writeFile(filePath, typeof redacted === "string" ? redacted : value, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

export function filesResult<TFiles extends TournamentArtifactFiles>(
  outputDir: string,
  files: TFiles
): TournamentArtifactWriteResult<TFiles> {
  return {
    outputDir,
    files
  };
}

export function safeFileStem(value: string): string {
  const stem = value.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^\.+$/, "artifact");
  return stem || "artifact";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
