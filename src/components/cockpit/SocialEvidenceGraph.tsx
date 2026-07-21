import { Card, Empty, Flex, Tag, Typography } from "antd";
import type { KeyboardEvent } from "react";
import type { SocialGraph, SocialGraphExposureEdge } from "../../App";

const { Text } = Typography;

const VIEWBOX_WIDTH = 720;
const VIEWBOX_HEIGHT = 430;
const CENTER_X = VIEWBOX_WIDTH / 2;
const CENTER_Y = VIEWBOX_HEIGHT / 2;
const NODE_RING_RADIUS = 148;

export interface SocialEvidenceGraphNodePosition {
  id: string;
  x: number;
  y: number;
  activity: number;
}

/**
 * Stable ring placement suits the fixed, small Werewolf roster and keeps a
 * recorded social graph readable without inventing client-side graph state or
 * a force-layout simulation. The graph inputs remain server-projected facts.
 */
export function layoutSocialEvidenceGraph(graph: SocialGraph): SocialEvidenceGraphNodePosition[] {
  const nodes = [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id));
  if (!nodes.length) return [];
  return nodes.map((node, index) => {
    const angle = -Math.PI / 2 + (index / nodes.length) * Math.PI * 2;
    return {
      id: node.id,
      x: CENTER_X + Math.cos(angle) * NODE_RING_RADIUS,
      y: CENTER_Y + Math.sin(angle) * NODE_RING_RADIUS,
      activity: node.sent + node.received + node.observed
    };
  });
}

export function SocialEvidenceGraph({
  graph,
  selectedAgentId,
  onSelectAgent,
  onSelectExposure
}: {
  graph: SocialGraph;
  selectedAgentId?: string;
  onSelectAgent?: (agentId: string) => void;
  onSelectExposure?: (edge: SocialGraphExposureEdge) => void;
}) {
  const positions = layoutSocialEvidenceGraph(graph);
  const positionById = new Map(positions.map((position) => [position.id, position]));
  const maxActivity = Math.max(1, ...positions.map((position) => position.activity));
  const exposureEdges = [...graph.exposureEdges].sort(compareExposureEdges);
  const messageEdges = [...graph.messageEdges].sort((left, right) => edgeKey(left.sourceId, left.targetId).localeCompare(edgeKey(right.sourceId, right.targetId)));

  if (!positions.length) {
    return (
      <Card title="社会证据图" extra={<Tag>server projection</Tag>} data-testid="social-evidence-graph">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前 artifact 不包含可视化的 agent 社会证据。" />
      </Card>
    );
  }

  return (
    <Card
      title="社会证据图"
      extra={
        <Flex gap={4} wrap="wrap" justify="end">
          <Tag color="success">public</Tag>
          <Tag color="processing">team</Tag>
          <Tag color="warning">private</Tag>
        </Flex>
      }
      data-testid="social-evidence-graph"
    >
      <Flex vertical gap="small">
        <div className="social-evidence-graph__canvas" aria-label="Agent 社会可见性与通信证据图">
          <svg viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`} role="img" aria-label="Agent 社会可见性与通信证据图">
            <defs>
              <marker id="social-evidence-graph-arrow-public" markerWidth="7" markerHeight="7" refX="7" refY="3.5" orient="auto">
                <path d="M0,0 L7,3.5 L0,7 z" className="social-evidence-graph__arrow social-evidence-graph__arrow--public" />
              </marker>
              <marker id="social-evidence-graph-arrow-team" markerWidth="7" markerHeight="7" refX="7" refY="3.5" orient="auto">
                <path d="M0,0 L7,3.5 L0,7 z" className="social-evidence-graph__arrow social-evidence-graph__arrow--team" />
              </marker>
              <marker id="social-evidence-graph-arrow-private" markerWidth="7" markerHeight="7" refX="7" refY="3.5" orient="auto">
                <path d="M0,0 L7,3.5 L0,7 z" className="social-evidence-graph__arrow social-evidence-graph__arrow--private" />
              </marker>
            </defs>

            <circle className="social-evidence-graph__ring" cx={CENTER_X} cy={CENTER_Y} r={NODE_RING_RADIUS} />

            {messageEdges.map((edge, index) => {
              const source = positionById.get(edge.sourceId);
              const target = positionById.get(edge.targetId);
              if (!source || !target) return null;
              return (
                <path
                  key={`message-${edgeKey(edge.sourceId, edge.targetId)}`}
                  className="social-evidence-graph__message-edge"
                  d={curvedPath(source, target, index, messageEdges.length)}
                  strokeWidth={1 + Math.min(3, edge.messages)}
                >
                  <title>{`${edge.sourceId} 向 ${edge.targetId} 发送 ${edge.messages} 条已记录消息`}</title>
                </path>
              );
            })}

            {exposureEdges.map((edge, index) => {
              const source = positionById.get(edge.sourceId);
              const target = positionById.get(edge.targetId);
              if (!source || !target || source.id === target.id) return null;
              const className = `social-evidence-graph__exposure-edge social-evidence-graph__exposure-edge--${edge.visibility}`;
              const select = () => onSelectExposure?.(edge);
              return (
                <g
                  key={`exposure-${exposureKey(edge)}`}
                  className="social-evidence-graph__interactive-edge"
                  role={onSelectExposure ? "button" : undefined}
                  tabIndex={onSelectExposure ? 0 : undefined}
                  aria-label={onSelectExposure ? exposureLabel(edge) : undefined}
                  onClick={select}
                  onKeyDown={(event) => activateWithKeyboard(event, select)}
                >
                  <path
                    className={className}
                    d={curvedPath(source, target, index + messageEdges.length, exposureEdges.length + messageEdges.length)}
                    strokeWidth={1.5 + Math.min(4, edge.observations)}
                    markerEnd={`url(#social-evidence-graph-arrow-${edge.visibility})`}
                  >
                    <title>{exposureLabel(edge)}</title>
                  </path>
                </g>
              );
            })}

            {positions.map((position) => {
              const selected = position.id === selectedAgentId;
              const select = () => onSelectAgent?.(position.id);
              const radius = 20 + Math.round((position.activity / maxActivity) * 8);
              return (
                <g
                  key={position.id}
                  className={`social-evidence-graph__node${selected ? " is-selected" : ""}`}
                  role={onSelectAgent ? "button" : undefined}
                  tabIndex={onSelectAgent ? 0 : undefined}
                  aria-label={onSelectAgent ? `查看 agent ${position.id} 的社会证据` : position.id}
                  aria-pressed={onSelectAgent ? selected : undefined}
                  onClick={select}
                  onKeyDown={(event) => activateWithKeyboard(event, select)}
                >
                  <circle cx={position.x} cy={position.y} r={radius} />
                  <text x={position.x} y={position.y - 1} textAnchor="middle" className="social-evidence-graph__node-label">
                    {position.id}
                  </text>
                  <text x={position.x} y={position.y + 13} textAnchor="middle" className="social-evidence-graph__node-meta">
                    {`S${nodeMetric(graph, position.id, "sent")} · R${nodeMetric(graph, position.id, "received")} · O${nodeMetric(graph, position.id, "observed")}`}
                  </text>
                  <title>{`${position.id}: sent ${nodeMetric(graph, position.id, "sent")}, received ${nodeMetric(graph, position.id, "received")}, observed ${nodeMetric(graph, position.id, "observed")}`}</title>
                </g>
              );
            })}
          </svg>
        </div>
        <Flex wrap="wrap" gap="small" align="center">
          <Tag>细虚线：已记录 message envelope</Tag>
          <Tag color="success">实线箭头：public exposure</Tag>
          <Tag color="processing">实线箭头：team exposure</Tag>
          <Tag color="warning">实线箭头：private exposure</Tag>
        </Flex>
        <Text type="secondary">
          节点和边只来自 server-projected message / exposure evidence；点击节点查看既有 Agent Inspector，点击边查看可追溯的 trace 与可见性证据。
        </Text>
      </Flex>
    </Card>
  );
}

