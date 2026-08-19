import { strict as assert } from "node:assert";
import { it } from "vitest";
import { AssociativeMemory } from "../../src/society/memory";

function check(name: string, fn: () => Promise<void> | void): void {
  it(name, fn);
}

check("remember builds promise-chain links from shared promise tags", async () => {
  const m = new AssociativeMemory();
  await m.remember({ text: "承诺投票支持林默", tags: ["林默", "承诺"], salience: 0.6, valence: 0.4, turn: 1 });
  const second = await m.remember({ text: "兑现了对林默的承诺", tags: ["林默", "承诺"], salience: 0.7, valence: 0.6, turn: 3 });
  assert.equal(second.links?.length, 1, "second memory links to the first");
  assert.equal(second.links![0].kind, "promise-chain");
});

check("contrasting valence memories link as contradicts", async () => {
  const m = new AssociativeMemory();
  await m.remember({ text: "苏遥帮我说了话", tags: ["苏遥"], salience: 0.6, valence: 0.5, turn: 1 });
  const second = await m.remember({ text: "苏遥今天投了我", tags: ["苏遥"], salience: 0.8, valence: -0.7, turn: 4 });
  assert.equal(second.links![0].kind, "contradicts");
});

check("explicit link reinforces instead of duplicating", async () => {
  const m = new AssociativeMemory();
  const a = await m.remember({ text: "第一次被背叛", tags: ["陈策"], salience: 0.9, valence: -0.8, turn: 1 });
  const b = await m.remember({ text: "第二次被背叛", tags: ["陈策"], salience: 0.9, valence: -0.8, turn: 2 });
  await m.link(a.id, b.id, "same-person");
  await m.link(a.id, b.id, "same-person");
  const listed = await m.list(10);
  const aNow = listed.find((entry) => entry.id === a.id)!;
  assert.equal(aNow.links?.filter((link) => link.toMemoryId === b.id).length, 1, "reinforcement updates weight, not count");
  assert.ok((aNow.links![0].weight ?? 0) > 0.5, "weight grew");
});