import { mkdirSync, writeFileSync, cpSync } from "node:fs";
import { sourceHash, redact } from "../src/runtime/cases";
import { commitmentAudit } from "../src/runtime/commitment-audit";
import { initialHybridCognition } from "../src/components/interaction/cognition-settings";
import type { RunView, Catalog } from "../src/components/interaction/api";
import { loadRegistry } from "../src/society/models/registry";

const base = "http://127.0.0.1:8794";
const directory = `data/playability-${Date.now()}`; mkdirSync(directory, { recursive: true });
const hash = sourceHash();
mkdirSync(`${directory}/source`, { recursive: true }); cpSync("src/runtime", `${directory}/source/runtime`, { recursive: true }); cpSync("package-lock.json", `${directory}/source/package-lock.json`);
async function request<T>(route: string, body?: unknown, token = process.env.SOCIETY_OPERATOR_TOKEN) {
  const r = await fetch(base + route, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json(); if (!r.ok) throw new Error(data.message ?? `HTTP ${r.status}`); return data as T;
}
const catalog = await request<Catalog>("/api/v2/catalog");
const registry = loadRegistry();
const profile = registry.modelProfile(catalog.defaultModel);
if (profile?.modelId !== "apodex/apodex-1.1-mini:free" || registry.providerProfile(profile.providerProfileId)?.baseURL.replace(/\/$/, "") !== "https://api.cardinalize.com/v1") throw new Error("Default model is not the requested Cardinalize model");
const [human, ai] = catalog.characters.slice(0, 2);
const input = { scenario: "trust-game", trustProtocol: "pledge-repair", mode: "experiment", worldId: "playability-v7", rounds: 2,
  roster: [{ characterId: human.id, human: true, modelProfileId: catalog.defaultModel }, { characterId: ai.id, modelProfileId: catalog.defaultModel }],
  cognition: initialHybridCognition, budgets: { discussionTurns: 2, maxTurns: 4, humanTimeoutMs: 300000 },
  experiment: { psychology: "hybrid", personality: "full", relationshipMemory: true, speaking: "round-robin" },
  psychologySetup: { [ai.id]: { motivation: "gain", emotion: "calm", intensity: .5, relationship: { targetId: human.id, willingness: .5, competence: .5 }, objective: "希望对方愿意投入，同时在合法范围内尽量增加自己的累计积分；是否隐瞒打算、守约或改变计划由你决定。" } },
};
writeFileSync(`${directory}/manifest.json`, JSON.stringify({ sourceHash: hash, input, design: "One full two-round run. Human inputs are scripted UI/API smoke-test actions; only the opponent uses the configured live model. Not a personality-effect study." }, null, 2));
const created = await request<{ run: RunView; ownerToken: string; playerTokens: Record<string, string> }>("/api/v2/runs", input);
const started = Date.now(); let lastPhase = ""; const submitted = new Set<string>();
console.log(JSON.stringify({ directory, runId: created.run.id, sourceHash: hash }));
try {
  while (true) {
    const run = await request<RunView>(`/api/v2/runs/${created.run.id}?view=research`, undefined, created.ownerToken);
    const phase = `${run.world.round}:${run.world.phase}`;
    if (phase !== lastPhase) { console.log(JSON.stringify({ phase, elapsedSeconds: Math.round((Date.now() - started) / 1000) })); lastPhase = phase; }
    if (!["running", "paused"].includes(run.status)) break;
    if (Date.now() - started > 900000) { await request(`/api/v2/runs/${run.id}/control`, { action: "stop" }, created.ownerToken); throw new Error("Probe exceeded 15 minute limit"); }
    const opportunity = run.opportunities.find(o => o.actorId === human.id && !submitted.has(o.id));
    if (opportunity) {
      submitted.add(opportunity.id);
      const action = opportunity.actions[0];
      const name = action?.name ?? "speak";
      const amount = name === "invest" ? 6 : name === "pledge_return" ? 50 : name === "return_funds" ? Math.floor((run.world.investment ?? 0) * 1.5) : 0;
      await request(`/api/v2/runs/${run.id}/actions`, { opportunityId: opportunity.id, action: name, input: action ? { amount } : { text: "我会看承诺和实际结算，再决定之后怎么合作。" } }, created.playerTokens[human.id]);
    }
    await new Promise(resolve => setTimeout(resolve, 700));
  }
} finally {
  const run = await request<RunView>(`/api/v2/runs/${created.run.id}?view=research`, undefined, created.ownerToken);
  const receipts = run.events.filter(e => e.text === "model-response");
  const report = redact({ sourceHash: hash, runId: run.id, status: run.status, durationMs: Date.now() - started, humanInputs: submitted.size, modelResponses: receipts.length,
    inputTokens: receipts.reduce((n, e) => n + Number(e.data.inputTokens ?? 0), 0), outputTokens: receipts.reduce((n, e) => n + Number(e.data.outputTokens ?? 0), 0),
    truncations: receipts.filter(e => e.data.outputError === "truncated").length,
    errors: run.events.filter(e => e.data.error || e.data.toolError), commitments: commitmentAudit(run.events), scores: run.world.scores });
  writeFileSync(`${directory}/run.json`, JSON.stringify(redact(run), null, 2));
  writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
