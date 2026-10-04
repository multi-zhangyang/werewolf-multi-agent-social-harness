import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const directory = path.resolve("data", "general-agent-research"); mkdirSync(directory, { recursive: true });
const queries = [
  "EMA computational model emotion appraisal coping Gratch Marsella 2009 desirability controllability likelihood",
  "Generative Agents Interactive Simulacra Human Behavior memory reflection planning 2304.03442 Reflexion verbal reinforcement learning 2303.11366",
  "LLM agents strategic games opponent modeling imperfect information bluffing cross game generalization evaluation",
];
if (!process.env.EXA_API_KEY) throw new Error("EXA_API_KEY unavailable");
const results = await Promise.allSettled(queries.map(async (query, index) => {
  const response = await fetch("https://api.exa.ai/search", { method: "POST", signal: AbortSignal.timeout(45000),
    headers: { "content-type": "application/json", "x-api-key": process.env.EXA_API_KEY! },
    body: JSON.stringify({ query, type: "auto", numResults: 5, contents: { text: { maxCharacters: 5000 } } }) });
  const result = await response.json();
  if (!response.ok) throw new Error(`Exa returned ${response.status}`);
  writeFileSync(path.join(directory, `search-${index + 1}.json`), JSON.stringify({ query, retrievedAt: new Date().toISOString(), result }, null, 2));
  return { query, sources: result.results.map((item: { title: string; url: string; text?: string }) => ({ title: item.title, url: item.url, excerpt: item.text?.slice(0, 600) })) };
}));
console.log(JSON.stringify(results.map(result => result.status === "fulfilled" ? result.value : { error: String(result.reason) }), null, 2));
