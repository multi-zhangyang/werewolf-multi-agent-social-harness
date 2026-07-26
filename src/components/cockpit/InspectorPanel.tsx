import { memo, useMemo, type ReactNode } from "react";
import { Badge, Button, Card, Descriptions, Empty, Flex, Grid, Space, Tag, Tooltip } from "antd";
import type { DescriptionsProps } from "antd";
import { CodeOutlined } from "@ant-design/icons";

import type { HarnessEvaluationWarning } from "../../harness/types";
import { countSocialStepCommits, type SocialMessage } from "../../harness/social";
import type {
  ArtifactView,
  InspectorItem,
  ProjectedMatchArtifact,
  ProjectedSocialStep
} from "./cockpitTypes";
import { Text } from "./uiPrimitives";
import { formatValue, shortId } from "./formatters";

export function ArtifactSummary({ title, artifact }: { title: string; artifact: ProjectedMatchArtifact | null }) {
  const screens = Grid.useBreakpoint();
  // One pass over the native steps instead of three per render.
  const stepCounts = useMemo(
    () => (artifact ? countSocialStepCommits(artifact.socialEpisode.steps) : null),
    [artifact]
  );
  const truthRedacted = artifact?.projection?.postgameTruthRedacted === true;
  const projectionDetail = artifact?.projection
    ? `private ${artifact.projection.privateEvidenceRedacted ? "redacted" : "visible"} · truth ${truthRedacted ? "redacted" : "visible"}`
    : null;
  return (
    <Card
      size="small"
      title={title}
      extra={
        artifact?.projection ? (
          <Tooltip title={projectionDetail}>
            <Tag color={truthRedacted ? "warning" : "processing"}>
              {screens.sm ? `${artifact.projection.view} · ${projectionDetail}` : artifact.projection.view}
            </Tag>
          </Tooltip>
        ) : (
          <Tag>empty</Tag>
        )
      }
    >
      {artifact ? (
        <Descriptions
          size="small"
          column={1}
          items={descriptionItems([
            ["run", shortId(artifact.runId)],
            ["status", artifact.status],
            ["projection", projectionDetail ?? "n/a"],
            ["seed", artifact.seed],
            ["models", artifact.models.join(", ") || "n/a"],
            ["native steps", stepCounts?.nativeSteps ?? 0],
            ["committed steps", stepCounts?.committedSteps ?? 0],
            ["rejected steps", stepCounts?.rejectedSteps ?? 0],
            ["legacy projection", artifact.trajectory.length],
            ["messages", artifact.socialEpisode.messages.length],
            ["metrics", artifact.evaluationReport.metricCount ?? 0],
            ["winner", truthRedacted ? "[redacted]" : artifact.finalState.winner ?? "n/a"]
          ])}
        />
      ) : (
        <Empty description="对比前需要一个真实 match artifact。" />
      )}
    </Card>
  );
}

export const InspectorPanel = memo(function InspectorPanel({
  item,
  onOpenRaw,
  artifactView
}: {
  item: InspectorItem | null;
  onOpenRaw: () => void;
  artifactView: ArtifactView;
}) {
  return (
    <Flex vertical gap="middle" style={{ padding: 16 }}>
      <Flex justify="space-between" align="center">
        <Space>
          <CodeOutlined />
          <Text strong>Evidence Inspector</Text>
        </Space>
        <Tag>{artifactView}</Tag>
      </Flex>
      <Text type="secondary">点击 run、step、agent、message、metric 或 compare row 查看证据。</Text>
      {item ? (
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Card size="small">
            <Space orientation="vertical" size={4}>
              <Text strong>{item.title}</Text>
              <Text type="secondary">{item.subtitle ?? item.kind}</Text>
            </Space>
          </Card>
          <Descriptions
            size="small"
            bordered
            column={1}
            styles={{ label: { width: 96 }, content: { maxWidth: 240, minWidth: 0 } }}
            items={descriptionItems(item.fields)}
          />
          {item.actions?.length ? (
            <Space orientation="vertical" size="small" style={{ width: "100%" }}>
              <Text type="secondary">服务端证据动作</Text>
              {item.actions.map((action) => (
                <Button
                  key={action.key}
                  block
                  size="small"
                  disabled={action.disabled}
                  onClick={action.onClick}
                >
                  {action.label}
                </Button>
              ))}
            </Space>
          ) : null}
          <Button block icon={decorativeIcon(<CodeOutlined />)} onClick={onOpenRaw}>
            查看原始片段
          </Button>
        </Space>
      ) : (
        <Empty description="左侧表格和时间线中的每次点击都会更新这里。" />
      )}
    </Flex>
  );
});

export function StatusTag({ status }: { status: string }) {
  if (status === "failed") return <Tag color="error">failed</Tag>;
  if (status === "completed") return <Tag color="success">completed</Tag>;
  if (status === "running") return <Badge status="processing" text="running" />;
  return <Tag>{status}</Tag>;
}

export function CommitStatusTag({ status }: { status: "committed" | "rejected" }) {
  return <Tag color={status === "committed" ? "success" : "error"}>{status}</Tag>;
}

export function VisibilityTag({ visibility }: { visibility: SocialMessage["visibility"] }) {
  const color = visibility === "public" ? "success" : visibility === "team" ? "processing" : visibility === "private" ? "warning" : "default";
  return <Tag color={color}>{visibility}</Tag>;
}

export function SchedulerTag({ mode }: { mode?: ProjectedSocialStep["schedulerMode"] }) {
  if (mode === "aec-batched-decision") return <Tag color="processing">batched</Tag>;
  if (mode === "parallel") return <Tag color="warning">parallel</Tag>;
  if (mode === "aec") return <Tag color="success">aec</Tag>;
  return <Tag>n/a</Tag>;
}

export function BoundaryTag({ status, ok }: { status?: string; ok?: boolean }) {
  if (!status) return <Tag>n/a</Tag>;
  const color = ok === false || status === "mismatch" ? "error" : status === "not_fork" ? "default" : "success";
  return <Tag color={color}>{status}</Tag>;
}

export function SeverityTag({ severity }: { severity: HarnessEvaluationWarning["severity"] }) {
  return <Tag color={severity === "warning" ? "warning" : "default"}>{severity}</Tag>;
}

export function decorativeIcon(icon: ReactNode): ReactNode {
  return <span aria-hidden="true">{icon}</span>;
}

export function descriptionItems(rows: Array<[string, unknown]>): DescriptionsProps["items"] {
  return rows.map(([key, value]) => ({
    key,
    label: key,
    children: <InspectorValue value={value} />
  }));
}

export function InspectorValue({ value }: { value: unknown }) {
  const text = formatValue(value);
  const isLong = text.length > 28;
  return (
    <Text
      copyable={isLong ? { text } : false}
      ellipsis={{ tooltip: text }}
      style={{ display: "inline-block", maxWidth: "100%" }}
    >
      {text}
    </Text>
  );
}
