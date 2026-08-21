#!/usr/bin/env node
/**
 * Boots a real room against the configured providers and waits for it to
 * finish. Seats are assigned model profiles round-robin (registry first,
 * SOCIETY_MODELS fallback), so one room can pit different models against
 * each other.
 *
 * Usage:
 *   node scripts/demo.mjs                     # run every scenario (heavy)
 *   node scripts/demo.mjs prisoners-dilemma   # run one scenario
 *   DEMO_MODEL_PROFILES=mp-a,mp-b node scripts/demo.mjs werewolf
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const API = process.env.DEMO_API ?? "http://127.0.0.1:8787";
const SCENARIOS = ["prisoners-dilemma", "ultimatum-game", "trust-game", "public-goods", "beauty-contest", "sealed-bid-auction", "werewolf", "avalon", "centipede-game", "chicken-game", "stag-hunt", "negotiation-game", "liars-dice"];

const requested = process.argv.slice(2);
const targets = requested.length ? requested : SCENARIOS;
const outputDir = resolve("artifacts/transcripts");

/** Enabled model-profile ids from the registry, in catalog order. */
async function resolveProfileIds() {
  const forced = (process.env.DEMO_MODEL_PROFILES ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (forced.length) return forced;
  const config = await getJson("/api/model-config");
  const profiles = Array.isArray(config.modelProfiles) ? config.modelProfiles : [];
  const enabled = profiles.filter((entry) => entry.enabled !== false).map((entry) => entry.id);
  if (enabled.length) return enabled;
  throw new Error("NO_MODEL_PROFILES: The model registry has no enabled profiles. Configure the model center first.");
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const catalog = await getJson("/api/scenarios");
  const profileIds = await resolveProfileIds();
  const config = await getJson("/api/model-config");
  const nameFor = new Map((config.modelProfiles ?? []).map((entry) => [entry.id, entry.modelId]));
  const rounds = Number(process.env.DEMO_ROUNDS ?? "3");
  let failures = 0;

  for (const scenarioId of targets) {
    const meta = catalog.scenarios.find((entry) => entry.id === scenarioId);
    if (!meta) {
      console.error(`[demo] unknown scenario: ${scenarioId}`);
      continue;
    }
    // Every seat gets a model profile: round-robin through all enabled
    // profiles so a room can pit different models against each other.
    const players = Number(process.env.DEMO_PLAYERS ?? "0");
    const seatCount = players > 0 ? players : meta.players;
    const roster = Array.from({ length: seatCount }, (_, index) => profileIds[index % profileIds.length]);
    const rosterLabels = roster.map((id) => nameFor.get(id) ?? id).join(", ");
    console.log(`[demo] starting ${scenarioId} (${rosterLabels})`);
    const created = await postJson("/api/rooms", {
      scenarioId,
      modelProfileIds: roster,
      rounds: Math.max(meta.minRounds, Math.min(rounds, meta.maxRounds)),
      mode: "ai",
      reasoningEffort: process.env.DEMO_REASONING_EFFORT ?? "high",
      ...(players > 0 ? { players } : {})
    });
    const roomId = created.room.id;
    const started = Date.now();
    let room = created.room;
    while (room.status === "lobby" || room.status === "running" || room.status === "paused") {
      await sleep(2_000);
      room = await getJson(`/api/rooms/${roomId}`);
      if (Date.now() - started > 20 * 60_000) {
        console.error(`[demo] ${scenarioId} timed out after 20 minutes`);
        failures += 1;
        break;
      }
    }
    if (room.status !== "finished") failures += 1;
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

  if (failures) {
    console.error(`[demo] ${failures} scenario(s) failed`);
    process.exitCode = 1;
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
