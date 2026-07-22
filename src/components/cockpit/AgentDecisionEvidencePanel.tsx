import { Alert, Card, Descriptions, Flex, Steps, Tag, Typography } from "antd";
import type { RedactedHarnessStepDto, RedactedSocialStepDto } from "../../server/artifactProjection";

const { Text } = Typography;

export type AgentDecisionEvidenceAvailability = "trace-linked-compatibility" | "native-only";

/**
 * A deliberately narrow, presentation-only projection of a recorded decision.
 *
 * This selector whitelists server-projected fields rather than forwarding the
 * source records into the component.  Private observations, memory excerpts,
 * reasoner content, action payloads, policy targets, candidate arbitration,
 * provider telemetry, and metadata must never become UI evidence merely
 * because an upstream DTO contains an unexpected field.
 */
export interface AgentDecisionEvidenceView {
  availability: AgentDecisionEvidenceAvailability;
  traceId: string;
  actorId: string;
  pendingKind: string;
  actionKind: string;
  schedulerMode: string;
  batch: {
    id?: string;
    index?: number;
    size?: number;
    atomic?: boolean;
    resolutionPolicy?: string;
  };
  policy?: {
    name: string;
    confidence: number;
    strategyTags: string[];
  };
  arbitration?: {
    version: string;
    arbitrator: "default-score-arbitrator" | "custom";
    candidateCount: number;
    decisionRule: "highest_final_score_then_candidate_id" | "custom";
    selectedCandidateOrdinal?: number;
    selectedCandidateSource?: string;
    candidates: Array<{
      ordinal: number;
      source: string;
      kind: string;
      selected: boolean;
      baseScore?: number;
      utilityScore?: number;
      socialScore?: number;
      riskPenalty?: number;
      legalityScore?: number;
      finalScore?: number;
      scoreContributionCount: number;
      evidenceCount: number;
      messageCount: number;
    }>;
  };
  cognition?:
    | { source: "policy" }
    | {
        source: "reasoner";
        model: string;
        latencyMs: number;
        promptTokens?: number;
        completionTokens?: number;
        attempts?: number;
      };
  proposal: {
    commandType: string;
    messageDraftCount: number;
  };
  receipt: {
    status: string;
    failureStage?: string;
    decisionStateHash?: string;
    preStateHash?: string;
    postStateHash?: string;
    actorSnapshotsHashAfterStep?: string;
  };
}

/** A content-free journal row associated with this exact actor trace. */
export interface DecisionJournalEvidence {
  journalSeq: number;
  turnIndex?: number;
  store: string;
  mutationKind: string;
  subjectId?: string;
  evidenceCount: number;
  messageSeqRange?: [number, number];
  eventSeqRange?: [number, number];
}

/**
 * Build a trace-local journal projection from server-projected agent state.
 * The input is intentionally `unknown`: this helper must whitelist the
 * redaction-safe identity fields and discard all mutation summaries, metadata,
 * raw evidence descriptions, beliefs, and memory content.
 */
export function buildDecisionJournalEvidence(entries: unknown, actorId: string, traceId: string): DecisionJournalEvidence[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .flatMap((entry) => {
      if (!isRecord(entry) || entry.agentId !== actorId || entry.traceId !== traceId) return [];
      const journalSeq = finiteNumber(entry.journalSeq);
      const store = boundedString(entry.store);
      const mutationKind = boundedString(entry.mutationKind);
      if (journalSeq === undefined || !store || !mutationKind) return [];
      return [
        {
          journalSeq,
          turnIndex: finiteNumber(entry.turnIndex),
          store,
          mutationKind,
          subjectId: boundedString(entry.subjectId),
          evidenceCount: Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs.length : 0,
          messageSeqRange: integerRange(entry.messageSeqRange),
          eventSeqRange: integerRange(entry.eventSeqRange)
        }
      ];
    })
    .sort((left, right) => left.journalSeq - right.journalSeq);
}

