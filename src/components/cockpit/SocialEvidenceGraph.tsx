import { Alert, Button, Empty, Flex, Segmented, Select, Tag, Typography } from "antd";
import { HeatMapOutlined } from "@ant-design/icons";
import { memo, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type {
  SocialNetworkCommunicationEdgeDto,
  SocialNetworkExposureEdgeDto,
  SocialNetworkProjectionDto,
  SocialNetworkRelationshipEdgeDto
} from "../../server/artifactProjection";

const { Text, Title } = Typography;

type EvidenceMode = "relationships" | "exposure" | "communication";
type RelationshipDimension =
  | "trust"
  | "suspicion"
  | "affinity"
  | "influence"
  | "debt"
  | "respect"
  | "threat";

const relationshipDimensions: Array<{ value: RelationshipDimension; label: string }> = [
  { value: "trust", label: "信任" },
  { value: "suspicion", label: "怀疑" },
  { value: "affinity", label: "亲和" },
  { value: "influence", label: "影响" },
  { value: "respect", label: "尊重" },
  { value: "threat", label: "威胁" },
  { value: "debt", label: "关系债务" }
];

const evidenceModeOptions = [
  { value: "relationships" as const, label: "关系认知" },
  { value: "exposure" as const, label: "实际观察" },
  { value: "communication" as const, label: "通信投递" }
];

export const SocialEvidenceGraph = memo(function SocialEvidenceGraph({
  network,
  selectedAgentId,
  onSelectAgent,
  onSelectRelationship,
  onSelectExposure,
  onSelectCommunication
}: {
  network: SocialNetworkProjectionDto | null;
  selectedAgentId?: string;
  onSelectAgent?: (agentId: string) => void;
  onSelectRelationship?: (edge: SocialNetworkRelationshipEdgeDto) => void;
  onSelectExposure?: (edges: readonly SocialNetworkExposureEdgeDto[]) => void;
  onSelectCommunication?: (edges: readonly SocialNetworkCommunicationEdgeDto[]) => void;
}) {
  const [mode, setMode] = useState<EvidenceMode>("relationships");
  const [dimension, setDimension] = useState<RelationshipDimension>("trust");
  const nodes = network?.nodes ?? [];
  const activeAvailability = network?.modes[mode];
  const relationshipByPair = useMemo(
    () => new Map((network?.relationshipEdges ?? []).map((edge) => [pairKey(edge.sourceId, edge.targetId), edge])),
    [network?.relationshipEdges]
  );
  const exposureByPair = useMemo(
    () => groupExposureByPair(network?.exposureEdges ?? []),
    [network?.exposureEdges]
  );
  const communicationByPair = useMemo(
    () => groupCommunicationByPair(network?.communicationEdges ?? []),
    [network?.communicationEdges]
  );

  return (
    <section className="social-matrix" data-testid="social-evidence-graph" aria-labelledby="social-matrix-title">
      <div className="social-matrix__header">
        <div>
          <Flex align="center" gap={8} wrap>
            <span aria-hidden="true" style={{ color: "#3558d6", fontSize: 16, lineHeight: 1 }}>
              <HeatMapOutlined />
            </span>
            <Title level={3} id="social-matrix-title" className="cockpit-section-title">
              社会证据矩阵
            </Title>
            <Tag color="processing">服务端投影</Tag>
            <Tag>{network?.scope === "final-agent-snapshot" ? "最终 Agent 快照" : "未加载"}</Tag>
          </Flex>
          <Text type="secondary">方向固定为行 → 列；关系、观察与投递是三种独立事实，不做客户端推断。</Text>
        </div>
        <Flex gap={8} align="center" wrap>
          <Segmented<EvidenceMode>
            aria-label="社会证据视图"
            value={mode}
            onChange={setMode}
            options={evidenceModeOptions}
          />
          {mode === "relationships" ? (
            <Select<RelationshipDimension>
              aria-label="关系维度"
              value={dimension}
              options={relationshipDimensions}
              onChange={setDimension}
              popupMatchSelectWidth={false}
            />
          ) : null}
        </Flex>
      </div>

      {!network ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载赛后工件后查看社会证据。" />
      ) : activeAvailability?.available === false ? (
        <Alert
          type="info"
          showIcon
          title="当前投影不提供此类社会证据"
          description={activeAvailability.reason ?? "服务端没有发布该证据面。"}
        />
      ) : nodes.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="服务端投影中没有 Agent 节点。" />
      ) : (
        <div
          className="social-matrix__viewport"
          role="group"
          aria-label="Agent 社会证据矩阵"
          tabIndex={0}
        >
          <div
            className="social-matrix__grid"
            style={{ gridTemplateColumns: `minmax(112px, 1.4fr) repeat(${nodes.length}, minmax(74px, 1fr))` }}
          >
            <div className="social-matrix__corner" aria-hidden="true">
              行 → 列
            </div>
            {nodes.map((node) => (
              <Button
                key={`column-${node.id}`}
                type="text"
                className={`social-matrix__axis social-matrix__axis--column${node.id === selectedAgentId ? " is-selected" : ""}`}
                aria-label={`查看列 agent ${node.id} 的社会证据`}
                onClick={() => onSelectAgent?.(node.id)}
              >
                {node.id}
              </Button>
            ))}

            {nodes.flatMap((source) => [
              <Button
                key={`row-${source.id}`}
                type="text"
                className={`social-matrix__axis social-matrix__axis--row${source.id === selectedAgentId ? " is-selected" : ""}`}
                aria-label={`查看行 agent ${source.id} 的社会证据`}
                onClick={() => onSelectAgent?.(source.id)}
              >
                <span>{source.id}</span>
                <small>{nodeActivityLabel(source)}</small>
              </Button>,
              ...nodes.map((target) => (
                <EvidenceCell
                  key={`${mode}-${source.id}-${target.id}`}
                  mode={mode}
                  dimension={dimension}
                  sourceId={source.id}
                  targetId={target.id}
                  relationship={relationshipByPair.get(pairKey(source.id, target.id))}
                  exposure={exposureByPair.get(pairKey(source.id, target.id))}
                  communication={communicationByPair.get(pairKey(source.id, target.id))}
                  onSelectRelationship={onSelectRelationship}
                  onSelectExposure={onSelectExposure}
                  onSelectCommunication={onSelectCommunication}
                />
              ))
            ])}
          </div>
        </div>
      )}

      <MatrixLegend mode={mode} dimension={dimension} network={network} />
    </section>
  );
});

