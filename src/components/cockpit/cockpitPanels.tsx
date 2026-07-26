import { Suspense, memo, useMemo } from "react";
import { Alert, Button, Card, Descriptions, Flex, Form, Input, Layout, Select, Space, Tag } from "antd";
import { CheckCircleOutlined, ExperimentOutlined, EyeInvisibleOutlined, TeamOutlined, WarningOutlined } from "@ant-design/icons";
import { type MatchComparisonArtifact } from "../../harness/matchComparisonView";
import { DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER, WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS } from "../../harness/types";
import { countSocialStepCommits } from "../../harness/social";
import { type LiveMatchProjection } from "./werewolfLiveProjection";
import { WerewolfLiveBoard, Header, Content, Text, Title, type ArtifactView, type ProjectedMatchArtifact, type MatchRecord, type ReplayResponse } from "./appShared";
import { decorativeIcon, descriptionItems, isPositiveIntegerText, shortId } from "./appInspectors";

/**
 * Separate running-match presentation for a public spectator. It intentionally
 * receives neither MatchRecord nor artifact/operator controls: an ephemeral
 * live table is not a replay, checkpoint, config, model roster, or execution
 * progress authority. Operators may exit back to the research cockpit without
 * cancelling the server-side harness run.
 */
export function LiveSpectatorShell({
  projection,
  pollError,
  onExit
}: {
  projection: LiveMatchProjection | null;
  pollError: string | null;
  onExit: () => void;
}) {
  return (
    <>
      <a
        className="skip-to-workspace"
        href="#workspace-main"
        onClick={() => {
          window.requestAnimationFrame(() => document.getElementById("workspace-main")?.focus());
        }}
      >
        跳至实时观战内容
      </a>
      <Layout style={{ minWidth: 0, minHeight: "100vh" }} data-testid="live-spectator-shell">
        <Header style={{ height: "auto", padding: "16px 20px", borderBlockEnd: "1px solid #e3e8f2" }}>
          <Flex align="center" justify="space-between" gap="middle" wrap="wrap">
            <Flex vertical gap={4}>
              <Space size={8}>
                <EyeInvisibleOutlined style={{ color: "#3558d6" }} />
                <Title level={1} style={{ margin: 0, fontSize: 20 }}>
                  实时公开观战
                </Title>
              </Space>
              <Text type="secondary">
                领域适配器公开投影 · 只消费服务端已提交边界；终局后才切换到记录工件。浏览器不是执行权威。
              </Text>
            </Flex>
            <Space size={6} wrap>
              <Tag color="blue">spectator view</Tag>
              <Tag color={projection?.lifecycle === "running" ? "processing" : projection?.lifecycle === "failed" ? "error" : "default"}>
                {projection?.lifecycle === "running" ? "live" : projection?.lifecycle ?? "connecting"}
              </Tag>
              <Button
                data-testid="live-spectator-exit"
                onClick={onExit}
                icon={decorativeIcon(<ExperimentOutlined />)}
              >
                返回研究台
              </Button>
            </Space>
          </Flex>
        </Header>
        <Content id="workspace-main" tabIndex={-1} aria-label="实时公开观战" style={{ minWidth: 0, maxWidth: 1500, width: "100%", margin: "0 auto", padding: "20px" }}>
          {projection ? (
            <Suspense fallback={<CockpitChunkFallback label="正在加载实时公开桌面…" />}>
              <WerewolfLiveBoard projection={projection} pollError={pollError} />
            </Suspense>
          ) : (
            <Card bordered={false} data-testid="werewolf-live-board">
              <Alert
                type="info"
                showIcon
                title="实时公开局正在连接"
                description="等待服务端第一个已提交边界的公开投影；浏览器不会从旧工件、注册表或本地状态构造实时局面。"
              />
            </Card>
          )}
        </Content>
      </Layout>
    </>
  );
}

export function StatusBanner({ status, error, busy }: { status: string; error: string | null; busy: string | null }) {
  const isWaitingForArtifact = !error && !busy && /(没有可加载|没有匹配|未选择 run|尚未选择)/.test(status);
  if (!error && !busy && !isWaitingForArtifact) {
    return (
      <div className="cockpit-ready-status" role="status" aria-live="polite">
        <CheckCircleOutlined aria-hidden="true" />
        <Text ellipsis={{ tooltip: status }}>{status}</Text>
        <Tag color="success">就绪</Tag>
      </div>
    );
  }
  return (
    <Alert
      role={error ? "alert" : "status"}
      aria-live={error ? "assertive" : "polite"}
      showIcon
      type={error ? "error" : busy ? "info" : isWaitingForArtifact ? "warning" : "success"}
      icon={error || isWaitingForArtifact ? <WarningOutlined /> : <CheckCircleOutlined />}
      title={error ? `${status}: ${error}` : status}
      action={<Tag color={error ? "error" : busy ? "processing" : "warning"}>{error ? "错误" : busy ? busy : "等待数据"}</Tag>}
    />
  );
}