export function buildAgentDecisionEvidenceView(
  nativeStep: RedactedSocialStepDto,
  legacyStep: RedactedHarnessStepDto | null | undefined
): AgentDecisionEvidenceView {
  const linkedLegacyStep = legacyStep?.traceId === nativeStep.traceId ? legacyStep : undefined;
  return {
    availability: linkedLegacyStep ? "trace-linked-compatibility" : "native-only",
    traceId: nativeStep.traceId,
    actorId: nativeStep.actorId,
    pendingKind: nativeStep.pendingAction.kind,
    actionKind: nativeStep.action.kind,
    schedulerMode: nativeStep.schedulerMode,
    batch: {
      id: nativeStep.batchId,
      index: nativeStep.batchIndex,
      size: nativeStep.batchSize,
      atomic: nativeStep.atomic,
      resolutionPolicy: nativeStep.resolutionPolicy
    },
    policy: linkedLegacyStep
      ? {
          name: linkedLegacyStep.policyPlan.policyName,
          confidence: linkedLegacyStep.policyPlan.confidence,
          strategyTags: [...linkedLegacyStep.policyPlan.strategyTags]
        }
      : undefined,
    arbitration: arbitrationEvidence(linkedLegacyStep?.actionArbitration),
    cognition: cognitionEvidence(linkedLegacyStep),
    proposal: {
      commandType: nativeStep.action.command.type,
      messageDraftCount: nativeStep.action.messages?.length ?? 0
    },
    receipt: {
      status: readCommitStatus(nativeStep),
      failureStage: nativeStep.failure?.stage ?? (nativeStep.error ? "legacy_error" : undefined),
      decisionStateHash: nativeStep.decisionStateHash,
      preStateHash: nativeStep.preStateHash,
      postStateHash: nativeStep.postStateHash,
      actorSnapshotsHashAfterStep: nativeStep.actorSnapshotsHashAfterStep
    }
  };
}

