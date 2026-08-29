import { describe, expect, it } from "vitest";
import type { WorldSnapshot } from "@/society/contracts";
import { buildEndgameSummary, dayHistory } from "@/components/society/cinematics";

function world(log: Array<{ id: string; at: string; text: string; beat?: string }>): Pick<WorldSnapshot, "log"> {
  return { log } as Pick<WorldSnapshot, "log">;
}

describe("buildEndgameSummary — the endgame headline from the world log", () => {
  it("prefers the last win beat", () => {
    const summary = buildEndgameSummary(world([
      { id: "l1", at: "2026-08-28T10:00:00.000Z", text: "天黑请闭眼" },
      { id: "l2", at: "2026-08-28T10:05:00.000Z", text: "所有狼人都已出局，村庄阵营获胜。", beat: "win" },
      { id: "l3", at: "2026-08-28T10:05:01.000Z", text: "身份已全部揭晓" }
    ]));
    expect(summary.headline).toBe("所有狼人都已出局，村庄阵营获胜。");
  });

  it("falls back to the last log entry when no win beat exists", () => {
    const summary = buildEndgameSummary(world([
      { id: "l1", at: "2026-08-28T10:00:00.000Z", text: "第一轮结束" },
      { id: "l2", at: "2026-08-28T10:05:00.000Z", text: "对局结束" }
    ]));
    expect(summary.headline).toBe("对局结束");
  });

  it("survives an empty log", () => {
    expect(buildEndgameSummary(world([])).headline).toBe("对局已结束");
  });
});

describe("dayHistory — extracting the published day records", () => {
  it("returns records with numeric days and drops junk", () => {
    const history = dayHistory({
      history: [
        { day: 1, votes: { a: "b" }, nightKillId: "c" },
        null,
        "not-a-record"
      ]
    });
    expect(history).toEqual([{ day: 1, votes: { a: "b" }, nightKillId: "c" }]);
  });

  it("returns an empty list for worlds without a published history", () => {
    expect(dayHistory({})).toEqual([]);
    expect(dayHistory({ history: "nope" })).toEqual([]);
  });
});