export function CockpitChunkFallback({ label }: { label: string }) {
  return (
    <Card loading aria-busy="true" aria-label={label}>
      <Text>{label}</Text>
    </Card>
  );
}

export const KpiGrid = memo(function KpiGrid({
  matches,
  artifact,
  comparison,
  replay
}: {
  matches: MatchRecord[];
  artifact: ProjectedMatchArtifact | null;
  comparison: MatchComparisonArtifact | null;
  replay: ReplayResponse | null;
}) {
  const completed = matches.filter((match) => (match.harnessStatus ?? match.status) === "completed").length;
  const truncated = matches.filter((match) => (match.harnessStatus ?? match.status) === "truncated").length;
  const failed = matches.filter((match) => (match.harnessStatus ?? match.status) === "failed").length;
  const replayOk = replay?.summary?.ok;
  const stepCounts = useMemo(
    () => (artifact ? countSocialStepCommits(artifact.socialEpisode.steps) : null),
    [artifact]
  );
  const hasRuns = matches.length > 0;
  return (
    <div className="cockpit-kpi-strip cockpit-kpi-strip--wide" style={{ marginTop: 16 }} data-testid="compact-kpi-strip" aria-label="当前运行摘要">
      <CompactKpi
        label="运行"
        value={hasRuns ? `${completed}/${matches.length}` : "—"}
        detail={hasRuns ? `截断 ${truncated} · 失败 ${failed}` : "注册表为空 · 无运行证据"}
      />
      <CompactKpi
        label="原生步骤"
        value={stepCounts ? String(stepCounts.nativeSteps) : "—"}
        detail={artifact ? `${shortId(artifact.runId)} · 提交 ${stepCounts?.committedSteps ?? 0} · 拒绝 ${stepCounts?.rejectedSteps ?? 0}` : "未加载工件 · 无执行证据"}
      />
      <CompactKpi
        label="社会消息"
        value={artifact ? String(artifact.socialEpisode.messages.length) : "—"}
        detail={artifact ? `${artifact.socialEpisode.channels.length} 个通道` : "未加载工件 · 无消息证据"}
      />
      <CompactKpi
        label="对比 / 复现"
        value={comparison ? `${comparison.summary.changedRowCount}/${comparison.summary.rowCount}` : replay ? (replayOk ? "通过" : "未通过") : "—"}
        detail={comparison ? "变化行 / 总行" : replay ? `不匹配 ${replay.summary?.mismatchCount ?? 0}` : "尚无对比或复现证据"}
      />
    </div>
  );
});

export function CompactKpi({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="cockpit-kpi-strip__item">
      <Text type="secondary" className="cockpit-kpi-strip__label">{label}</Text>
      <Text strong className="cockpit-kpi-strip__value">{value}</Text>
      <Text type="secondary" className="cockpit-kpi-strip__detail">{detail}</Text>
    </div>
  );
}

