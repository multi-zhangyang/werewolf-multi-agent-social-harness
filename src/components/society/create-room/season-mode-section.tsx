import type { ReactNode } from "react";
import { History } from "lucide-react";
import { cn } from "@/lib/utils";

/** 记忆模式: season continuity vs one-shot isolation. */
export function SeasonModeSection({ seasonMode, onSeasonModeChange, seasonCount }: {
  seasonMode: "season" | "one-shot";
  onSeasonModeChange: (mode: "season" | "one-shot") => void;
  seasonCount: number;
}): ReactNode {
  return (
    <section>
      <p className="mb-2.5 text-[13px] font-medium text-foreground/80">记忆模式</p>
      <div className="grid grid-cols-2 gap-2">
        <SeasonModeCard
          active={seasonMode === "season"}
          onClick={() => onSeasonModeChange("season")}
          title="社会季模式"
          description="角色带着过往对局的记忆、关系与恩怨入场，一局结束后继续积累。像一群越玩越熟的老友。"
          hint={seasonCount > 0 ? `${seasonCount} 位角色已有历史` : "从零开始积累"}
        />
        <SeasonModeCard
          active={seasonMode === "one-shot"}
          onClick={() => onSeasonModeChange("one-shot")}
          title="单局模式"
          description="本局完全隔离，不读取任何历史，结束后也不留下任何记忆。适合一局定胜负、零干扰对决。"
          hint="无历史、无残留"
        />
      </div>
      {seasonMode === "season" && seasonCount > 0 ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
          <History className="mt-0.5 size-3.5 shrink-0" />
          社会季进行中：{seasonCount} 位角色会带着历史入场。想让他们互不相识，请先在首页「重置社会季」，或改用单局模式。
        </p>
      ) : null}
      {seasonMode === "one-shot" ? (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          不读取、也不写入社会季：身份随机、记忆归零，连角色关系都从陌生人开始。
        </p>
      ) : null}
    </section>
  );
}

function SeasonModeCard({ active, onClick, title, description, hint }: {
  active: boolean;
  onClick: () => void;
  title: string;
  description: string;
  hint?: string;
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col rounded-lg border p-3.5 text-left transition-colors",
        active ? "border-emerald-400/50 bg-emerald-400/10" : "border-border bg-card hover:border-border"
      )}
    >
      <span className={cn("flex items-center gap-2 text-[13px] font-semibold", active ? "text-emerald-300" : "text-foreground/90")}>
        <span className={cn("flex size-3.5 items-center justify-center rounded-full border", active ? "border-emerald-400 bg-emerald-400" : "border-border")}>
          {active ? <span className="size-1.5 rounded-full bg-background" /> : null}
        </span>
        {title}
        {hint ? <span className={cn("ml-auto rounded-full border px-2 py-px text-[10px] font-normal", active ? "border-emerald-400/40 text-emerald-300/90" : "border-border text-muted-foreground")}>{hint}</span> : null}
      </span>
      <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">{description}</span>
    </button>
  );
}
