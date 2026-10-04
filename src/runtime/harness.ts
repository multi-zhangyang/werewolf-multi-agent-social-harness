/** Historical event shape retained for archive/UI compatibility. Execution lives in agents/sdk.ts. */
export const harnessVersion = "native-responses-v1";
export interface HarnessEvent {
  kind: "agent_start" | "agent_end" | "model_start" | "model_delta" | "model_end" | "model_error" | "tool_start" | "tool_end" | "tool_error" | "tool_rejected" | "retry";
  phase: string; attempt: number; step: number;
  toolName?: string; callId?: string; durationMs?: number; message?: string;
  input?: unknown; result?: unknown; remainingActions?: string[];
}
