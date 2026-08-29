/**
 * Conversation director checks (AGENTS.md §13.1 / P0-03): the reply graph must
 * resolve to the ORIGINAL message's sender by stable id, mentions and replies
 * are separate pressures, scenario signals carry game-specific meaning, and
 * discussions end naturally. No model calls, no network.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { DiscussionDirector, type ConversationSignal, type DiscussionMessage, type DiscussionOptions } from "../../src/society/conversation";

const NAMES: Record<string, string> = { a1: "甲", a2: "乙", a3: "丙" };

function makeDirector(actorIds: string[], options: Partial<DiscussionOptions> = {}): DiscussionDirector {
  return new DiscussionDirector({
    actorIds,
    displayName: (id) => NAMES[id] ?? id,
    ...options
  });
}

function msg(messageId: string, senderId: string, text: string, replyTo?: string): DiscussionMessage {
  return replyTo ? { messageId, senderId, text, replyTo } : { messageId, senderId, text };
}

it("replies resolve to the ORIGINAL message's sender, not other repliers", () => {
  const director = makeDirector(["a1", "a2", "a3"]);
  director.onMessage(msg("m1", "a1", "开场发言"));
  director.onMessage(msg("m2", "a2", "回应", "m1"));
  const a1AfterFirstReply = director.urgencyFor("a1");
  assert.ok(a1AfterFirstReply > 0, "the original speaker gets reply pressure");
  director.onMessage(msg("m3", "a3", "也回应", "m1"));
  // Both replies target m1 → both must pressure a1, never a2.
  assert.ok(director.urgencyFor("a1") > a1AfterFirstReply, "a second reply to the same original keeps pressuring the original sender");
  assert.equal(director.urgencyFor("a2"), 0, "the first replier is not the reply target");
});

it("reply-to-reply chains pressure the message actually replied to", () => {
  const director = makeDirector(["a1", "a2", "a3"]);
  director.onMessage(msg("m1", "a1", "开场发言"));
  director.onMessage(msg("m2", "a2", "追问细节", "m1"));
  director.onMessage(msg("m3", "a3", "回复追问", "m2"));
  assert.ok(director.urgencyFor("a2") > 0, "replying to a reply pressures the replier");
});

it("a reply to an unknown message id raises no reply pressure and never crashes", () => {
  const director = makeDirector(["a1", "a2"]);
  director.onMessage(msg("m1", "a1", "开场"));
  director.onMessage(msg("m2", "a2", "回复一条不存在的话", "ghost-message"));
  assert.equal(director.urgencyFor("a1"), 0, "an unresolvable reply is ignored");
});

it("mention and reply are distinct pressures that hit different actors", () => {
  const director = makeDirector(["a1", "a2", "a3"]);
  // a3 mentions 甲 (a1) by name but replies to 乙 (a2)'s message.
  director.onMessage(msg("m1", "a2", "我的观点如下"));
  director.onMessage(msg("m2", "a3", "甲说得很对，但我想再听乙说", "m1"));
  assert.ok(director.urgencyFor("a1") > 0, "the mentioned actor is pressured");
  assert.ok(director.urgencyFor("a2") > 0, "the replied-to actor is pressured");
});

it("generic interrogatives pressure everyone without any game vocabulary", () => {
  const director = makeDirector(["a1", "a2", "a3"]);
  director.onMessage(msg("m1", "a1", "你们怎么想的？"));
  assert.ok(director.urgencyFor("a2") > 0, "a question invites responses");
  assert.ok(director.urgencyFor("a3") > 0);
});

it("the suggestion particle 吧 is not a question and pressures nobody", () => {
  const director = makeDirector(["a1", "a2", "a3"]);
  director.onMessage(msg("m1", "a1", "就这样吧，先听听大家的。"));
  assert.equal(director.urgencyFor("a2"), 0, "a bare statement ending in 吧 does not interrogate the table");
  assert.equal(director.urgencyFor("a3"), 0);
});

it("scenario signals raise structured pressure on their targets only", () => {
  const director = makeDirector(["a1", "a2", "a3"]);
  const accusation: ConversationSignal = {
    kind: "accusation",
    sourceActorId: "a1",
    targetActorIds: ["a2"],
    sourceMessageId: "m1"
  };
  director.onMessage(msg("m1", "a1", "我认为有内鬼"), [accusation]);
  assert.ok(director.urgencyFor("a2") > 0, "the accused actor is pressured");
  assert.equal(director.urgencyFor("a3"), 0, "uninvolved actors stay silent");
});

it("urgencyDecay option actually controls inter-wave decay", () => {
  const fastDecay = makeDirector(["a1", "a2"], { urgencyDecay: 0.9 });
  const slowDecay = makeDirector(["a1", "a2"], { urgencyDecay: 0.2 });
  fastDecay.onMessage(msg("m1", "a1", "乙，你欠我一个解释"));
  slowDecay.onMessage(msg("m1", "a1", "乙，你欠我一个解释"));
  fastDecay.endWave();
  slowDecay.endWave();
  assert.ok(fastDecay.urgencyFor("a2") > slowDecay.urgencyFor("a2"), "a higher decay keeps more pressure alive");
});

it("silence is a natural end: no pressure means the discussion closes", () => {
  const director = makeDirector(["a1", "a2"]);
  const first = director.nextWave();
  assert.deepEqual(first, ["a1", "a2"], "wave one gives everyone the floor");
  director.endWave();
  const second = director.nextWave();
  assert.deepEqual(second, [], "with nothing said, no one has a reason to speak");
  director.endWave();
  assert.equal(director.done(), true, "the discussion ends naturally");
  assert.deepEqual(director.nextWave(), [], "no further waves");
});

it("a pressure-driven discussion continues until urgency fades below threshold", () => {
  const director = makeDirector(["a1", "a2"]);
  director.nextWave();
  director.onMessage(msg("m1", "a1", "乙，解释一下"));
  director.endWave();
  assert.ok(director.nextWave().includes("a2"), "real pressure earns a speaking slot");
  director.endWave();
  for (let wave = 0; wave < 6 && !director.done(); wave += 1) director.endWave();
  assert.equal(director.done(), true, "unreinforced pressure decays away");
});

it("restore rebuilds the message index so replies still resolve", () => {
  const director = makeDirector(["a1", "a2", "a3"]);
  director.onMessage(msg("m1", "a1", "开场"));
  director.onMessage(msg("m2", "a2", "回应", "m1"));
  const restored = makeDirector(["a1", "a2", "a3"]);
  restored.restoreState(director.exportState());
  restored.onMessage(msg("m3", "a3", "再回应", "m1"));
  assert.ok(restored.urgencyFor("a1") > 0, "the index survives the checkpoint");
  assert.equal(restored.urgencyFor("a2"), 0, "and still resolves to the original sender");
});