export function RunContextPanel({
  artifactView,
  postgameArtifactEnabled,
  onArtifactViewChange,
  busy,
  currentMatchId,
  artifact,
  selectedMatch,
  messageCount,
  metricCount,
  maxTransitions,
  onMaxTransitionsChange,
  timeoutSeconds,
  onTimeoutSecondsChange,
  jointPhaseScheduler,
  onJointPhaseSchedulerChange,
  rosterSummary,
  rosterInvalidReason,
  onOpenRosterComposer
}: {
  artifactView: ArtifactView;
  postgameArtifactEnabled: boolean;
  onArtifactViewChange: (value: ArtifactView) => void;
  busy: boolean;
  currentMatchId: string;
  artifact: ProjectedMatchArtifact | null;
  selectedMatch: MatchRecord | null;
  messageCount: number | null;
  metricCount: number | null;
  maxTransitions: string;
  onMaxTransitionsChange: (value: string) => void;
  timeoutSeconds: string;
  onTimeoutSecondsChange: (value: string) => void;
  jointPhaseScheduler: "aec-batched-decision" | "parallel";
  onJointPhaseSchedulerChange: (value: "aec-batched-decision" | "parallel") => void;
  rosterSummary: string;
  rosterInvalidReason?: string;
  onOpenRosterComposer: () => void;
}) {
  const stepCounts = useMemo(
    () => (artifact ? countSocialStepCommits(artifact.socialEpisode.steps) : null),
    [artifact]
  );
  const legacyProjectionCount = artifact
    ? artifact.trajectory.length
    : selectedMatch?.legacyProjectionSteps ?? selectedMatch?.trajectorySteps ?? "n/a";
  const runStatus = artifact?.status ?? selectedMatch?.status ?? "no artifact";
  const hasArtifact = Boolean(artifact);

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        size="small"
        title="运行上下文"
        extra={<Tag color={hasArtifact ? "processing" : "default"}>{runStatus}</Tag>}
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
            <Form.Item label="工件投影" style={{ marginBottom: 0 }}>
              <Select
                aria-label="工件投影"
                value={artifactView}
                options={[
                  ...(postgameArtifactEnabled
                    ? [{ value: "postgame-redacted" as const, label: "研究视图 · 私有脱敏" }]
                    : []),
                  { value: "truth-redacted", label: "公开视图 · 真相脱敏" }
                ]}
                onChange={(value) => onArtifactViewChange(value as ArtifactView)}
                disabled={busy}
              />
            </Form.Item>
          </Form>
          <Descriptions
            size="small"
            column={1}
            items={descriptionItems([
              ["当前 run", currentMatchId ? shortId(currentMatchId) : "未选择"],
              ["phase", artifact?.finalState.phase ?? selectedMatch?.state.phase ?? "n/a"],
              ["day", artifact?.finalState.day ?? selectedMatch?.state.day ?? "n/a"],
              ["native steps", stepCounts?.nativeSteps ?? "n/a"],
              ["committed steps", stepCounts?.committedSteps ?? "n/a"],
              ["rejected steps", stepCounts?.rejectedSteps ?? "n/a"],
              ["legacy projection", legacyProjectionCount],
              ["messages", messageCount ?? "n/a"],
              ["metrics", metricCount ?? "n/a"]
            ])}
          />
        </Space>
      </Card>

      <Card
        size="small"
        title="实验编排"
        extra={
          <Button size="small" icon={decorativeIcon(<TeamOutlined />)} onClick={onOpenRosterComposer} disabled={busy}>
            编辑 roster
          </Button>
        }
      >
        <Space orientation="vertical" size="small" style={{ width: "100%" }}>
          <Text>{rosterSummary}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            这里只提交 profile/model/policy 与 assignment 条件；服务端再解析真实 seat、role、team，React 不保存游戏真相。
          </Text>
          {rosterInvalidReason ? <Alert type="warning" showIcon title={rosterInvalidReason} /> : null}
        </Space>
      </Card>

      <Card size="small" title="运行限制">
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
            <Form.Item label="最大 transitions（留空即完整运行）">
              <Input
                aria-label="最大 transitions"
                inputMode="numeric"
                value={maxTransitions}
                onChange={(event) => onMaxTransitionsChange(event.target.value)}
                disabled={busy}
              />
            </Form.Item>
            <Form.Item label="超时秒数">
              <Input
                aria-label="超时秒数"
                inputMode="numeric"
                value={timeoutSeconds}
                onChange={(event) => onTimeoutSecondsChange(event.target.value)}
                disabled={busy}
              />
            </Form.Item>
            <Form.Item label="联合阶段调度" style={{ marginBottom: 0 }}>
              <Select
                aria-label="联合阶段调度"
                value={jointPhaseScheduler}
                options={[
                  { value: DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER, label: `${DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER}（默认）` },
                  { value: "parallel", label: "parallel（stepBatch）" }
                ]}
                onChange={(value) => onJointPhaseSchedulerChange(value as "aec-batched-decision" | "parallel")}
                disabled={busy}
              />
            </Form.Item>
          </Form>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {`正常运行默认不设 transition 上限；填写后即进入诊断截断模式。parallel 仅用于狼人杀联合阶段；若填写上限，需要 maxTransitions ≥ ${WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS}。默认调度仍为 ${DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER}。`}
          </Text>
          {jointPhaseScheduler === "parallel" &&
          isPositiveIntegerText(maxTransitions) &&
          Number(maxTransitions) < WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS ? (
            <Alert
              type="warning"
              showIcon
              title="当前 maxTransitions 不足以完成首个 parallel joint batch，运行会被 API 拒绝。"
            />
          ) : null}
        </Space>
      </Card>
    </Space>
  );
}
