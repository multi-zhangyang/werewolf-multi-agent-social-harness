import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import type { ModelOption } from "../types";
import type { CharacterOption, ModelAssignMode } from "./types";

/** 参与者阵容: per-seat character pick, and per-seat model in per-seat mode. */
export function RosterSection({
  players,
  mode,
  playerName,
  characters,
  seatCharacters,
  onSeatCharacterChange,
  assignMode,
  seatPicks,
  onSeatPicksChange,
  unifiedId,
  eligibleModels,
  rosterModelFor
}: {
  players: number;
  mode: "ai" | "human";
  playerName: string;
  characters: CharacterOption[];
  seatCharacters: Record<string, string>;
  onSeatCharacterChange: (seat: number, characterId: string | undefined) => void;
  assignMode: ModelAssignMode;
  seatPicks: Record<string, string>;
  onSeatPicksChange: (seat: number, profileId: string | undefined) => void;
  unifiedId: string;
  eligibleModels: ModelOption[];
  /** Display label for the seat's resolved model (preview + non-per-seat rows). */
  rosterModelFor: (index: number) => { name?: string; contextLabel?: string; picked: boolean };
}): ReactNode {
  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between">
        <p className="text-[13px] font-medium text-foreground/80">参与者阵容</p>
        <span className="text-[11px] text-muted-foreground/70">{assignMode === "per-seat" ? "逐席模式：每行可单独选模型" : "人物可选；模型按上方分配"}</span>
      </div>
      {characters.length ? (
        <p className="mb-2 text-xs leading-5 text-muted-foreground/80">
          为每个席位挑选人物（内置或自建）；{assignMode === "per-seat" ? "同时在每行右侧指定该席位的模型。" : "模型分配见上方「模型分配」与最终阵容预览。"}
        </p>
      ) : null}
      <div className="rounded-lg border border-border bg-muted/60 p-3" data-model>
        <div className="space-y-1.5">
          {Array.from({ length: players }).map((_, index) => {
            const isHuman = mode === "human" && index === 0;
            const picked = seatPicks[String(index)];
            const option = rosterModelFor(index);
            return (
              <div key={index} className="rounded-md px-1 py-0.5">
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <span className="flex size-5 items-center justify-center rounded bg-card font-mono text-[9px] text-muted-foreground/80 ring-1 ring-border">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {isHuman ? (
                      <span className="flex items-center gap-1.5">
                        {playerName.trim() || "你"}
                        <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1 text-[9px] text-amber-300">人类玩家</span>
                      </span>
                    ) : characters.length ? (
                      <Select
                        value={seatCharacters[String(index)] ?? "__default"}
                        onValueChange={(value) => onSeatCharacterChange(index, value === "__default" ? undefined : value)}
                      >
                        <SelectTrigger aria-label={`第 ${index + 1} 位参与者的人物`} className="h-7 w-44 justify-start rounded-md border-border bg-card text-[11px] text-foreground/80">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="__default">按顺序内置人物</SelectItem>
                            {characters.map((character) => (
                              <SelectItem key={character.id} value={character.id}>
                                {character.displayName}{character.builtIn ? "" : " · 自建"}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    ) : (
                      <span>第 {index + 1} 位参与者</span>
                    )}
                  </span>
                  {isHuman ? (
                    <span className="font-mono text-[11px] text-muted-foreground/60">本人操控</span>
                  ) : assignMode === "per-seat" ? (
                    <Select
                      value={picked ?? unifiedId}
                      onValueChange={(value) => onSeatPicksChange(index, value === unifiedId ? undefined : value)}
                    >
                      <SelectTrigger aria-label={`第 ${index + 1} 席位的模型`} className="h-7 w-56 justify-end rounded-md border-border bg-card font-mono text-[11px] text-muted-foreground">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {eligibleModels.map((model) => (
                            <SelectItem key={model.profileId} value={model.profileId!}>
                              {model.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                      {picked ? <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1 text-[9px] text-amber-300">指定</span> : null}
                      {option.contextLabel ? (
                        <span className="rounded border border-border bg-card px-1 text-[9px] text-muted-foreground/80">{option.contextLabel}</span>
                      ) : null}
                      {option.name ?? "—"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {assignMode === "per-seat" ? (
          <p className="mt-2 border-t border-border/60 pt-2 text-[11px] leading-4 text-muted-foreground/80">
            每个参与者仍是一个独立 Agent：这里只决定每个席位的模型档案；人格、记忆与关系不变。想恢复某席位的统一模型，把它重新选成与上方一致即可。
          </p>
        ) : null}
      </div>
    </section>
  );
}
