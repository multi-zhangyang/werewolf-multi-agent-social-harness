import { useState, type ReactNode } from "react";
import { Check, Loader2, Plus, Settings2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SettingsSnapshot {
  baseURL: string;
  models: string[];
  hasKey: boolean;
  keyHint?: string;
}

interface TestResult {
  ok: boolean;
  message: string;
  modelIds?: string[];
}

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function SettingsDialog({ open, onOpenChange, onSaved }: SettingsDialogProps): ReactNode {
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [keyHint, setKeyHint] = useState<string>();
  const [draftModel, setDraftModel] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const response = await fetch("/api/settings");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json() as SettingsSnapshot;
      setBaseURL(next.baseURL);
      setApiKey("");
      setModels(next.models);
      setKeyHint(next.keyHint);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (open && !loaded) void load();

  const addModel = (id: string): void => {
    const trimmed = id.trim();
    if (!trimmed) return;
    setModels((current) => current.includes(trimmed) ? current : [...current, trimmed]);
    setDraftModel("");
  };

  const removeModel = (id: string): void => {
    setModels((current) => current.filter((entry) => entry !== id));
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setTestResult(undefined);
    setError(undefined);
    try {
      const response = await fetch("/api/settings/test", { method: "POST" });
      const payload = await response.json().catch(() => undefined) as TestResult | undefined;
      if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
      setTestResult(payload);
    } catch (cause) {
      setTestResult({ ok: false, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setTesting(false);
    }
  };

  const save = async (): Promise<void> => {
    if (models.length === 0) {
      setError("至少保留一个模型 ID。");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseURL,
          models,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
        })
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
      setApiKey("");
      onSaved();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl rounded-xl border-zinc-200 bg-white p-0 text-foreground shadow-2xl">
        <div className="max-h-[82vh] overflow-y-auto">
          <div className="border-b border-zinc-100 p-6">
            <DialogHeader className="gap-2 text-left">
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-xl border border-white/10 bg-zinc-50 text-zinc-700">
                  <Settings2 className="size-5" />
                </span>
                <div>
                  <DialogTitle className="text-lg tracking-tight">模型提供商</DialogTitle>
                  <DialogDescription className="mt-0.5 leading-5 text-zinc-500">
                    配置 API 地址、密钥与可用模型。所有配置只保存在本机 <span className="font-mono text-zinc-500">.env.local</span>,永远不会进入代码仓库。
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
          </div>

          <div className="space-y-6 p-6">
            <section>
              <p className="mb-2.5 text-[13px] font-medium text-zinc-700">提供商地址（Base URL）</p>
              <Input
                data-model
                value={baseURL}
                onChange={(event) => setBaseURL(event.target.value)}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
              />
              <p className="mt-1.5 text-xs text-zinc-400">OpenAI 兼容端点的根地址,通常以 /v1 结尾。</p>
            </section>

            <section>
              <p className="mb-2.5 text-[13px] font-medium text-zinc-700">API 密钥</p>
              <Input
                data-model
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={keyHint ? `已保存（${keyHint}），留空保持不变` : "sk-…"}
                spellCheck={false}
                autoComplete="off"
              />
              <p className="mt-1.5 text-xs text-zinc-400">留空表示沿用已保存的密钥。界面与接口永远不返回完整密钥。</p>
            </section>

            <section>
              <div className="mb-2.5 flex items-center justify-between">
                <p className="text-[13px] font-medium text-zinc-700">模型清单</p>
                <span className="nums font-mono text-xs text-zinc-400">{models.length}/16</span>
              </div>
              <div className="mb-3 flex flex-wrap gap-2">
                {models.length === 0 ? (
                  <p className="text-xs text-zinc-400">尚未配置模型,请在下方添加。</p>
                ) : models.map((model) => (
                  <Badge data-model key={model} variant="outline" className="gap-1.5 rounded-full border-zinc-200 bg-zinc-50 py-1.5 pl-3 pr-2 font-mono text-[11px] font-normal text-zinc-600">
                    {model}
                    <button
                      type="button"
                      aria-label={`移除 ${model}`}
                      onClick={() => removeModel(model)}
                      className="flex size-4 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-zinc-200 hover:text-zinc-900"
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={draftModel}
                  onChange={(event) => setDraftModel(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") addModel(draftModel); }}
                  placeholder="模型 ID，例如 your-model-id"
                  spellCheck={false}
                  className="flex-1"
                />
                <Button variant="outline" size="icon" className="size-10 shrink-0 rounded-xl border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100" onClick={() => addModel(draftModel)} aria-label="添加模型">
                  <Plus className="size-4" />
                </Button>
              </div>
            </section>

            {testResult ? (
              <section className={cn(
                "rounded-2xl border p-4",
                testResult.ok ? "border-emerald-200 bg-emerald-50/60" : "border-red-200 bg-red-50/60"
              )}>
                <p className={cn("text-[13px]", testResult.ok ? "text-emerald-700" : "text-red-600")}>
                  {testResult.ok ? <Check className="mr-1 inline size-3.5" /> : null}
                  {testResult.message}
                </p>
                {testResult.ok && testResult.modelIds?.length ? (
                  <>
                    <div data-model className="mt-3 flex flex-wrap gap-1.5">
                      {testResult.modelIds.slice(0, 12).map((id) => (
                        <span key={id} className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono text-[10px] text-zinc-500">{id}</span>
                      ))}
                    </div>
                    <Button data-model variant="ghost" size="sm" className="mt-3 h-8 rounded-lg text-xs text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900" onClick={() => setModels((current) => [...new Set([...current, ...(testResult.modelIds ?? [])])].slice(0, 16))}>
                      <Plus className="size-3" />
                      把发现的前 {Math.min(12, testResult.modelIds.length)} 个模型加入清单
                    </Button>
                  </>
                ) : null}
              </section>
            ) : null}

            {error ? <p className="text-[13px] text-red-500">{error}</p> : null}

            <div className="flex items-center justify-between border-t border-zinc-100 pt-5">
              <Button variant="outline" size="sm" className="rounded-lg border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900" disabled={testing || saving} onClick={() => void test()}>
                {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                测试连接
              </Button>
              <div className="flex items-center gap-3">
                <Button variant="ghost" className="text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900" disabled={saving} onClick={() => onOpenChange(false)}>
                  取消
                </Button>
                <Button onClick={() => void save()} disabled={saving} className="rounded-lg bg-foreground px-6 text-background hover:bg-zinc-800">
                  {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                  保存配置
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}