function nodeMetric(graph: SocialGraph, id: string, field: "sent" | "received" | "observed"): number {
  return graph.nodes.find((node) => node.id === id)?.[field] ?? 0;
}

function curvedPath(
  source: SocialEvidenceGraphNodePosition,
  target: SocialEvidenceGraphNodePosition,
  index: number,
  total: number
): string {
  const midpointX = (source.x + target.x) / 2;
  const midpointY = (source.y + target.y) / 2;
  const vectorX = target.x - source.x;
  const vectorY = target.y - source.y;
  const magnitude = Math.max(1, Math.hypot(vectorX, vectorY));
  const direction = index % 2 === 0 ? 1 : -1;
  const offset = 18 + ((index + total) % 3) * 10;
  const controlX = midpointX + (-vectorY / magnitude) * offset * direction;
  const controlY = midpointY + (vectorX / magnitude) * offset * direction;
  return `M ${source.x} ${source.y} Q ${controlX.toFixed(2)} ${controlY.toFixed(2)} ${target.x} ${target.y}`;
}

function activateWithKeyboard(event: KeyboardEvent<SVGGElement>, action: () => void): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  action();
}

function compareExposureEdges(left: SocialGraphExposureEdge, right: SocialGraphExposureEdge): number {
  return exposureKey(left).localeCompare(exposureKey(right));
}

function exposureKey(edge: SocialGraphExposureEdge): string {
  return [edge.sourceId, edge.targetId, edge.channelId, edge.visibility, edge.kind ?? ""].join("::");
}

function edgeKey(sourceId: string, targetId: string): string {
  return `${sourceId}::${targetId}`;
}

function exposureLabel(edge: SocialGraphExposureEdge): string {
  return `${edge.sourceId} → ${edge.targetId} · ${edge.visibility}/${edge.channelId} · ${edge.observations} 次观察 · ${edge.traceIds.length} 条 trace 证据`;
}
