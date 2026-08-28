import { describe, expect, it } from "vitest";
import type { SocialMessage } from "@/society/contracts";
import { belongsToCluster, CLUSTER_WINDOW_MS } from "@/components/society/stream-cluster";

function message(overrides: Partial<SocialMessage>): SocialMessage {
  return {
    id: "m1",
    roomId: "r1",
    senderId: "a1",
    senderName: "甲",
    channel: "public",
    text: "你好",
    turn: 1,
    phase: "协商",
    createdAt: "2026-08-28T10:00:00.000Z",
    ...overrides
  };
}

describe("belongsToCluster — chat-app grouping of consecutive messages", () => {
  it("groups same actor, same channel, within the window", () => {
    const first = message({});
    const next = message({ id: "m2", createdAt: "2026-08-28T10:04:00.000Z" });
    expect(belongsToCluster(first, next)).toBe(true);
  });

  it("breaks on a different sender", () => {
    const first = message({});
    const next = message({ id: "m2", senderId: "a2", createdAt: "2026-08-28T10:01:00.000Z" });
    expect(belongsToCluster(first, next)).toBe(false);
  });

  it("breaks on a different channel", () => {
    const first = message({});
    const next = message({ id: "m2", channel: "private", createdAt: "2026-08-28T10:01:00.000Z" });
    expect(belongsToCluster(first, next)).toBe(false);
  });

  it("breaks past the time window", () => {
    const first = message({});
    const beyond = message({ id: "m2", createdAt: new Date(Date.parse(first.createdAt) + CLUSTER_WINDOW_MS + 1).toISOString() });
    const atLimit = message({ id: "m2", createdAt: new Date(Date.parse(first.createdAt) + CLUSTER_WINDOW_MS).toISOString() });
    expect(belongsToCluster(first, beyond)).toBe(false);
    expect(belongsToCluster(first, atLimit)).toBe(true);
  });
});
