import { createChat } from "@shadcn/helpers/ai-sdk";

// Official shadcn helper: fixed UI fixtures, never substituted for a model result.
export const chatFixture = createChat()
  .user("我愿意先投一点，不过这次想听你怎么打算。")
  .assistant(({ writer }) => {
    writer.text("你肯先试，我就不会让你一个人担风险。可你说的一点，到底是多少？");
    writer.tool("invest", { input: { amount: 5 } }).output({ accepted: true });
  });

export const fixtureMessages = chatFixture.get();
export function fixtureText(index: number) {
  return fixtureMessages[index].parts.filter(p => p.type === "text").map(p => p.text).join("");
}