const EvidenceCell = memo(function EvidenceCell({
  mode,
  dimension,
  sourceId,
  targetId,
  relationship,
  exposure,
  communication,
  onSelectRelationship,
  onSelectExposure,
  onSelectCommunication
}: {
  mode: EvidenceMode;
  dimension: RelationshipDimension;
  sourceId: string;
  targetId: string;
  relationship?: SocialNetworkRelationshipEdgeDto;
  exposure?: readonly SocialNetworkExposureEdgeDto[];
  communication?: readonly SocialNetworkCommunicationEdgeDto[];
  onSelectRelationship?: (edge: SocialNetworkRelationshipEdgeDto) => void;
  onSelectExposure?: (edges: readonly SocialNetworkExposureEdgeDto[]) => void;
  onSelectCommunication?: (edges: readonly SocialNetworkCommunicationEdgeDto[]) => void;
}) {
  if (sourceId === targetId) {
    return <div className="social-matrix__cell social-matrix__cell--self" aria-hidden="true" />;
  }

  if (mode === "relationships") {
    if (!relationship) return <EmptyCell sourceId={sourceId} targetId={targetId} label="未记录关系" />;
    const value = relationship[dimension];
    const dimensionLabel = relationshipDimensions.find((item) => item.value === dimension)?.label ?? dimension;
    return (
      <button
        type="button"
        className={`social-matrix__cell social-matrix__cell--relationship ${relationTone(value)}`}
        style={{ "--cell-strength": Math.min(1, Math.abs(value)) } as CSSProperties}
        aria-label={`${sourceId} 对 ${targetId} 的${dimensionLabel} ${formatScore(value)}，${relationship.evidenceRefs.length} 条证据`}
        onClick={() => onSelectRelationship?.(relationship)}
      >
        <strong>{formatScore(value)}</strong>
        <small>{relationship.evidenceRefs.length} 证据</small>
      </button>
    );
  }

  if (mode === "exposure") {
    if (!exposure?.length) return <EmptyCell sourceId={sourceId} targetId={targetId} label="无实际观察" />;
    const observationCount = exposure.reduce((sum, edge) => sum + edge.observationCount, 0);
    const uniqueMessageCount = new Set(exposure.flatMap((edge) => edge.messageRefs.map((ref) => ref.id))).size;
    return (
      <button
        type="button"
        className={`social-matrix__cell social-matrix__cell--count visibility-${visibilityTone(exposure)}`}
        aria-label={`${sourceId} 的消息被 ${targetId} 实际观察 ${observationCount} 次，来自 ${exposure.length} 条服务端边`}
        onClick={() => onSelectExposure?.(exposure)}
      >
        <strong>{observationCount}</strong>
        <small>{uniqueMessageCount} 条消息</small>
      </button>
    );
  }

  if (!communication?.length) return <EmptyCell sourceId={sourceId} targetId={targetId} label="无投递记录" />;
  const messageCount = new Set(communication.flatMap((edge) => edge.messageSeqs)).size;
  return (
    <button
      type="button"
      className={`social-matrix__cell social-matrix__cell--count visibility-${visibilityTone(communication)}`}
      aria-label={`${sourceId} 向 ${targetId} 投递 ${messageCount} 条消息，来自 ${communication.length} 条服务端边`}
      onClick={() => onSelectCommunication?.(communication)}
    >
      <strong>{messageCount}</strong>
      <small>{channelLabel(communication)}</small>
    </button>
  );
});

