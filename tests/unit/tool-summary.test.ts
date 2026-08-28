/**
 * Tool-payload summarizer: raw sanitized JSON must flatten into one
 * semantic line for spectators — noise dropped, ids resolved or
 * middle-truncated, booleans spoken in plain words — with graceful
 * degradation for non-JSON output.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { summarizeToolOutput } from "../../src/components/society/tool-summary";

const names = (id: string): string | undefined => ({ "agent-02": "苏遥", "agent-01": "林默" })[id];

describe("summarizeToolOutput", () => {
  it("renders known keys with Chinese labels and resolves actor ids to names", () => {
    const raw = JSON.stringify({ accepted: true, move: "cooperate", waitingFor: ["agent-02"] }, null, 2);
    assert.equal(summarizeToolOutput(raw, names), "已接受 · 动作 合作 · 等待 苏遥");
  });

  it("speaks false booleans with their polar label", () => {
    const raw = JSON.stringify({ accepted: false });
    assert.equal(summarizeToolOutput(raw, names), "未接受");
  });

  it("drops bookkeeping noise keys entirely", () => {
    const raw = JSON.stringify({ recorded: true, kind: "mind-read", actorModelIds: ["actor-model-447afbdaf43449ce195cd1be"] });
    assert.equal(summarizeToolOutput(raw, names), "类型 读心");
  });

  it("middle-truncates unresolved machine ids instead of dumping them", () => {
    const raw = JSON.stringify({ commitmentRef: "commit:pd:1:agent-02:1:extra-long-suffix" });
    const summary = summarizeToolOutput(raw, names);
    assert.ok(summary?.startsWith("commitmentRef commit:pd:"));
    assert.ok(summary?.endsWith("suffix"));
    assert.ok(!summary?.includes("agent-02:1:extra"));
  });

  it("caps long lists with a count", () => {
    const raw = JSON.stringify({ team: ["agent-01", "agent-02", "agent-03", "agent-04"] });
    assert.equal(summarizeToolOutput(raw, names), "队伍 林默、苏遥、agent-03 等 4 项");
  });

  it("truncates long free-text values", () => {
    const raw = JSON.stringify({ topic: "第一轮我方合作，条件是贵方同样承诺合作，违约金按最高档计" });
    const summary = summarizeToolOutput(raw, names);
    assert.ok(summary?.startsWith("主张 第一轮我方合作"));
    assert.ok(summary!.length < 70);
  });

  it("degrades to truncated raw text for non-JSON output", () => {
    const summary = summarizeToolOutput("plain text output from an odd tool");
    assert.equal(summary, "plain text output from an odd tool");
  });

  it("returns undefined when nothing survives the noise filter", () => {
    assert.equal(summarizeToolOutput(JSON.stringify({ recorded: true, ok: true })), undefined);
    assert.equal(summarizeToolOutput(undefined), undefined);
    assert.equal(summarizeToolOutput(JSON.stringify({ note: "" })), undefined);
  });

  it("renders nested objects inline", () => {
    const raw = JSON.stringify({ result: { stage: "believed", detected: false } });
    assert.equal(summarizeToolOutput(raw, names), "结果 阶段 believed，未识破");
  });
});
