import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Runtime provider settings.
 *
 * Values boot from the process environment (which the npm scripts load from
 * `.env.local`). Writes go back to the local `.env.local` file so they survive
 * restarts. That file is gitignored — provider URLs, keys and model IDs never
 * enter the repository. Interactive management lives in the model registry
 * (`/api/model-config`); this module only keeps the legacy bootstrap fallback
 * (`getProviderSettings`) and the managed-secret writer used by that API.
 */

export interface ProviderSettings {
  baseURL: string;
  apiKey: string;
  models: string[];
}

const ENV_FILE = path.resolve(process.cwd(), ".env.local");
const MODELS_MAX = 16;

const current: ProviderSettings = {
  baseURL: normalizeBaseUrl(process.env.OPENAI_BASE_URL),
  apiKey: (process.env.OPENAI_API_KEY ?? "").trim(),
  models: parseModels(process.env.SOCIETY_MODELS)
};

export function getProviderSettings(): ProviderSettings {
  return { ...current };
}

/**
 * Write one provider secret into .env.local under a managed variable name.
 * Only the variable reference is stored in the model registry; the raw key
 * never leaves the local secret file.
 */
export function writeEnvKey(name: string, value: string): void {
  const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "SOCIETY_PROVIDER_KEY";
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  const next: string[] = [];
  let written = false;
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && match[1] === key) {
      next.push(`${key}=${value}`);
      written = true;
    } else {
      next.push(line);
    }
  }
  if (!written) next.push(`${key}=${value}`);
  const content = next.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  writeFileSync(ENV_FILE, content, { mode: 0o600 });
}

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/(chat\/completions|responses|models)\/?$/i, "").replace(/\/$/, "");
}

function parseModels(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((id) => id.trim()).filter(Boolean))].slice(0, MODELS_MAX);
}
