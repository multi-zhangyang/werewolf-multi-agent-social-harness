import {
  Button,
  Card,
  Empty,
  Flex,
  Space,
  Table,
  Tag,
  Typography,
  type TableProps
} from "antd";
import { TableOutlined, WarningOutlined } from "@ant-design/icons";
import { memo, useCallback, useMemo } from "react";
import type {
  HarnessEvaluationWarning,
  HarnessMetricPromotionDecision,
  HarnessMetricRecord
} from "../../harness/types";
import { legacyMetricPromotionPolicyFromSummary, resolveRecordedMetricPromotion } from "../../harness/evaluation";
import type { PostgameMatchProjectionDto } from "../../server/artifactProjection";

const { Text } = Typography;
const TABLE_SCROLL = { x: "max-content" } as const;
const METRIC_TABLE_PAGINATION = { pageSize: 8 } as const;
const WARNING_TABLE_PAGINATION = { pageSize: 6 } as const;
const numericCell = () => ({ style: { fontVariantNumeric: "tabular-nums" as const } });

function formatNumber(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function SeverityTag({ severity }: { severity: HarnessEvaluationWarning["severity"] }) {
  return <Tag color={severity === "warning" ? "warning" : "default"}>{severity}</Tag>;
}

export const EvaluationWorkspace = memo(function EvaluationWorkspace({
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
  const promotionFallbackPolicy = useMemo(() => legacyMetricPromotionPolicyFromSummary(promotion), [promotion]);
  const resolvePromotion = useCallback(
    (metric: HarnessMetricRecord) => resolveRecordedMetricPromotion(metric, promotionFallbackPolicy),
    [promotionFallbackPolicy]
  );
  const metricColumns: TableProps<HarnessMetricRecord>["columns"] = useMemo(() => [
    {
      title: "metric",
      render: (_, metric) => (
        <Space orientation="vertical" size={0}>
          <Text strong>{metric.label}</Text>
          <Text code>{metric.id}</Text>
        </Space>
      )
    },
    { title: "scope", dataIndex: "scope" },
    { title: "subject", dataIndex: "subjectId", render: (value?: string) => value ?? "episode" },
    { title: "value", dataIndex: "value", onCell: numericCell, render: (value: unknown) => String(value) },
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
    { title: "weight", dataIndex: "weight", onCell: numericCell, render: (value?: number) => (value === undefined ? "n/a" : value) },
    { title: "source", render: (_, metric) => metric.evaluatorId ?? metric.source },
    { title: "evidence", onCell: numericCell, render: (_, metric) => metric.evidenceRefs?.length ?? 0 },
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
  ], [onInspectMetric, resolvePromotion]);
  const warningColumns: TableProps<HarnessEvaluationWarning>["columns"] = useMemo(() => [
    { title: "severity", dataIndex: "severity", render: (severity: HarnessEvaluationWarning["severity"]) => <SeverityTag severity={severity} /> },
    { title: "code", dataIndex: "code" },
    { title: "evaluator", dataIndex: "evaluatorId", render: (value?: string) => value ?? "n/a" },
    { title: "message", dataIndex: "message", ellipsis: true },
    { title: "evidence", onCell: numericCell, render: (_, warning) => warning.evidenceRefs?.length ?? 0 },
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
  ], [onInspectWarning]);

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <div className="cockpit-kpi-strip" aria-label="评测摘要">
        <SummaryMetric label="局分" value={summary?.episodeScore !== undefined ? formatNumber(summary.episodeScore, 2) : "n/a"} detail="episode score" />
        <SummaryMetric
          label="计分指标"
          value={String(promotion?.scorecardMetricCount ?? metrics.filter((metric) => resolvePromotion(metric).eligibleForScorecard).length)}
          detail={`共 ${metrics.length} 项`}
        />
        <SummaryMetric
          label="诊断指标"
          value={String(promotion?.diagnosticMetricCount ?? metrics.filter((metric) => !resolvePromotion(metric).eligibleForScorecard).length)}
          detail="不进入主计分"
        />
        <SummaryMetric label="排除加权项" value={String(promotion?.excludedWeightedMetricCount ?? 0)} detail={`告警 ${warnings.length}`} />
      </div>

      {promotion ? (
        <section className="workspace-tool-block" aria-label="metric promotion policy">
          <Text strong>Metric promotion policy</Text>
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
        </section>
      ) : null}

      <Card
        title={
          <Space size={6}>
            <span aria-hidden="true" style={{ color: "#3558d6" }}><TableOutlined /></span>
            <span>指标表</span>
          </Space>
        }
      >
        <Flex vertical gap={12}>
          <Text type="secondary">
            每条 metric 保留 evaluator、scope、subject、evidence refs，并用 `evaluation.metric-promotion.v1` 标注 scorecard /
            diagnostic / benchmark_only。零权重 temporal-association 默认 diagnostic，不进入 agentScores。
          </Text>
          <Table
            rowKey={(metric) => `${metric.id}-${metric.subjectId ?? "episode"}`}
            size="small"
            bordered={false}
            scroll={TABLE_SCROLL}
            columns={metricColumns}
            dataSource={metrics}
            pagination={METRIC_TABLE_PAGINATION}
            onRow={(metric) => ({ onClick: () => onInspectMetric(metric, resolvePromotion(metric)) })}
            locale={{ emptyText: <Empty description="当前 artifact 没有 evaluationReport.metrics。" /> }}
          />
        </Flex>
      </Card>

      <Card
        title={
          <Space size={6}>
            <span aria-hidden="true" style={{ color: "#b54708" }}><WarningOutlined /></span>
            <span>评测告警</span>
          </Space>
        }
      >
        <Flex vertical gap={12}>
          <Text type="secondary">失败、脱敏、覆盖不足和 evaluator 风险不能被隐藏。</Text>
          <Table
            rowKey={(warning, index) => `${warning.code}-${index}`}
            size="small"
            bordered={false}
            scroll={TABLE_SCROLL}
            columns={warningColumns}
            dataSource={warnings}
            pagination={WARNING_TABLE_PAGINATION}
            onRow={(warning) => ({ onClick: () => onInspectWarning(warning) })}
            locale={{ emptyText: <Empty description="当前 evaluation report 未记录 warning。" /> }}
          />
        </Flex>
      </Card>
    </Space>
  );
});

function SummaryMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="cockpit-kpi-strip__item">
      <Text type="secondary" className="cockpit-kpi-strip__label">{label}</Text>
      <Text strong className="cockpit-kpi-strip__value" style={{ fontVariantNumeric: "tabular-nums" }}>{value}</Text>
      <Text type="secondary" className="cockpit-kpi-strip__detail">{detail}</Text>
    </div>
  );
}
