#!/usr/bin/env node
/**
 * Boots a real room against the configured providers and waits for it to
 * finish. By default every seat is randomly dealt a model from the random
 * pool configured in the model center (globalDefaults.randomPoolProfileIds);
 * without one, all enabled profiles round-robin. DEMO_MODEL_PROFILES pins an
 * explicit round-robin roster instead.
 *
 * Usage:
 *   node scripts/demo.mjs                     # run every scenario (heavy)
 *   node scripts/demo.mjs prisoners-dilemma   # run one scenario
 *   DEMO_MODEL_PROFILES=mp-a,mp-b node scripts/demo.mjs werewolf
 *   DEMO_TIMEOUT_MIN=90 node scripts/demo.mjs werewolf   # long games (9-seat werewolf runs 60-90+ min)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const API = process.env.DEMO_API ?? "http://127.0.0.1:8787";
const timeoutMinutes = Number(process.env.DEMO_TIMEOUT_MIN ?? "60");
const timeoutMs = (Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes : 60) * 60_000;
const SCENARIOS = ["prisoners-dilemma", "ultimatum-game", "trust-game", "public-goods", "beauty-contest", "sealed-bid-auction", "werewolf", "avalon", "centipede-game", "chicken-game", "stag-hunt", "negotiation-game", "liars-dice"];

const requested = process.argv.slice(2);
const targets = requested.length ? requested : SCENARIOS;
const outputDir = resolve("artifacts/transcripts");

/**
 * Model-profile ids for the seats plus how to deal them: the registry's
 * configured random pool is dealt per seat at random; anything else
 * round-robins over the resolved ids.
 */
async function resolveProfiles() {
  const forced = (process.env.DEMO_MODEL_PROFILES ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (forced.length) return { ids: forced, random: false };
  const config = await getJson("/api/model-config");
  const profiles = Array.isArray(config.modelProfiles) ? config.modelProfiles : [];
  // The public catalog is the server's admission source of truth: it contains
  // only enabled profiles whose protocol check is currently passed.
  const catalog = await getJson("/api/scenarios");
  const readyIds = new Set((catalog.models ?? []).map((entry) => entry.profileId).filter(Boolean));
  const enabled = profiles.filter((entry) => entry.enabled !== false && readyIds.has(entry.id));
  const enabledIds = new Set(enabled.map((entry) => entry.id));
  const pool = Array.isArray(config.globalDefaults?.randomPoolProfileIds)
    ? config.globalDefaults.randomPoolProfileIds.filter((id) => enabledIds.has(id))
    : [];
  if (pool.length) return { ids: pool, random: true };
  if (enabled.length) return { ids: enabled.map((entry) => entry.id), random: false };
  throw new Error("NO_MODEL_PROFILES: No enabled model has a current passed protocol check. Run npm run doctor first.");
}

async function main() {
  await mkdir(outputDir, { recursive: true });
    const catalog = await getJson("/api/scenarios");
    const { ids: profileIds, random } = await resolveProfiles();
  const config = await getJson("/api/model-config");
  const nameFor = new Map((config.modelProfiles ?? []).map((entry) => [entry.id, entry.modelId]));
  const rounds = Number(process.env.DEMO_ROUNDS ?? "3");
  let failures = 0;

  for (const [scenarioIndex, scenarioId] of targets.entries()) {
    const meta = catalog.scenarios.find((entry) => entry.id === scenarioId);
    if (!meta) {
      console.error(`[demo] unknown scenario: ${scenarioId}`);
      continue;
    }
    // Every seat gets a model profile: the registry's configured random pool
    // is dealt per seat; a forced DEMO_MODEL_PROFILES list round-robins so
    // explicit multi-model rosters keep their even coverage.
    const players = Number(process.env.DEMO_PLAYERS ?? "0");
    const minimumPlayers = process.env.DEMO_MIN_PLAYERS === "1" ? meta.playerRange?.min : undefined;
    const seatCount = players > 0 ? players : minimumPlayers ?? meta.players;
    const roster = random
      ? Array.from({ length: seatCount }, () => profileIds[Math.floor(Math.random() * profileIds.length)])
      : Array.from({ length: seatCount }, (_, index) => profileIds[(scenarioIndex + index) % profileIds.length]);
    const rosterLabels = roster.map((id) => nameFor.get(id) ?? id).join(", ");
    console.log(`[demo] starting ${scenarioId} (${rosterLabels})`);
    const created = await postJson("/api/rooms", {
      scenarioId,
      modelProfileIds: roster,
      rounds: Math.max(meta.minRounds, Math.min(rounds, meta.maxRounds)),
      mode: "ai",
      reasoningEffort: process.env.DEMO_REASONING_EFFORT ?? "high",
      ...(meta.playerRange ? { players: seatCount } : {})
    });
    const roomId = created.room.id;
    const started = Date.now();
    let room = created.room;
    let resumes = 0;
    while (room.status === "lobby" || room.status === "running" || room.status === "paused") {
      await sleep(2_000);
      room = await getJson(`/api/rooms/${roomId}`);
      // A room pauses rather than substituting an action when a seat's turn
      // comes back empty or failed (AGENTS.md §35). The demo acts as the
      // operator: resume it and let the same seat retry its activation.
      if (room.status === "paused" && resumes < 20) {
        const token = process.env.DEMO_OPERATOR_TOKEN;
        try {
          await postJson(`/api/rooms/${roomId}/resume`, {}, token);
          resumes += 1;
        } catch (error) {
          console.error(`[demo] ${scenarioId} paused and could not resume: ${error instanceof Error ? error.message : error}`);
          break;
        }
      }
      if (Date.now() - started > timeoutMs) {
        console.error(`[demo] ${scenarioId} timed out after ${Math.round(timeoutMs / 60_000)} minutes`);
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

async function getJson(path, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${API}${path}`);
      if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(2_000 * attempt);
    }
  }
  throw lastError;
}

async function postJson(path, body, token) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
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
