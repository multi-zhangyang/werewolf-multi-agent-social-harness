/**
 * Message sidecar extractor unit tests (AGENTS.md §6.5 / P1-02). Deterministic
 * parsing only — no model calls. The prompt builder and the tolerant JSON
 * parser are exercised against realistic model output shapes.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { SocialMessage } from "../../src/society/contracts";
import { buildExtractionRequest, EXTRACTION_CONFIDENCE_FLOOR, parseExtractedDeclarations } from "../../src/society/social/message-extractor";

const ROSTER = [
  { id: "agent-01", name: "林默" },
  { id: "agent-02", name: "苏遥" }
];

function message(overrides: Partial<SocialMessage> = {}): SocialMessage {
  return {
    id: `msg-${randomUUID()}`,
    roomId: "room-x",
    senderId: "agent-01",
    senderName: "林默",
    channel: "public",
    text: "苏遥，这轮我一定投你，你也要投我。",
    turn: 2,
    phase: "discussion",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

describe("parseExtractedDeclarations", () => {
  it("parses fenced JSON, resolves target display names to actor ids, and keeps first-person subjects", () => {
    const raw = "```json\n" + JSON.stringify([
      { kind: "promise", targets: ["苏遥"], proposition: "这轮我会投给苏遥", confidence: 0.92 },
      { kind: "request", targets: ["苏遥"], proposition: "希望苏遥也投给我", confidence: 0.7 }
    ]) + "\n```";
    const declarations = parseExtractedDeclarations(raw, message(), ROSTER);
    assert.equal(declarations.length, 2);
    assert.deepEqual(declarations[0].targetActorIds, ["agent-02"]);
    assert.equal(declarations[0].proposition?.subjectId, "agent-01");
    assert.equal(declarations[0].proposition?.kind, "future-action");
    assert.equal(declarations[1].proposition?.kind, "future-action");
  });

  it("drops unknown kinds, sub-floor confidence and malformed entries", () => {
    const raw = JSON.stringify([
      { kind: "silence", proposition: "x", confidence: 0.9 },
      { kind: "accusation", proposition: "苏遥昨晚杀错了人", confidence: 0.3 },
      { kind: "accusation", proposition: "有效指控", confidence: 0.8 },
      "junk",
      null
    ]);
    const declarations = parseExtractedDeclarations(raw, message(), ROSTER);
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].kind, "accusation");
    assert.ok(0.3 < EXTRACTION_CONFIDENCE_FLOOR);
  });

  it("falls back to channel audience when the extractor names no target on a private message", () => {
    const raw = JSON.stringify([{ kind: "promise", proposition: "我会返还至少一半", confidence: 0.85 }]);
    const privateMessage = message({ channel: "private", recipientIds: ["agent-02"] });
    const declarations = parseExtractedDeclarations(raw, privateMessage, ROSTER);
    assert.deepEqual(declarations[0].targetActorIds, ["agent-02"]);
  });

  it("returns [] for prose without a JSON array and caps output at three acts", () => {
    assert.equal(parseExtractedDeclarations("我觉得这轮大家都很谨慎。", message(), ROSTER).length, 0);
    const four = Array.from({ length: 4 }, (_, index) => ({ kind: "assertion", proposition: `c${index}`, confidence: 0.9 }));
    assert.equal(parseExtractedDeclarations(JSON.stringify(four), message(), ROSTER).length, 3);
  });
});

describe("buildExtractionRequest", () => {
  it("includes roster ids, channel and verbatim text; instructions demand JSON-only output", () => {
    const request = buildExtractionRequest(message(), ROSTER);
    assert.match(request.systemInstructions, /JSON 数组/);
    assert.match(request.input, /id: agent-02/);
    assert.match(request.input, /这轮我一定投你/);
    assert.doesNotMatch(request.systemInstructions, /silence/);
  });
});