function EmptyCell({ sourceId, targetId, label }: { sourceId: string; targetId: string; label: string }) {
  return (
    <div className="social-matrix__cell social-matrix__cell--empty" role="img" aria-label={`${sourceId} 到 ${targetId}：${label}`}>
      —
    </div>
  );
}

function MatrixLegend({
  mode,
  dimension,
  network
}: {
  mode: EvidenceMode;
  dimension: RelationshipDimension;
  network: SocialNetworkProjectionDto | null;
}) {
  if (!network) return null;
  if (mode === "relationships") {
    const label = relationshipDimensions.find((item) => item.value === dimension)?.label ?? dimension;
    return (
      <Flex className="social-matrix__legend" gap={8} wrap align="center">
        <Tag color="success">正向 {label}</Tag>
        <Tag color="error">负向 {label}</Tag>
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 84,
            height: 8,
            borderRadius: 999,
            border: "1px solid rgba(102, 112, 133, 0.28)",
            background:
              "linear-gradient(90deg, rgba(180, 35, 24, 0.24), rgba(180, 35, 24, 0.06) 38%, #f8fafc 50%, rgba(8, 116, 67, 0.06) 62%, rgba(8, 116, 67, 0.24))"
          }}
        />
        <Text type="secondary">数值来自 Agent 最终关系快照；方向为主观判断者 → 目标。</Text>
      </Flex>
    );
  }
  return (
    <Flex className="social-matrix__legend" gap={8} wrap align="center">
      <Tag color="success">public</Tag>
      <Tag color="processing">team</Tag>
      <Tag color="warning">private</Tag>
      <Text type="secondary">
        {mode === "exposure"
          ? "只统计服务端从已提交 scoped observation 推导的实际观察。"
          : "只统计消息 envelope 中声明的投递，不代表已阅读、信任或影响。"}
      </Text>
    </Flex>
  );
}

function groupExposureByPair(edges: SocialNetworkExposureEdgeDto[]): Map<string, SocialNetworkExposureEdgeDto[]> {
  return groupByPair(edges);
}

function groupCommunicationByPair(edges: SocialNetworkCommunicationEdgeDto[]): Map<string, SocialNetworkCommunicationEdgeDto[]> {
  return groupByPair(edges);
}

function groupByPair<T extends { sourceId: string; targetId: string }>(edges: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const edge of edges) {
    const key = pairKey(edge.sourceId, edge.targetId);
    grouped.set(key, [...(grouped.get(key) ?? []), edge]);
  }
  return grouped;
}

function visibilityTone(edges: readonly { visibility: string }[]): string {
  const values = new Set(edges.map((edge) => edge.visibility));
  return values.size === 1 ? edges[0]!.visibility : "mixed";
}

function channelLabel(edges: readonly { channelId: string }[]): string {
  const channels = new Set(edges.map((edge) => edge.channelId));
  return channels.size === 1 ? edges[0]!.channelId : `${channels.size} 通道`;
}

function pairKey(sourceId: string, targetId: string): string {
  return JSON.stringify([sourceId, targetId]);
}

function relationTone(value: number): string {
  if (value > 0) return "is-positive";
  if (value < 0) return "is-negative";
  return "is-neutral";
}

function formatScore(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2);
}

function nodeActivityLabel(node: SocialNetworkProjectionDto["nodes"][number]): string {
  return `${node.sentMessageCount} 发 · ${node.observedMessageCount} 见`;
}
