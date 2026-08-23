#!/usr/bin/env node
/**
 * Capture a finished room's public snapshot as a demo-style transcript.
 * Used when a demo run timed out but the room later finished on the server.
 *   node scripts/capture-transcript.mjs <roomId> [<roomId>...]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const API = process.env.DEMO_API ?? "http://127.0.0.1:8787";
const outputDir = resolve("artifacts/transcripts");
const requested = process.argv.slice(2);
if (!requested.length) {
  console.error("usage: node scripts/capture-transcript.mjs <roomId> [...]");
  process.exit(1);
}
await mkdir(outputDir, { recursive: true });
for (const roomId of requested) {
  const response = await fetch(`${API}/api/rooms/${roomId}`);
  if (!response.ok) {
    console.error(`[capture] ${roomId} -> HTTP ${response.status}`);
    continue;
  }
  const room = await response.json();
  const snap = room.snapshot ?? room;
  const file = `${outputDir}/${snap.scenarioId}-captured-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(file, JSON.stringify({
    scenarioId: snap.scenarioId,
    roomId,
    status: snap.status,
    elapsedSeconds: "n/a (captured after demo timeout)",
    world: snap
  }, null, 2));
  console.log(`[capture] ${snap.scenarioId} (${roomId.slice(0, 16)}) -> ${snap.status} | transcript: ${file}`);
}