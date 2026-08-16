#!/usr/bin/env node
/**
 * Boots a real room against the configured provider and waits for it to finish.
 * Usage:
 *   node scripts/demo.mjs                     # run every scenario (heavy)
 *   node scripts/demo.mjs prisoners-dilemma   # run one scenario
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const API = process.env.DEMO_API ?? "http://127.0.0.1:8787";
const SCENARIOS = ["prisoners-dilemma", "ultimatum-game", "trust-game", "public-goods", "beauty-contest", "sealed-bid-auction", "werewolf", "avalon", "centipede-game", "chicken-game", "stag-hunt"];
const MODELS = (process.env.SOCIETY_MODELS ?? "your-model")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const requested = process.argv.slice(2);
const targets = requested.length ? requested : SCENARIOS;
const outputDir = resolve("artifacts/transcripts");

async function main() {
  await mkdir(outputDir, { recursive: true });
  const catalog = await getJson("/api/scenarios");
  const rounds = Number(process.env.DEMO_ROUNDS ?? "3");
  for (const scenarioId of targets) {
    const meta = catalog.scenarios.find((entry) => entry.id === scenarioId);
    if (!meta) {
      console.error(`[demo] unknown scenario: ${scenarioId}`);
      continue;
    }
    const modelCount = Math.min(meta.players, MODELS.length);
    const models = Array.from({ length: modelCount }, (_, index) => MODELS[index]);
    console.log(`[demo] starting ${scenarioId} (${models.join(", ")})`);
    const created = await postJson("/api/rooms", {
      scenarioId,
      models,
      rounds: Math.max(meta.minRounds, Math.min(rounds, meta.maxRounds)),
      mode: "ai",
      reasoningEffort: "low"
    });
    const roomId = created.room.id;
    const started = Date.now();
    let room = created.room;
    while (room.status === "lobby" || room.status === "running" || room.status === "paused") {
      await sleep(2_000);
      room = await getJson(`/api/rooms/${roomId}`);
      if (Date.now() - started > 20 * 60_000) {
        console.error(`[demo] ${scenarioId} timed out after 20 minutes`);
        break;
      }
    }
    const elapsed = Math.round((Date.now() - started) / 1_000);
    const transcript = {
      scenarioId,
      roomId,
      status: room.status,
      elapsedSeconds: elapsed,
      world: room.world
    };
    const file = `${outputDir}/${scenarioId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    await writeFile(file, JSON.stringify(transcript, null, 2));
    const messages = room.world.messages.length;
    const log = room.world.log.length;
    const finalAgents = room.participants.map((participant) => `${participant.profile.displayName}=${participant.score ?? "-"}`).join(", ");
    console.log(`[demo] ${scenarioId} -> ${room.status} in ${elapsed}s (messages=${messages}, log=${log})`);
    console.log(`       ${finalAgents}`);
    console.log(`       transcript: ${file}`);
  }
}

async function getJson(path) {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`POST ${path} -> ${response.status} ${payload?.message ?? ""}`);
  return payload;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

main().catch((error) => {
  console.error("[demo] failed:", error);
  process.exitCode = 1;
});
