import { Suspense, memo, useMemo } from "react";
import { Alert, Button, Card, Col, Descriptions, Empty, Flex, Progress, Row, Select, Space, Tag, type TableProps } from "antd";
import { CloudDownloadOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { type PostgameReplayFrameDto, type RedactedHarnessStepDto } from "../../server/artifactProjection";
import { countSocialStepCommits } from "../../harness/social";
import { isSafeHarnessCheckpointBoundary } from "../../harness/episodeArtifacts";
import { AgentDecisionEvidencePanel, Table, Text, type ArtifactView, type ProjectedMatchArtifact, type ProjectedSocialStep, type ReplayResponse, type ReplayFrameLoadState } from "./appShared";
import { CommitStatusTag, SchedulerTag, decorativeIcon, descriptionItems, shortId, readPendingKind, readCommandType, readSocialCommandType, readSocialPendingKind, readSocialCommitStatus, rangeLabel, countSocialSchedulerModes } from "./appInspectors";
import { CockpitChunkFallback, CompactKpi } from "./cockpitPanels";

const EMPTY_STEPS: ProjectedSocialStep[] = [];
const EMPTY_LEGACY_STEPS: RedactedHarnessStepDto[] = [];
const NATIVE_TABLE_PAGINATION = { pageSize: 10 } as const;
const LEGACY_TABLE_PAGINATION = { pageSize: 6 } as const;
const NATIVE_TABLE_LOCALE = {
  emptyText: <Empty description="尚未加载原生 social episode steps。先从运行注册表或顶部加载最近 artifact。" />
} as const;
const LEGACY_TABLE_LOCALE = {
  emptyText: <Empty description="当前 artifact 没有 legacy trajectory projection。" />
} as const;

export const TimelineWorkspace = memo(function TimelineWorkspace({
  artifact,
  selectedStepIndex,
  selectedStep,
  onSelectStep,
  onSelectReplayFrame,
  onReplay,
  onDownloadJsonl,
  onDownloadMatch,
  artifactView,
  replay,
  replayFrame,
  replayFrameCursorIndex,
  replayFrameLoadState,
  replayEnabled,
  artifactDownloadEnabled,
  busy
}: {
  artifact: ProjectedMatchArtifact | null;
  selectedStepIndex: number;
  selectedStep: ProjectedSocialStep | null;
  onSelectStep: (index: number) => void;
  onSelectReplayFrame: (index: number) => void;
  onReplay: () => void;
  onDownloadJsonl: () => void;
  onDownloadMatch: () => void;
  artifactView: ArtifactView;
  replay: ReplayResponse | null;
  replayFrame: PostgameReplayFrameDto | null;
  replayFrameCursorIndex: number | null;
  replayFrameLoadState: ReplayFrameLoadState;
  replayEnabled: boolean;
  artifactDownloadEnabled: boolean;
  busy: string | null;
}) {
  const steps = artifact?.socialEpisode.steps ?? EMPTY_STEPS;
  const legacySteps = artifact?.trajectory ?? EMPTY_LEGACY_STEPS;
  const nativeStepByTraceId = useMemo(() => new Map(steps.map((step) => [step.traceId, step])), [steps]);
  const legacyStepByTraceId = useMemo(() => new Map(legacySteps.map((step) => [step.traceId, step])), [legacySteps]);
  const selectedLegacyStep = selectedStep ? legacyStepByTraceId.get(selectedStep.traceId) ?? null : null;
  const selectedLegacyPolicyOnly =
    selectedLegacyStep?.reasonerOutput.cognitionSource === "policy" || selectedLegacyStep?.turnTrace.cognitionSource === "policy";
  const selectedLegacyDetails: Array<[string, unknown]> = selectedLegacyStep
    ? [
        ["legacy turn", selectedLegacyStep.turnIndex],
        ["cognition", selectedLegacyPolicyOnly ? "deterministic policy narration · no model call" : "model reasoner advisory"],
        ...(selectedLegacyPolicyOnly ? [] : [["model", selectedLegacyStep.model] as [string, unknown]]),
        ["command", readCommandType(selectedLegacyStep.command)],
        ...(selectedLegacyPolicyOnly ? [] : [["attempts", selectedLegacyStep.reasonerOutput.attempts ?? "n/a"] as [string, unknown]])
      ]
    : [];
  const schedulerCounts = useMemo(() => countSocialSchedulerModes(steps), [steps]);
  const { committedSteps, rejectedSteps } = useMemo(() => countSocialStepCommits(steps), [steps]);
  const replayFrameBoundaryIndexes = useMemo(
    () => steps.flatMap((_, index) => (isSafeHarnessCheckpointBoundary(steps, index) ? [index] : [])),
    [steps]
  );
  const replayFrameCursorPosition = replayFrameCursorIndex === null ? -1 : replayFrameBoundaryIndexes.indexOf(replayFrameCursorIndex);
  const canLoadSelectedReplayFrame =
    replayEnabled && artifactView === "postgame-redacted" && selectedStepIndex >= 0 && isSafeHarnessCheckpointBoundary(steps, selectedStepIndex);
  const progress = steps.length ? ((selectedStepIndex + 1) / steps.length) * 100 : 0;
  const columns: TableProps<ProjectedSocialStep>["columns"] = useMemo(() => [
    { title: "#", width: 64, render: (_, __, index) => index + 1 },
    { title: "turn", dataIndex: "turnIndex", width: 72 },
    { title: "actor", dataIndex: "actorId", render: (actorId: string) => <Text code>{actorId}</Text> },
    { title: "status", render: (_, step) => <CommitStatusTag status={readSocialCommitStatus(step)} /> },
    { title: "failure stage", render: (_, step) => step.failure?.stage ?? (step.error ? "legacy_error" : "none") },
    { title: "scheduler", render: (_, step) => <SchedulerTag mode={step.schedulerMode} /> },
    { title: "action", render: (_, step) => step.action.kind },
    { title: "command", render: (_, step) => readSocialCommandType(step) },
    { title: "messages", render: (_, step) => (step.messageSeqRange ? rangeLabel(step.messageSeqRange) : "none") },
    { title: "state", render: (_, step) => `${shortId(step.preStateHash)} -> ${shortId(step.postStateHash)}` },
    {
      title: "查看",
      fixed: "right",
      width: 72,
      render: (_, __, index) => (
        <Button type="link" size="small" aria-label={`查看原生步骤 ${index + 1}`} onClick={() => onSelectStep(index)}>
          查看
        </Button>
      )
    }
  ], [onSelectStep]);
  const legacyColumns: TableProps<RedactedHarnessStepDto>["columns"] = useMemo(() => [
    { title: "#", width: 64, render: (_, __, index) => index + 1 },
    { title: "trace", dataIndex: "traceId", render: (traceId: string) => <Text code>{shortId(traceId)}</Text> },
    { title: "actor", dataIndex: "actorId", render: (actorId: string) => <Text code>{actorId}</Text> },
    { title: "pending", render: (_, step) => readPendingKind(step) },
    { title: "command", render: (_, step) => readCommandType(step.command) },
    {
      title: "native link",
      render: (_, step) => (nativeStepByTraceId.has(step.traceId) ? <Tag color="success">linked</Tag> : <Tag color="error">missing</Tag>)
    },
    {
      title: "查看",
      fixed: "right",
      width: 72,
      render: (_, legacyStep) => {
        const index = steps.findIndex((step) => step.traceId === legacyStep.traceId);
        return (
          <Button type="link" size="small" aria-label={`查看旧轨迹步骤 ${shortId(legacyStep.traceId)}`} disabled={index < 0} onClick={() => onSelectStep(index)}>
            查看
          </Button>
        );
      }
    }
  ], [nativeStepByTraceId, onSelectStep, steps]);
  const replayFrameBoundaryOptions = useMemo(
    () =>
      replayFrameBoundaryIndexes.map((index) => {
        const step = steps[index];
        return {
          value: index,
          label: `#${index + 1} · turn ${step?.turnIndex ?? "?"} · ${readSocialCommitStatus(step ?? {})}`
        };
      }),
    [replayFrameBoundaryIndexes, steps]
  );
  const journalEntries = useMemo(
    () => artifact?.agents.flatMap((agent) => agent.social?.journal?.entries ?? []) ?? [],
    [artifact]
  );

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xxl={15}>
        <Card title="时间线">
          <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
            <Flex className="workspace-actions" justify="space-between" align="center" gap="small" wrap="wrap">
              <Tag>{artifactView}</Tag>
              <Space wrap>
              <Button
                icon={decorativeIcon(<CloudDownloadOutlined />)}
                onClick={onDownloadMatch}
                disabled={!artifact || !artifactDownloadEnabled}
                loading={busy === "download-match"}
              >
                工件 JSON
              </Button>
              <Button
                icon={decorativeIcon(<CloudDownloadOutlined />)}
                onClick={onDownloadJsonl}
                disabled={!artifact || !artifactDownloadEnabled}
                loading={busy === "download"}
              >
                JSONL
              </Button>
              <Button
                type="primary"
                icon={decorativeIcon(<PlayCircleOutlined />)}
                onClick={onReplay}
                disabled={!artifact || !replayEnabled || artifactView !== "postgame-redacted" || busy === "replay"}
                loading={busy === "replay"}
              >
                复现
              </Button>
              </Space>
            </Flex>
            <Text type="secondary">
              主时间线来自原生 social episode 执行工件；system、committed 与 rejected 步骤均为可选择、可审计证据，确定性 replay 不重新调用模型。
            </Text>
            {artifactView === "postgame-redacted" && replayEnabled ? (
              <section className="workspace-tool-block" data-testid="server-replay-cursor-controls" aria-label="服务端回放游标">
                <Space orientation="vertical" size="small" style={{ width: "100%" }}>
                  <Text strong>服务端回放游标</Text>
                  <Text type="secondary">
                    游标只接受完整原生 scheduler 边界。浏览器不会应用命令或推断状态；每次跳转都由服务端从 canonical artifact 无模型重放。
                  </Text>
                  <Space wrap>
                    <Button
                      size="small"
                      onClick={() => {
                        const previous = replayFrameBoundaryIndexes[replayFrameCursorPosition - 1];
                        if (previous !== undefined) onSelectReplayFrame(previous);
                      }}
                      disabled={replayFrameCursorPosition <= 0 || replayFrameLoadState === "loading"}
                    >
                      上一帧
                    </Button>
                    <Button
                      size="small"
                      onClick={() => {
                        const next = replayFrameBoundaryIndexes[replayFrameCursorPosition + 1];
                        if (next !== undefined) onSelectReplayFrame(next);
                      }}
                      disabled={
                        replayFrameCursorPosition < 0 ||
                        replayFrameCursorPosition >= replayFrameBoundaryIndexes.length - 1 ||
                        replayFrameLoadState === "loading"
                      }
                    >
                      下一帧
                    </Button>
                    <Select
                      aria-label="跳转服务端回放帧"
                      size="small"
                      style={{ minWidth: 220, maxWidth: "100%" }}
                      placeholder="跳转到完整原生边界"
                      value={replayFrameCursorIndex ?? undefined}
                      loading={replayFrameLoadState === "loading"}
                      onChange={(value) => onSelectReplayFrame(Number(value))}
                      options={replayFrameBoundaryOptions}
                    />
                    <Tag color={replayFrame ? "success" : "default"}>
                      {replayFrame
                        ? `frame #${replayFrame.cursor.nativeStepCount} · ${shortId(replayFrame.cursor.stateHash)}`
                        : "尚未请求服务端帧"}
                    </Tag>
                  </Space>
                </Space>
              </section>
            ) : (
              <Alert
                type="warning"
                showIcon
                title={
                  artifactView === "truth-redacted"
                    ? "真相脱敏视图不暴露原生 scheduler 游标"
                    : "当前连接没有服务端回放权限"
                }
                description={
                  artifactView === "truth-redacted"
                    ? "原生步骤序列可能反推出夜间角色节奏；该视图仅显示最终公共投影。"
                    : "Cockpit 按 /api/config capabilities 关闭 replay 和回放帧控件，不会先发出必然失败的 operator 请求。"
                }
              />
            )}
            <div className="cockpit-kpi-strip" aria-label="时间线执行摘要">
              <CompactKpi label="原生步骤" value={String(steps.length)} detail={`已选 #${selectedStepIndex + 1}`} />
              <CompactKpi label="已提交" value={String(committedSteps)} detail="环境已确认" />
              <CompactKpi label="已拒绝" value={String(rejectedSteps)} detail="保留失败证据" />
              <CompactKpi label="社会消息" value={String(artifact?.socialEpisode.messages.length ?? 0)} detail="服务端记录" />
            </div>
            <Space wrap>
              <Tag>AEC {schedulerCounts.aec}</Tag>
              <Tag color="processing">batched {schedulerCounts["aec-batched-decision"]}</Tag>
              <Tag color="warning">parallel {schedulerCounts.parallel}</Tag>
              <Tag color="default">episode {artifact?.socialEpisode.schedulerMode ?? "n/a"}</Tag>
            </Space>
            <Progress aria-label="原生步骤回放进度" percent={Math.round(progress)} />
            <Table
              rowKey="traceId"
              size="small"
              bordered
              loading={Boolean(busy?.startsWith("artifact:"))}
              columns={columns}
              dataSource={steps}
              pagination={NATIVE_TABLE_PAGINATION}
              rowSelection={{
                type: "radio",
                selectedRowKeys: selectedStep?.traceId ? [selectedStep.traceId] : []
              }}
              onRow={(_, index) => ({ onClick: () => onSelectStep(index ?? 0) })}
              locale={NATIVE_TABLE_LOCALE}
            />
            <details className="workspace-details">
              <summary>
                <Text strong>Legacy trajectory projection</Text>
                <Tag color="warning">migration/debug only</Tag>
              </summary>
              <Space orientation="vertical" size="small" style={{ width: "100%" }}>
                <Text type="secondary">
                  这是旧 checkpoint/迁移兼容投影，只包含成功的 player steps；它不是 system、失败步骤或执行顺序的真相源。
                </Text>
                <Table
                  rowKey="traceId"
                  size="small"
                  bordered
                  loading={Boolean(busy?.startsWith("artifact:"))}
                  columns={legacyColumns}
                  dataSource={legacySteps}
                  pagination={LEGACY_TABLE_PAGINATION}
                  rowSelection={{
                    type: "radio",
                    selectedRowKeys: selectedLegacyStep?.traceId ? [selectedLegacyStep.traceId] : []
                  }}
                  onRow={(legacyStep) => ({
                    onClick: () => {
                      const index = steps.findIndex((step) => step.traceId === legacyStep.traceId);
                      if (index >= 0) onSelectStep(index);
                    }
                  })}
                  locale={LEGACY_TABLE_LOCALE}
                />
              </Space>
            </details>
          </Space>
        </Card>
      </Col>
      <Col xs={24} xxl={9}>
        <Card title="Step 详情">
          {selectedStep ? (
            <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
              <Descriptions
                size="small"
                bordered
                column={1}
                items={descriptionItems([
                  ["native step", selectedStepIndex + 1],
                  ["scheduler turn", selectedStep.turnIndex],
                  ["trace", shortId(selectedStep.traceId)],
                  ["actor", selectedStep.actorId],
                  ["profile", selectedStep.profileId ?? "n/a"],
                  ["commit status", readSocialCommitStatus(selectedStep)],
                  ["failure stage", selectedStep.failure?.stage ?? (selectedStep.error ? "legacy_error" : "n/a")],
                  ["scheduler", selectedStep.schedulerMode],
                  ["batch", selectedStep.batchId ? shortId(selectedStep.batchId) : "n/a"],
                  ["batch index", selectedStep.batchIndex ?? "n/a"],
                  ["batch size", selectedStep.batchSize ?? "n/a"],
                  ["atomic", selectedStep.atomic ?? "n/a"],
                  ["resolution", selectedStep.resolutionPolicy ?? "n/a"],
                  ["pending", readSocialPendingKind(selectedStep)],
                  ["action", selectedStep.action.kind],
                  ["command", readSocialCommandType(selectedStep)],
                  ["pre hash", shortId(selectedStep.preStateHash)],
                  ["post hash", shortId(selectedStep.postStateHash)],
                  ["message seq", selectedStep.messageSeqRange ? rangeLabel(selectedStep.messageSeqRange) : "none"],
                  ["event seq", selectedStep.eventSeqRange ? rangeLabel(selectedStep.eventSeqRange) : "none"]
                ])}
              />
              <Suspense fallback={<CockpitChunkFallback label="正在加载 Agent 决策证据…" />}>
                <AgentDecisionEvidencePanel
                  nativeStep={selectedStep}
                  legacyStep={selectedLegacyStep}
                  view={artifactView}
                  journalEntries={journalEntries}
                  shortId={shortId}
                />
              </Suspense>
              {canLoadSelectedReplayFrame ? (
                <Button
                  type="primary"
                  onClick={() => onSelectReplayFrame(selectedStepIndex)}
                  loading={replayFrameLoadState === "loading" && replayFrameCursorIndex === selectedStepIndex}
                  disabled={artifactView !== "postgame-redacted" || replayFrameLoadState === "loading"}
                >
                  定位服务端回放帧
                </Button>
              ) : artifactView === "postgame-redacted" ? (
                <Alert
                  type="info"
                  showIcon
                  title="当前行仅供审计"
                  description="该行位于原子 scheduler 批次中间。请通过上方游标跳转到该批次的最终行，以避免伪造中间局面。"
                />
              ) : null}
              {selectedStep.failure || selectedStep.error ? (
                <Alert
                  showIcon
                  type="error"
                  title={selectedStep.failure?.stage ?? "Rejected native step"}
                  description={selectedStep.failure?.message ?? selectedStep.error}
                />
              ) : null}
              {selectedLegacyStep ? (
                <details className="workspace-details" open>
                  <summary>
                    <Text strong>Legacy committed projection</Text>
                    <Tag color="warning">migration/debug only</Tag>
                  </summary>
                  <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
                    <Descriptions
                      size="small"
                      column={1}
                      items={descriptionItems(selectedLegacyDetails)}
                    />
                    <section className="workspace-tool-block">
                      <Text strong>Policy arbitration</Text>
                      <Space orientation="vertical" size="small" style={{ width: "100%" }}>
                        <Text strong>{selectedLegacyStep.policyPlan.intent}</Text>
                        <Text type="secondary">{selectedLegacyStep.policyPlan.strategyTags.join(" · ") || "no strategy tags"}</Text>
                        <Tag color="warning">private arbitration evidence redacted</Tag>
                      </Space>
                    </section>
                    {selectedLegacyPolicyOnly ? (
                      <Alert
                        type="info"
                        showIcon
                        title="Deterministic policy narration · no model call"
                        description="本行由受 harness 管理的 policy 生成；没有 provider/model telemetry 可以或应当显示。"
                      />
                    ) : (
                      <section className="workspace-tool-block">
                        <Text strong>Reasoner telemetry</Text>
                        <Descriptions
                          size="small"
                          column={1}
                          items={descriptionItems([
                            ["latency", `${selectedLegacyStep.reasonerOutput.latencyMs}ms`],
                            ["prompt tokens", selectedLegacyStep.reasonerOutput.promptTokens ?? "n/a"],
                            ["completion tokens", selectedLegacyStep.reasonerOutput.completionTokens ?? "n/a"],
                            ["attempts", selectedLegacyStep.reasonerOutput.attempts ?? "n/a"]
                          ])}
                        />
                      </section>
                    )}
                  </Space>
                </details>
              ) : (
                <Alert
                  showIcon
                  type="info"
                  title="No legacy projection row"
                  description="system 与 rejected 原生步骤不会伪造 legacy committed trajectory 记录。"
                />
              )}
              {artifactView === "postgame-redacted" && replay ? (
                <details className="workspace-details" open>
                  <summary><Text strong>Replay validation</Text></summary>
                  <Descriptions
                    size="small"
                    column={1}
                    items={descriptionItems([
                      ["ok", String(Boolean(replay.summary?.ok))],
                      ["authority", replay.summary?.authority ?? "n/a"],
                      ["native steps", replay.summary?.nativeSteps ?? 0],
                      ["replayed steps", replay.summary?.replayedSteps ?? 0],
                      ["replayed batches", replay.summary?.replayedBatches ?? 0],
                      ["rejected skipped", replay.summary?.rejectedSteps ?? 0],
                      ["hash matches", String(replay.summary?.finalHashMatchesArtifact ?? replay.summary?.finalHashMatchesExpected ?? false)],
                      ["message hash matches", String(replay.summary?.messagesHashMatchesExpected ?? false)],
                      ["mismatches", replay.summary?.mismatchCount ?? 0]
                    ])}
                  />
                </details>
              ) : null}
            </Space>
          ) : (
            <Empty description="没有选中 native step。加载 artifact 后点击左侧原生执行行。" />
          )}
        </Card>
      </Col>
    </Row>
  );
});
