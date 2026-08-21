import type express from "express";
import { z } from "zod";
import type { RoomCheckpoint } from "../../society/persistence";
import { SCENARIO_METADATA } from "../../society/scenarios";
import { requireGlobalOperator } from "../auth";
import type { ServerContext } from "../context";

const roomIdsSchema = z.array(z.string().trim().min(1).max(160)).min(1).max(200);
const scenarioIds = Object.keys(SCENARIO_METADATA) as [keyof typeof SCENARIO_METADATA, ...(keyof typeof SCENARIO_METADATA)[]];
const crossPlayPlanSchema = z.object({
  opponentPoolVersion: z.string().trim().min(1).max(160),
  scenarioIds: z.array(z.enum(scenarioIds)).min(1).max(scenarioIds.length),
  strategyProfileSnapshotIds: z.array(z.string().trim().min(1).max(180)).min(2).max(64).optional(),
  repetitions: z.number().int().min(1).max(8).default(1),
  roundsByScenario: z.record(z.enum(scenarioIds), z.number().int().min(1).max(20)).optional(),
  requestedReasoningEffort: z.enum(["xhigh", "high", "provider-default"]).default("high"),
  budget: z.object({
    maxRuns: z.number().int().min(1).max(400).default(120),
    maxConcurrentRooms: z.number().int().min(1).max(8).default(1),
    maxAgentActivations: z.number().int().min(1).max(100_000).default(10_000),
    maxTotalTokens: z.number().int().min(1_000).max(1_000_000_000).default(20_000_000),
    maxWallTimeMs: z.number().int().min(60_000).max(86_400_000).default(21_600_000)
  }).strict().default({
    maxRuns: 120,
    maxConcurrentRooms: 1,
    maxAgentActivations: 10_000,
    maxTotalTokens: 20_000_000,
    maxWallTimeMs: 21_600_000
  })
}).strict();

export function registerSocialTruthRoutes(app: express.Express, context: ServerContext): void {
  app.get("/api/social-truth", (request, response) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    response.json(context.socialTruth.snapshot());
  });

  app.post("/api/social-truth/opponent-pools", (request, response, next) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    try {
      const input = z.object({ roomIds: roomIdsSchema }).strict().parse(request.body);
      const pool = context.socialTruth.freezeOpponentPool(loadCheckpoints(context, input.roomIds));
      response.status(201).json({ opponentPool: pool });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/social-truth/evaluations", (request, response, next) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    try {
      const input = z.object({
        roomIds: roomIdsSchema,
        opponentPoolVersion: z.string().trim().min(1).max(160)
      }).strict().parse(request.body);
      const evaluation = context.socialTruth.compileCrossPlayEvaluation(
        loadCheckpoints(context, input.roomIds),
        input.opponentPoolVersion
      );
      response.status(201).json({ evaluation });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/social-truth/cross-play-plans", (request, response, next) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    try {
      const input = crossPlayPlanSchema.parse(request.body);
      const plan = context.crossPlay.createAndStart(input);
      response.status(202).json({ plan });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/social-truth/cross-play-plans/:planId/cancel", (request, response, next) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    try {
      response.json({ plan: context.crossPlay.cancel(request.params.planId) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/social-truth/meta-strategies", (request, response, next) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    try {
      const input = z.object({
        evaluationId: z.string().trim().min(1).max(180),
        iterations: z.number().int().min(10).max(100_000).default(2_000)
      }).strict().parse(request.body);
      const metaStrategy = context.socialTruth.selectMetaStrategy(input.evaluationId, input.iterations);
      response.status(201).json({ metaStrategy });
    } catch (error) {
      next(error);
    }
  });
}

function loadCheckpoints(context: ServerContext, roomIds: string[]): RoomCheckpoint[] {
  return [...new Set(roomIds)].map((roomId) => {
    const checkpoint = context.archive.load(roomId);
    if (!checkpoint) throw new Error(`ROOM_ARCHIVE_NOT_FOUND: '${roomId}'.`);
    return checkpoint;
  });
}
