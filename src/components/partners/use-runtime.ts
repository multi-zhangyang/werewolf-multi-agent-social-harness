import { useEffect, useState } from "react";
import type { ToolActivity } from "@/partners/api-types";
import { apiFetch } from "@/lib/api";
import { credentials } from "./api";

export function usePartnerRuntime(id: string, enabled: boolean) {
  const [value, setValue] = useState<{ id: string; activities: ToolActivity[]; error: string }>({ id, activities: [], error: "" });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const connect = async () => {
      let reconnect = true;
      try {
        const token = credentials(id)?.ownerToken;
        const response = await apiFetch(`/api/partners/${id}/runtime/events`, { signal: controller.signal, headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!response.ok || !response.body) { reconnect = response.status !== 401 && response.status !== 403; throw new Error(response.status === 403 ? "需要本局研究权限" : "运行流暂时不可用"); }
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = "";
        try {
          while (!controller.signal.aborted) {
            const { done, value: chunk } = await reader.read(); if (done) break;
            pending += decoder.decode(chunk, { stream: true });
            let boundary;
            while ((boundary = pending.indexOf("\n\n")) >= 0) {
              const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
              const data = frame.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
              if (!data || controller.signal.aborted) continue;
              const update = JSON.parse(data) as { activities: ToolActivity[]; reset: boolean };
              setValue(previous => {
                const items = new Map((!update.reset && previous.id === id ? previous.activities : []).map(item => [item.id, item]));
                for (const activity of update.activities) items.set(activity.id, activity);
                return { id, activities: [...items.values()].slice(-250), error: "" };
              });
            }
          }
          if (!controller.signal.aborted) throw new Error("运行流已断开，正在重连；已显示内容保留。");
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      } catch (error) {
        if (!controller.signal.aborted) setValue(previous => ({ id, activities: previous.id === id ? previous.activities : [], error: error instanceof Error ? error.message : "运行流暂时断开" }));
      } finally { if (!controller.signal.aborted && reconnect) timer = setTimeout(() => void connect(), 1500); }
    };
    void connect(); return () => { controller.abort(); clearTimeout(timer); };
  }, [id, enabled]);
  return enabled && value.id === id ? value : { id, activities: [], error: "" };
}