export function AgentDecisionEvidencePanel({
  nativeStep,
  legacyStep,
  view,
  journal = [],
  shortId
}: {
  nativeStep: RedactedSocialStepDto;
  legacyStep?: RedactedHarnessStepDto | null;
  view: "postgame-redacted" | "truth-redacted";
  journal?: readonly DecisionJournalEvidence[];
  shortId: (value?: string | null) => string;
}) {
  if (view !== "postgame-redacted") {
    return (
      <Card size="small" className="agent-decision-evidence-panel" data-testid="agent-decision-evidence-panel" title="Agent 决策证据链">
        <Alert
          type="info"
          showIcon
          message="公开真相脱敏视图不暴露 agent 决策链"
          description="该视图不从消息、收件人或 scheduler cadence 推断 private observation、reasoner、policy、memory 或隐藏角色信息。"
        />
      </Card>
    );
  }
  const evidence = buildAgentDecisionEvidenceView(nativeStep, legacyStep);
  const hasLinkedCompatibilityEvidence = evidence.availability === "trace-linked-compatibility";
  const receiptColor = evidence.receipt.status === "committed" ? "success" : "error";

  return (
    <Card
      size="small"
      className="agent-decision-evidence-panel"
      data-testid="agent-decision-evidence-panel"
      title="Agent 决策证据链"
      extra={<Tag color={hasLinkedCompatibilityEvidence ? "processing" : "default"}>{hasLinkedCompatibilityEvidence ? "trace-linked evidence" : "native-only"}</Tag>}
    >
      <Flex vertical gap="middle">
        <Text type="secondary">
          这是一次已记录的 harness 生命周期投影：reasoner 和 policy 只能提出候选；只有环境 receipt 才能决定 actor 状态是否持久化。
        </Text>

        {!hasLinkedCompatibilityEvidence ? (
          <Alert
            type="info"
            showIcon
            message="没有可链接的 compatibility decision evidence"
            description="system 或 rejected native step 不会伪造 policy / reasoner 记录。请不要从缺失记录推断模型是否思考、记忆了什么或选择了目标。"
          />
        ) : null}

        <Steps
          size="small"
          direction="vertical"
          className="agent-decision-evidence-panel__steps"
          items={[
            {
              title: "1. Scoped observation",
              description: (
                <Descriptions
                  size="small"
                  column={1}
                  items={descriptionItems([
                    ["pending action", evidence.pendingKind],
                    ["native action", evidence.actionKind],
                    ["scheduler", evidence.schedulerMode],
                    ["trace", shortId(evidence.traceId)]
                  ])}
                />
              )
            },
            {
              title: "2. Private state & memory boundary",
              description: (
                <Text type="secondary">
                  观察内容、beliefs、关系原始证据、memory retrieval 和记忆摘录均属于 private actor state；当前服务端投影只证明此阶段受 harness 管理，故意不在浏览器展示或重算。
                </Text>
              )
            },
            {
              title: "3. Optional reasoner advisory",
              description: evidence.cognition?.source === "policy" ? (
                <Text type="secondary">
                  Deterministic policy narration · no model call。此 actor 没有调用 optional model reasoner；policy 仍由 harness 管理，并且环境 receipt 才能提交结果。
                </Text>
              ) : evidence.cognition ? (
                <Descriptions
                  size="small"
                  column={1}
                  items={descriptionItems([
                    ["model", evidence.cognition.model],
                    ["latency", `${evidence.cognition.latencyMs}ms`],
                    ["prompt tokens", evidence.cognition.promptTokens ?? "n/a"],
                    ["completion tokens", evidence.cognition.completionTokens ?? "n/a"],
                    ["attempts", evidence.cognition.attempts ?? "n/a"]
                  ])}
                />
              ) : (
                <Text type="secondary">此 native record 没有可安全链接的 reasoner telemetry。</Text>
              )
            },
            {
              title: "4. Policy & arbitration boundary",
              description: evidence.policy || evidence.arbitration ? (
                <Flex vertical gap="small">
                  {evidence.policy ? (
                    <>
                      <Descriptions
                        size="small"
                        column={1}
                        items={descriptionItems([
                          ["policy", evidence.policy.name],
                          ["confidence", evidence.policy.confidence]
                        ])}
                      />
                      <Flex wrap="wrap" gap={4}>
                        {evidence.policy.strategyTags.length ? evidence.policy.strategyTags.map((tag) => <Tag key={tag}>{tag}</Tag>) : <Tag>no strategy tags</Tag>}
                      </Flex>
                    </>
                  ) : (
                    <Text type="secondary">没有可链接的 policy record。</Text>
                  )}
                  {evidence.arbitration ? (
                    <div className="agent-decision-evidence-panel__arbitration" data-testid="agent-action-arbitration">
                      <Flex wrap="wrap" gap={4} className="agent-decision-evidence-panel__arbitration-summary">
                        <Tag color="processing">{evidence.arbitration.candidateCount} candidates</Tag>
                        <Tag color="purple">selected · {evidence.arbitration.selectedCandidateSource ?? "unknown"}</Tag>
                        <Tag>{evidence.arbitration.arbitrator}</Tag>
                        <Tag>{evidence.arbitration.decisionRule}</Tag>
                        <Tag color="warning">targets · reasons · evidence ids redacted</Tag>
                      </Flex>
                      <div className="agent-decision-evidence-panel__candidate-grid">
                        {evidence.arbitration.candidates.map((candidate) => (
                          <div
                            key={candidate.ordinal}
                            className={`agent-decision-evidence-panel__candidate${candidate.selected ? " is-selected" : ""}`}
                            data-testid="agent-action-candidate"
                          >
                            <Flex justify="space-between" align="center" gap={8} wrap="wrap">
                              <Flex gap={4} wrap="wrap">
                                <Tag>#{candidate.ordinal + 1}</Tag>
                                <Tag color={candidate.source === "reasoner" ? "geekblue" : "default"}>{candidate.source}</Tag>
                                <Tag>{candidate.kind}</Tag>
                                {candidate.selected ? <Tag color="success">selected</Tag> : null}
                              </Flex>
                              <Text strong>final {formatCandidateScore(candidate.finalScore)}</Text>
                            </Flex>
                            <Text type="secondary" className="agent-decision-evidence-panel__candidate-metrics">
                              base {formatCandidateScore(candidate.baseScore)} · utility {formatCandidateScore(candidate.utilityScore)} · social {formatCandidateScore(candidate.socialScore)} · legality {formatCandidateScore(candidate.legalityScore)} · risk {formatCandidateScore(candidate.riskPenalty)}
                            </Text>
                            <Text type="secondary">
                              {candidate.messageCount} message drafts · {candidate.evidenceCount} evidence refs · {candidate.scoreContributionCount} score contributions
                            </Text>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <Text type="secondary">该兼容记录没有 action-candidate arbitration；不从最终命令反推候选集合。</Text>
                  )}
                </Flex>
              ) : (
                <Text type="secondary">没有可链接的 policy record；不把 native action 当成 policy 内部状态。</Text>
              )
            },
            {
              title: "5. Proposed social action",
              description: (
                <Descriptions
                  size="small"
                  column={1}
                  items={descriptionItems([
                    ["encoded command", evidence.proposal.commandType],
                    ["message drafts", evidence.proposal.messageDraftCount],
                    ["batch", formatBatch(evidence.batch, shortId)]
                  ])}
                />
              )
            },
            {
              title: "6. Environment receipt",
              description: (
                <Flex vertical gap="small">
                  <Tag color={receiptColor}>{evidence.receipt.status}</Tag>
                  <Descriptions
                    size="small"
                    column={1}
                    items={descriptionItems([
                      ["failure stage", evidence.receipt.failureStage ?? "none"],
                      ["decision hash", shortId(evidence.receipt.decisionStateHash)],
                      ["pre-state hash", shortId(evidence.receipt.preStateHash)],
                      ["post-state hash", shortId(evidence.receipt.postStateHash)],
                      ["actor snapshot hash", shortId(evidence.receipt.actorSnapshotsHashAfterStep)]
                    ])}
                  />
                  <Text type="secondary">
                    {evidence.receipt.status === "committed"
                      ? "环境已接受 action；该 receipt 才允许 actor staged state 成为 durable canonical state。"
                      : "环境未接受 action；任何 staged actor state 必须丢弃，不能由 UI 或 replay 补写。"}
                  </Text>
                </Flex>
              )
            },
            {
              title: "7. Post-receipt durable social state",
              description:
                evidence.receipt.status !== "committed" ? (
                  <Text type="secondary">拒绝 receipt 不能写入 durable journal；UI 不会把 staged policy、reasoner 或 private state 伪装为已提交的社会状态。</Text>
                ) : journal.length ? (
                  <Flex vertical gap={4}>
                    <Text type="secondary">以下是与该 actor/trace 精确关联的已脱敏 journal identity；不显示 mutation before/after、metadata 或 evidence description。</Text>
                    <Flex wrap="wrap" gap={4}>
                      {journal.map((entry) => (
                        <Tag key={`${entry.journalSeq}-${entry.store}-${entry.mutationKind}`}>
                          #{entry.journalSeq} · {entry.store}/{entry.mutationKind} · {entry.subjectId ?? "no subject"} · evidence {entry.evidenceCount}
                        </Tag>
                      ))}
                    </Flex>
                  </Flex>
                ) : (
                  <Text type="secondary">该 committed trace 没有可展示的 social journal row；这不代表 actor 没有 private state，也不允许浏览器推断缺失内容。</Text>
                )
            }
          ]}
        />
      </Flex>
    </Card>
  );
}

function descriptionItems(values: Array<[string, unknown]>) {
  return values.map(([label, value]) => ({ key: label, label, children: String(value) }));
}

function formatBatch(
  batch: AgentDecisionEvidenceView["batch"],
  shortId: (value?: string | null) => string
): string {
  if (!batch.id) return "single-step";
  const position = batch.index === undefined || batch.size === undefined ? "n/a" : `${batch.index + 1}/${batch.size}`;
  return `${shortId(batch.id)} · ${position} · ${batch.atomic ? "atomic" : "non-atomic"} · ${batch.resolutionPolicy ?? "n/a"}`;
}

function readCommitStatus(step: RedactedSocialStepDto): string {
  if (step.commitStatus) return step.commitStatus;
  return step.failure || step.error ? "rejected" : "committed";
}

function cognitionEvidence(legacyStep: RedactedHarnessStepDto | undefined): AgentDecisionEvidenceView["cognition"] {
  if (!legacyStep) return undefined;
  const source = legacyStep.reasonerOutput.cognitionSource ?? legacyStep.turnTrace.cognitionSource ?? "reasoner";
  if (source === "policy") return { source };
  return {
    source,
    model: legacyStep.model,
    latencyMs: legacyStep.reasonerOutput.latencyMs,
    promptTokens: legacyStep.reasonerOutput.promptTokens,
    completionTokens: legacyStep.reasonerOutput.completionTokens,
    attempts: legacyStep.reasonerOutput.attempts
  };
}

function arbitrationEvidence(value: unknown): AgentDecisionEvidenceView["arbitration"] {
  if (!isRecord(value) || !Array.isArray(value.candidates)) return undefined;
  const candidateCount = nonNegativeInteger(value.candidateCount);
  const version = boundedString(value.version);
  if (candidateCount === undefined || !version) return undefined;
  const candidates = value.candidates.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const ordinal = nonNegativeInteger(candidate.ordinal);
    const source = boundedString(candidate.source);
    const kind = boundedString(candidate.kind);
    const scoreContributionCount = nonNegativeInteger(candidate.scoreContributionCount);
    const evidenceCount = nonNegativeInteger(candidate.evidenceCount);
    const messageCount = nonNegativeInteger(candidate.messageCount);
    if (
      ordinal === undefined ||
      !source ||
      !kind ||
      scoreContributionCount === undefined ||
      evidenceCount === undefined ||
      messageCount === undefined
    ) return [];
    return [{
      ordinal,
      source,
      kind,
      selected: candidate.selected === true,
      baseScore: finiteNumber(candidate.baseScore),
      utilityScore: finiteNumber(candidate.utilityScore),
      socialScore: finiteNumber(candidate.socialScore),
      riskPenalty: finiteNumber(candidate.riskPenalty),
      legalityScore: finiteNumber(candidate.legalityScore),
      finalScore: finiteNumber(candidate.finalScore),
      scoreContributionCount,
      evidenceCount,
      messageCount
    }];
  });
  if (candidates.length !== candidateCount) return undefined;
  const arbitrator = value.arbitrator === "default-score-arbitrator" ? value.arbitrator : "custom";
  const decisionRule = value.decisionRule === "highest_final_score_then_candidate_id"
    ? value.decisionRule
    : "custom";
  return {
    version,
    arbitrator,
    candidateCount,
    decisionRule,
    selectedCandidateOrdinal: nonNegativeInteger(value.selectedCandidateOrdinal),
    selectedCandidateSource: boundedString(value.selectedCandidateSource),
    candidates
  };
}

function formatCandidateScore(value: number | undefined): string {
  return value === undefined ? "n/a" : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined;
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 160 ? value : undefined;
}

function integerRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const start = finiteNumber(value[0]);
  const end = finiteNumber(value[1]);
  return start !== undefined && end !== undefined && Number.isInteger(start) && Number.isInteger(end) ? [start, end] : undefined;
}
