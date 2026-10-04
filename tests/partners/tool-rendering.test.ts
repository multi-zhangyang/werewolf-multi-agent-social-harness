import { expect, it } from "vitest";
import { highlightCode } from "../../src/components/ai-elements/code-block";

it("renders changed tool amounts even when payload length, prefix and suffix are identical", async () => {
  const before = JSON.stringify({ prefix: "a".repeat(150), amount: 1, suffix: "b".repeat(150) });
  const after = JSON.stringify({ prefix: "a".repeat(150), amount: 9, suffix: "b".repeat(150) });
  const render = (code: string) => new Promise<string>(resolve => {
    const done = (value: NonNullable<ReturnType<typeof highlightCode>>) => resolve(value.tokens.map(line => line.map(token => token.content).join("")).join("\n"));
    const cached = highlightCode(code, "json", done);
    if (cached) done(cached);
  });
  expect(await render(before)).toBe(before);
  expect(await render(after)).toBe(after);
});
