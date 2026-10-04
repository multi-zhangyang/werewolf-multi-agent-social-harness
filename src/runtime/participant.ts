import type { ModelRegistry } from "../society/models/registry";
import { nativeConfiguration, runNativeAgent, NativeAgentError, type NativeOptions, type NativeTranscript } from "../agents/sdk";
import { cognitionVersion } from "../agents/cognition";
import { GeneralAgentContext, generalInstructions, generalTools } from "./agent-context";
import { characterInstructions } from "./personality";
import { decisionCase } from "./cases";
import type { Character, Participant, RunSpec, TurnContext } from "./types";

/** Every live environment uses the same official SDK executor and Responses transport. */
export function modelParticipantFactory(registry: ModelRegistry, options: NativeOptions = {}) {
  return (character: Character, spec: RunSpec, runId: string): Participant => {
    const settings: NativeOptions = { ...options, modelProfileId: spec.roster.find(s => s.characterId === character.id)?.modelProfileId ?? options.modelProfileId,
      maxTurns: spec.budgets.maxTurns,
      requestTimeoutMs: spec.cognition?.requestTimeoutMs ?? options.requestTimeoutMs };
    const configuration = { ...nativeConfiguration(registry, settings), cognitionVersion, psychology: spec.experiment.psychology,
      personality: spec.experiment.personality, execution: "staged activation; single atomic commit", instructionPolicy: "sdk-dynamic-progress" };
    return { configuration, reviewAtEpisodeEnd: spec.experiment.psychology !== "off", async turn(input: TurnContext) {
      const c = new GeneralAgentContext(input, spec, runId);
      const phase = input.appraisalOnly ? "psychology" : input.opportunity.stage.kind;
      const tuning = spec.cognition?.phases[phase];
      const activationOptions = { ...settings, reasoningEffort: tuning?.effort ?? options.reasoningEffort };
      const activationConfiguration = { ...configuration, ...nativeConfiguration(registry, activationOptions), phase };
      const capture = (transcript: NativeTranscript) => {
        for (const exchange of transcript.exchanges) {
          input.recordModelResponse?.({ inputTokens: exchange.inputTokens, outputTokens: exchange.outputTokens, durationMs: exchange.durationMs, finishReason: exchange.finishReason });
          input.recordDecisionCase?.(decisionCase(input, runId, input.appraisalOnly ? "psychology" : input.opportunity.stage.kind,
            activationConfiguration, exchange));
        }
      };
      let result;
      try {
        result = await runNativeAgent(registry, activationOptions, { name: character.name, actorId: character.id,
          sessionId: `${runId}:${character.id}:${input.opportunity.id}`, context: c,
          input: c.modelInput(), instructions: ({ context }) => [...characterInstructions(character, spec.experiment.personality), generalInstructions,
            "下面的执行进度按本次请求更新，优先于初始输入中的进度标志。普通文字或 JSON 描述不会执行工具；只调用当前实际提供的原生工具。",
            `当前执行状态：${JSON.stringify(context.executionProgress)}`].join("\n"),
          tools: error => generalTools(c, error), done: () => c.finished, signal: input.signal,
          onActivity: event => { input.recordHarnessEvent?.({ ...event, kind: event.kind, toolName: event.tool, result: event.output, phase: input.episodeReview ? "episode-review" : phase, step: c.turn });
            if (event.kind === "tool_error") input.recordToolError?.(event.tool ?? "unknown", event.message ?? "工具调用失败"); } });
      } catch (error) { if (error instanceof NativeAgentError) capture(error.transcript); throw error; }
      capture(result.transcript);
      input.signal.throwIfAborted();
      if (!input.commitActivation) throw new Error("环境未实现原子激活提交，不能执行真实行动");
      input.commitActivation(c.activation);
      return { inputTokens: result.transcript.inputTokens, outputTokens: result.transcript.outputTokens,
        text: c.activation.text, waited: c.activation.waited };
    } };
  };
}
