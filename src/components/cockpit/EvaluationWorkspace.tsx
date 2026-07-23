import {
  Button,
  Card,
  Col,
  Empty,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  type TableProps
} from "antd";
import { BarChartOutlined, DatabaseOutlined, SafetyCertificateOutlined, WarningOutlined } from "@ant-design/icons";
import type {
  HarnessEvaluationWarning,
  HarnessMetricPromotionDecision,
  HarnessMetricRecord
} from "../../harness/types";
import { legacyMetricPromotionPolicyFromSummary, resolveRecordedMetricPromotion } from "../../harness/evaluation";
import type { PostgameMatchProjectionDto } from "../../server/artifactProjection";

const { Text } = Typography;
const TABLE_SCROLL = { x: "max-content" } as const;

function formatNumber(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function SeverityTag({ severity }: { severity: HarnessEvaluationWarning["severity"] }) {
  return <Tag color={severity === "warning" ? "warning" : "default"}>{severity}</Tag>;
}

export function EvaluationWorkspace({
  artifact,
  metrics,
  warnings,
  onInspectMetric,
  onInspectWarning
}: {
  artifact: PostgameMatchProjectionDto | null;
  metrics: HarnessMetricRecord[];
  warnings: HarnessEvaluationWarning[];
  onInspectMetric: (metric: HarnessMetricRecord, decision: HarnessMetricPromotionDecision) => void;
  onInspectWarning: (warning: HarnessEvaluationWarning) => void;
}) {
  const summary = artifact?.evaluationReport.summary;
  const promotion = summary?.promotion;
  const promotionFallbackPolicy = legacyMetricPromotionPolicyFromSummary(promotion);
  const resolvePromotion = (metric: HarnessMetricRecord) =>
    resolveRecordedMetricPromotion(metric, promotionFallbackPolicy);
  const metricColumns: TableProps<HarnessMetricRecord>["columns"] = [
    {
      title: "metric",
      render: (_, metric) => (
        <Space direction="vertical" size={0}>
          <Text strong>{metric.label}</Text>
          <Text code>{metric.id}</Text>
        </Space>
      )
    },
    { title: "scope", dataIndex: "scope" },
    { title: "subject", dataIndex: "subjectId", render: (value?: string) => value ?? "episode" },
    { title: "value", dataIndex: "value", render: (value: unknown) => String(value) },
    {
      title: "promotion",
      render: (_, metric) => {
        const decision = resolvePromotion(metric);
        const color =
          decision.promotionClass === "scorecard"
            ? decision.eligibleForScorecard
              ? "success"
              : "warning"
            : decision.promotionClass === "benchmark_only"
              ? "processing"
              : "default";
        return (
          <Tag color={color}>
            {decision.promotionClass}
            {decision.eligibleForScorecard ? " · scorecard" : " · excluded"}
          </Tag>
        );
      }
    },
    { title: "weight", dataIndex: "weight", render: (value?: number) => (value === undefined ? "n/a" : value) },
    { title: "source", render: (_, metric) => metric.evaluatorId ?? metric.source },
    { title: "evidence", render: (_, metric) => metric.evidenceRefs?.length ?? 0 },
    {
      title: "查看",
      fixed: "right",
      width: 72,
      render: (_, metric) => (
        <Button type="link" size="small" aria-label={`查看指标 ${metric.id}`} onClick={() => onInspectMetric(metric, resolvePromotion(metric))}>
          查看
        </Button>
      )
    }
  ];
  const warningColumns: TableProps<HarnessEvaluationWarning>["columns"] = [
    { title: "severity", dataIndex: "severity", render: (severity: HarnessEvaluationWarning["severity"]) => <SeverityTag severity={severity} /> },
    { title: "code", dataIndex: "code" },
    { title: "evaluator", dataIndex: "evaluatorId", render: (value?: string) => value ?? "n/a" },
    { title: "message", dataIndex: "message", ellipsis: true },
    { title: "evidence", render: (_, warning) => warning.evidenceRefs?.length ?? 0 },
    {
      title: "查看",
      fixed: "right",
      width: 72,
      render: (_, warning) => (
        <Button type="link" size="small" aria-label={`查看告警 ${warning.code}`} onClick={() => onInspectWarning(warning)}>
          查看
        </Button>
      )
    }
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="episode score" value={summary?.episodeScore !== undefined ? formatNumber(summary.episodeScore, 2) : "n/a"} prefix={<BarChartOutlined />} />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic
              title="scorecard metrics"
              value={promotion?.scorecardMetricCount ?? metrics.filter((metric) => resolvePromotion(metric).eligibleForScorecard).length}
              prefix={<SafetyCertificateOutlined />}
              suffix={<Text type="secondary">of {metrics.length}</Text>}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic
              title="diagnostic metrics"
              value={promotion?.diagnosticMetricCount ?? metrics.filter((metric) => !resolvePromotion(metric).eligibleForScorecard).length}
              prefix={<DatabaseOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic
              title="excluded weighted"
              value={promotion?.excludedWeightedMetricCount ?? 0}
              prefix={<WarningOutlined />}
              suffix={<Text type="secondary">warnings {warnings.length}</Text>}
            />
          </Card>
        </Col>
      </Row>

      {promotion ? (
        <Card size="small" title="metric promotion policy">
          <Space wrap>
            <Tag color="processing">{promotion.policyId}</Tag>
            <Tag color="blue">{promotion.catalogId}</Tag>
            <Tag>catalogEntries={promotion.catalogEntryCount}</Tag>
            <Tag>catalogRules={promotion.catalogRuleCount}</Tag>
            <Tag>scorecardRequiresEvidence={String(promotion.scorecardRequiresEvidence)}</Tag>
            <Tag>scorecardRequiresPositiveWeight={String(promotion.scorecardRequiresPositiveWeight)}</Tag>
            <Tag>uncataloged={promotion.uncatalogedMetricPolicy}</Tag>
            {promotion.excludedWeightedMetricIds.length ? (
              <Tag color="warning">excluded: {promotion.excludedWeightedMetricIds.join(", ")}</Tag>
            ) : (
              <Tag color="success">no weighted exclusions</Tag>
            )}
          </Space>
        </Card>
      ) : null}

      <Card title="指标表">
        <Text type="secondary">
          每条 metric 保留 evaluator、scope、subject、evidence refs，并用 `evaluation.metric-promotion.v1` 标注 scorecard /
          diagnostic / benchmark_only。零权重 temporal-association 默认 diagnostic，不进入 agentScores。
        </Text>
        <Table
          rowKey={(metric) => `${metric.id}-${metric.subjectId ?? "episode"}`}
          size="small"
          bordered
          scroll={TABLE_SCROLL}
          columns={metricColumns}
          dataSource={metrics}
          pagination={{ pageSize: 8 }}
          onRow={(metric) => ({ onClick: () => onInspectMetric(metric, resolvePromotion(metric)) })}
          locale={{ emptyText: <Empty description="当前 artifact 没有 evaluationReport.metrics。" /> }}
        />
      </Card>

      <Card title="评测告警">
        <Text type="secondary">失败、脱敏、覆盖不足和 evaluator 风险不能被隐藏。</Text>
        <Table
          rowKey={(warning, index) => `${warning.code}-${index}`}
          size="small"
          bordered
          scroll={TABLE_SCROLL}
          columns={warningColumns}
          dataSource={warnings}
          pagination={{ pageSize: 6 }}
          onRow={(warning) => ({ onClick: () => onInspectWarning(warning) })}
          locale={{ emptyText: <Empty description="当前 evaluation report 未记录 warning。" /> }}
        />
      </Card>
    </Space>
  );
}
