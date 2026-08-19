import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Runtime provider settings.
 *
 * Values boot from the process environment (which the npm scripts load from
 * `.env.local`). The settings UI can update them at runtime; saves are written
 * back to the local `.env.local` file so they survive restarts. That file is
 * gitignored — provider URLs, keys and model IDs never enter the repository.
 */

export interface ProviderSettings {
  baseURL: string;
  apiKey: string;
  models: string[];
}

interface PublicSettings {
  baseURL: string;
  models: string[];
  hasKey: boolean;
  keyHint?: string;
}

const ENV_FILE = path.resolve(process.cwd(), ".env.local");
const KEY_MAX = 400;
const MODELS_MAX = 16;
const MODEL_ID_MAX = 180;

let current: ProviderSettings = {
  baseURL: normalizeBaseUrl(process.env.OPENAI_BASE_URL),
  apiKey: (process.env.OPENAI_API_KEY ?? "").trim(),
  models: parseModels(process.env.SOCIETY_MODELS)
};

export function getProviderSettings(): ProviderSettings {
  return { ...current };
}

export function publicSettings(): PublicSettings {
  return {
    baseURL: current.baseURL,
    models: [...current.models],
    hasKey: Boolean(current.apiKey),
    ...(current.apiKey ? { keyHint: keyHint(current.apiKey) } : {})
  };
}

export function saveProviderSettings(input: { baseURL?: string; apiKey?: string; models?: string[] }): PublicSettings {
  const baseURL = normalizeBaseUrl(input.baseURL ?? current.baseURL);
  const apiKey = input.apiKey !== undefined
    ? input.apiKey.trim().slice(0, KEY_MAX)
    : current.apiKey;
  const models = input.models !== undefined
    ? input.models.map((id) => id.trim()).filter(Boolean).slice(0, MODELS_MAX).map((id) => id.slice(0, MODEL_ID_MAX))
    : current.models;
  if (models.length === 0) throw new Error("MODELS_REQUIRED: Configure at least one model id.");
  current = { baseURL, apiKey, models };
  persistToEnvFile(current);
  return publicSettings();
}

/** Verify connectivity against the configured endpoint without echoing the key. */
export async function testProviderSettings(): Promise<{ ok: boolean; message: string; modelIds?: string[] }> {
  if (!current.apiKey) return { ok: false, message: "尚未配置 API 密钥。" };
  if (!current.baseURL) return { ok: false, message: "尚未配置提供商地址（base URL）。" };
  const headers = { Authorization: `Bearer ${current.apiKey}` };
  try {
    const response = await fetch(`${current.baseURL}/models`, { headers, signal: AbortSignal.timeout(15_000) });
    if (response.ok) {
      const payload = await response.json().catch(() => undefined) as { data?: Array<{ id?: string }> } | undefined;
      const ids = (payload?.data ?? []).map((entry) => entry.id).filter((id): id is string => Boolean(id)).slice(0, 40);
      return { ok: true, message: `连接成功，端点返回 ${ids.length} 个模型。`, ...(ids.length ? { modelIds: ids } : {}) };
    }
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `鉴权失败（HTTP ${response.status}）：请检查 API 密钥。` };
    }
    if (response.status === 404) {
      return await probeChatCompletion(current, headers);
    }
    return { ok: false, message: `端点返回 HTTP ${response.status}：${redact(text).slice(0, 160)}` };
  } catch (error) {
    return { ok: false, message: `无法连接：${redact(errorMessage(error)).slice(0, 200)}` };
  }
}

async function probeChatCompletion(settings: ProviderSettings, headers: Record<string, string>): Promise<{ ok: boolean; message: string; modelIds?: string[] }> {
  const model = settings.models[0];
  if (!model) return { ok: false, message: "端点没有 /models 接口，且未配置模型 ID 可探测。" };
  try {
    const response = await fetch(`${settings.baseURL}/chat/completions`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(20_000)
    });
    if (response.ok) return { ok: true, message: `连接成功（${model} 完成一次最小补全）。` };
    const text = await response.text().catch(() => "");
    return { ok: false, message: `补全请求返回 HTTP ${response.status}：${redact(text).slice(0, 160)}` };
  } catch (error) {
    return { ok: false, message: `补全请求失败：${redact(errorMessage(error)).slice(0, 200)}` };
  }
}

function persistToEnvFile(settings: ProviderSettings): void {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  const written = new Set<string>();
  const next: string[] = [];
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) {
      next.push(line);
      continue;
    }
    const key = match[1];
    if (key === "OPENAI_BASE_URL") {
      next.push(`OPENAI_BASE_URL=${settings.baseURL}`);
      written.add(key);
    } else if (key === "OPENAI_API_KEY") {
      next.push(`OPENAI_API_KEY=${settings.apiKey}`);
      written.add(key);
    } else if (key === "SOCIETY_MODELS") {
      next.push(`SOCIETY_MODELS=${settings.models.join(",")}`);
      written.add(key);
    } else {
      next.push(line);
    }
  }
  for (const key of ["OPENAI_BASE_URL", "OPENAI_API_KEY", "SOCIETY_MODELS"]) {
    if (written.has(key)) continue;
    const value = key === "OPENAI_BASE_URL" ? settings.baseURL : key === "OPENAI_API_KEY" ? settings.apiKey : settings.models.join(",");
    next.push(`${key}=${value}`);
  }
  const content = next.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  writeFileSync(ENV_FILE, content, { mode: 0o600 });
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

function keyHint(key: string): string {
  return key.length <= 6 ? "••••" : `••••${key.slice(-4)}`;
}

function redact(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}