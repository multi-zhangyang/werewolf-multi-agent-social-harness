import { Button, Empty, Flex, Table as AntTable, Tag, Typography } from "antd";
import type { TableProps } from "antd";
import { EyeOutlined, MessageOutlined, NodeIndexOutlined, TeamOutlined } from "@ant-design/icons";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import type { PostgameMatchProjectionDto, SocialNetworkCommunicationEdgeDto, SocialNetworkExposureEdgeDto, SocialNetworkProjectionDto, SocialNetworkRelationshipEdgeDto } from "../../server/artifactProjection";
import type { AgentHarnessState } from "../../harness/types";
import type { SocialMessage } from "../../harness/social";
import { socialStateRetentionWindow } from "../../harness/socialState";

const SocialEvidenceGraph = lazy(async () => {
  const module = await import("./SocialEvidenceGraph");
  return { default: module.SocialEvidenceGraph };
});

const { Text, Title } = Typography;

type Artifact = Pick<PostgameMatchProjectionDto, "projection" | "socialNetwork">;

function EvidenceTable<RecordType extends object>(props: TableProps<RecordType>) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const regions = hostRef.current?.querySelectorAll<HTMLElement>(".ant-table-content, .ant-table-body") ?? [];
    for (const region of regions) {
      region.tabIndex = 0;
      region.setAttribute("aria-label", "可横向滚动的社会证据表");
    }
  });
  return (
    <div ref={hostRef} className="cockpit-table-host">
      <AntTable {...props} scroll={props.scroll ?? { x: "max-content" }} />
    </div>
  );
}

export function SocietyEvidenceWorkspace({
  artifact,
  agents,
  selectedAgent,
  messages,
  onSelectAgent,
  onSelectMessage,
  onInspectExposure,
  onInspectRelationship,
  onInspectCommunication
}: {
  artifact: Artifact | null;
  agents: AgentHarnessState[];
  selectedAgent: AgentHarnessState | null;
  messages: SocialMessage[];
  onSelectAgent: (agent: AgentHarnessState) => void;
  onSelectMessage: (message: SocialMessage) => void;
  onInspectExposure: (edges: readonly SocialNetworkExposureEdgeDto[]) => void;
  onInspectRelationship: (edge: SocialNetworkRelationshipEdgeDto) => void;
  onInspectCommunication: (edges: readonly SocialNetworkCommunicationEdgeDto[]) => void;
}) {
  const network = artifact?.socialNetwork ?? null;
  const relationshipEdges = network?.relationshipEdges ?? [];
  const exposureEdges = network?.exposureEdges ?? [];
  const socialJournalRows = useMemo(() => readRelationshipJournalRows(agents), [agents]);
  const visibilityCounts = useMemo(() => countVisibility(messages), [messages]);
  const relationshipEvidenceCount = relationshipEdges.reduce((sum, edge) => sum + edge.evidenceRefs.length, 0);
  const exposureObservationCount = exposureEdges.reduce((sum, edge) => sum + edge.observationCount, 0);
  const deliveryCount = network?.nodes.reduce((sum, node) => sum + node.deliveryCount, 0) ?? 0;
  const journalWindow = useMemo(() => summarizeJournalWindows(agents), [agents]);

  const agentColumns: TableProps<AgentHarnessState>["columns"] = [
    { title: "Agent", dataIndex: "playerId", width: 62, render: (id: string) => <Text code>{id}</Text> },
    { title: "策略", dataIndex: "policyName", ellipsis: true },
    {
      title: "观察 / 关系",
      width: 76,
      render: (_, row) => `${row.observations} / ${network?.nodes.find((node) => node.id === row.playerId)?.relationshipCount ?? 0}`
    }
  ];
  const messageColumns: TableProps<SocialMessage>["columns"] = [
    { title: "序号", dataIndex: "seq", width: 72 },
    { title: "发送者", dataIndex: "senderId", render: (id: string) => <Text code>{id}</Text> },
    { title: "通道", dataIndex: "channelId" },
    { title: "可见性", dataIndex: "visibility", render: (visibility: SocialMessage["visibility"]) => <VisibilityTag visibility={visibility} /> },
    { title: "内容", dataIndex: "content", ellipsis: true },
    {
      title: "证据",
      width: 72,
      render: (_, row) => <Button type="link" size="small" aria-label={`查看消息 ${row.seq}`} onClick={() => onSelectMessage(row)}>查看</Button>
    }
  ];
  const exposureColumns: TableProps<SocialNetworkExposureEdgeDto>["columns"] = [
    { title: "来源", dataIndex: "sourceId", render: (id: string) => <Text code>{id}</Text> },
    { title: "观察者", dataIndex: "targetId", render: (id: string) => <Text code>{id}</Text> },
    { title: "观察次数", dataIndex: "observationCount" },
    { title: "消息数", dataIndex: "uniqueMessageCount" },
    { title: "证据", dataIndex: "evidenceCount" },
    { title: "trace", render: (_, row) => row.traceIds.map(shortId).join(", ") || "—" },
    {
      title: "查看",
      width: 72,
      render: (_, row) => <Button type="link" size="small" aria-label={`查看观察证据 ${row.sourceId} ${row.targetId}`} onClick={() => onInspectExposure([row])}>打开</Button>
    }
  ];
  const relationshipColumns: TableProps<SocialNetworkRelationshipEdgeDto>["columns"] = [
    { title: "观察者 → 目标", render: (_, row) => <Text code>{row.sourceId} → {row.targetId}</Text> },
    { title: "信任", dataIndex: "trust", render: formatScore },
    { title: "怀疑", dataIndex: "suspicion", render: formatScore },
    { title: "影响", dataIndex: "influence", render: formatScore },
    { title: "威胁", dataIndex: "threat", render: formatScore },
    { title: "证据", render: (_, row) => row.evidenceRefs.length },
    { title: "更新", dataIndex: "updatedAt", render: (value: string) => formatDate(value) },
    { title: "查看", width: 72, render: (_, row) => <Button type="link" size="small" aria-label={`查看关系证据 ${row.sourceId} ${row.targetId}`} onClick={() => onInspectRelationship(row)}>打开</Button> }
  ];

  return (
    <div className="society-workspace">
      <header className="workspace-heading">
        <div>
          <Title level={2} className="workspace-heading__title">社会证据工作台</Title>
          <Text type="secondary">只呈现服务端发布的关系快照、通信投递和 scoped observation；不把消息路由当作关系。</Text>
        </div>
        <Flex gap={6} wrap>
          <Tag color={artifact?.projection.view === "truth-redacted" ? "gold" : "processing"}>{artifact?.projection.view ?? "未加载工件"}</Tag>
          <Tag>{network?.scope ?? "无社会投影"}</Tag>
        </Flex>
      </header>

      <div className="society-summary-strip" aria-label="社会证据摘要">
        <SummaryItem icon={<TeamOutlined />} label="Agent" value={agents.length} detail="服务端快照" />
        <SummaryItem icon={<MessageOutlined />} label="消息" value={messages.length} detail={`${deliveryCount} 次投递`} />
        <SummaryItem icon={<EyeOutlined />} label="实际观察" value={exposureObservationCount} detail={`${exposureEdges.length} 条方向边`} />
        <SummaryItem icon={<NodeIndexOutlined />} label="关系证据" value={relationshipEvidenceCount} detail={`${relationshipEdges.length} 条主观边`} />
      </div>

      <div className="society-primary-grid">
        <section className="society-panel society-panel--agents" aria-labelledby="society-agents-title">
          <div className="society-panel__heading">
            <div><Title level={4} id="society-agents-title">Agent roster</Title><Text type="secondary">选择行或矩阵轴查看单个视角</Text></div>
            <Flex gap={4} wrap>
              <Tag color="success">public {visibilityCounts.public}</Tag>
              <Tag color="processing">team {visibilityCounts.team}</Tag>
              <Tag color="warning">private {visibilityCounts.private}</Tag>
            </Flex>
          </div>
          <EvidenceTable
            rowKey="playerId"
            size="small"
            bordered={false}
            columns={agentColumns}
            scroll={{ x: 248 }}
            dataSource={agents}
            pagination={{ pageSize: 7, size: "small" }}
            rowSelection={{
              type: "radio",
              selectedRowKeys: selectedAgent?.playerId ? [selectedAgent.playerId] : [],
              onSelect: (agent) => onSelectAgent(agent)
            }}
            onRow={(agent) => ({ onClick: () => onSelectAgent(agent) })}
            locale={{ emptyText: <Empty description="当前投影没有 Agent 状态。" /> }}
          />
        </section>

        <section className="society-panel society-panel--matrix" aria-labelledby="society-matrix-title">
          <Suspense fallback={<div className="workspace-loading">正在加载社会证据矩阵…</div>}>
            <SocialEvidenceGraph
              network={network}
              selectedAgentId={selectedAgent?.playerId}
              onSelectAgent={(id) => {
                const agent = agents.find((candidate) => candidate.playerId === id);
                if (agent) onSelectAgent(agent);
              }}
              onSelectExposure={onInspectExposure}
              onSelectRelationship={onInspectRelationship}
              onSelectCommunication={onInspectCommunication}
            />
          </Suspense>
        </section>

        <section className="society-panel society-panel--selected" aria-labelledby="society-selected-title">
          <div className="society-panel__heading"><Title level={4} id="society-selected-title">选中 Agent</Title><Tag>server projection</Tag></div>
          {selectedAgent ? (
            <dl className="society-detail-list">
              <DetailRow label="Agent" value={selectedAgent.playerId} />
              <DetailRow label="模型" value={selectedAgent.model} />
              <DetailRow label="策略" value={selectedAgent.policyName} />
              <DetailRow label="观察" value={String(selectedAgent.observations)} />
              <DetailRow label="关系边" value={String(network?.nodes.find((node) => node.id === selectedAgent.playerId)?.relationshipCount ?? 0)} />
              <DetailRow label="社会状态" value={selectedAgent.socialStateHash ? shortId(selectedAgent.socialStateHash) : "未发布"} mono />
            </dl>
          ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择 Agent 查看其服务端快照。" />}
        </section>
      </div>

      <section className="society-panel society-panel--evidence" aria-labelledby="society-relationship-title">
        <div className="society-panel__heading"><div><Title level={4} id="society-relationship-title">关系认知</Title><Text type="secondary">每一行都是一个有向主观判断，数值和 evidence refs 直接来自 Agent 社会状态。</Text></div><Tag>{relationshipEdges.length} edges</Tag></div>
        <EvidenceTable rowKey="id" size="small" bordered={false} columns={relationshipColumns} dataSource={relationshipEdges} locale={{ emptyText: network?.modes.relationships.reason ?? "当前工件没有关系边。" }} />
      </section>

      <div className="society-evidence-grid">
        <section className="society-panel" aria-labelledby="society-exposure-title">
          <div className="society-panel__heading"><div><Title level={4} id="society-exposure-title">实际观察证据</Title><Text type="secondary">实际被某个 Agent 在某个提交边界观察到的消息。</Text></div><Tag>{exposureEdges.length} edges</Tag></div>
          <EvidenceTable rowKey="id" size="small" bordered={false} columns={exposureColumns} dataSource={exposureEdges} pagination={{ pageSize: 6 }} locale={{ emptyText: network?.modes.exposure.reason ?? "没有 scoped observation 记录。" }} />
        </section>
        <section className="society-panel" aria-labelledby="society-messages-title">
          <div className="society-panel__heading"><div><Title level={4} id="society-messages-title">通信记录</Title><Text type="secondary">投递声明不是阅读或影响的证明。</Text></div><Tag>{messages.length} messages</Tag></div>
          <EvidenceTable rowKey="id" size="small" bordered={false} columns={messageColumns} dataSource={messages} pagination={{ pageSize: 6 }} locale={{ emptyText: "当前工件没有通信记录。" }} />
        </section>
      </div>

      <section className="society-panel" aria-labelledby="society-journal-title">
        <div className="society-panel__heading">
          <div><Title level={4} id="society-journal-title">关系变更保留窗口</Title><Text type="secondary">仅列出当前保留的 relationships mutation；不把窗口外事实解释为未发生。</Text></div>
          <Flex gap={6} wrap><Tag>{socialJournalRows.length} rows</Tag><Tag color={journalWindow.tone}>{journalWindow.label}</Tag></Flex>
        </div>
        <EvidenceTable rowKey="key" size="small" bordered={false} columns={journalColumns()} dataSource={socialJournalRows} pagination={{ pageSize: 8 }} locale={{ emptyText: journalWindow.emptyText }} />
      </section>
    </div>
  );
}

function SummaryItem({ icon, label, value, detail }: { icon: ReactNode; label: string; value: number; detail: string }) {
  return <div className="society-summary-item"><span className="society-summary-item__icon">{icon}</span><span><small>{label}</small><strong>{value}</strong><em>{detail}</em></span></div>;
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="society-detail-row"><dt>{label}</dt><dd className={mono ? "is-mono" : undefined}>{value}</dd></div>;
}

function VisibilityTag({ visibility }: { visibility: SocialMessage["visibility"] }) {
  const color = visibility === "public" ? "success" : visibility === "team" ? "processing" : visibility === "private" ? "warning" : "purple";
  return <Tag color={color}>{visibility}</Tag>;
}

function formatScore(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 8) : value;
}

function countVisibility(messages: SocialMessage[]): Record<SocialMessage["visibility"], number> {
  return messages.reduce<Record<SocialMessage["visibility"], number>>((counts, message) => {
    counts[message.visibility] += 1;
    return counts;
  }, { public: 0, team: 0, private: 0, postgame: 0 });
}

function readRelationshipJournalRows(agents: AgentHarnessState[]): Array<Record<string, unknown> & { key: string }> {
  return agents.flatMap((agent) => (agent.social?.journal?.entries ?? [])
    .filter((entry) => entry.store === "relationships")
    .map((entry) => ({
      key: `${agent.playerId}-${entry.journalSeq}`,
      journalSeq: entry.journalSeq,
      owner: agent.playerId,
      mutationKind: entry.mutationKind,
      subjectId: entry.subjectId ?? "—",
      traceId: entry.traceId ?? "—",
      evidenceCount: entry.evidenceRefs.length
    })));
}

function summarizeJournalWindows(agents: AgentHarnessState[]): { label: string; tone?: "warning" | "error"; emptyText: string } {
  const journals = agents.flatMap((agent) => agent.social?.journal ? [socialStateRetentionWindow(agent.social.journal)] : []);
  const unavailable = agents.length - journals.length;
  const incomplete = journals.filter((window) => !window.windowComplete).length;
  if (unavailable > 0) {
    return {
      label: `${unavailable} Agent 未发布窗口`,
      tone: "error",
      emptyText: "当前发布的 Agent 快照没有完整 journal；不能据此判断关系是否曾变更。"
    };
  }
  if (incomplete > 0) {
    return {
      label: `${incomplete} Agent 窗口不完整`,
      tone: "warning",
      emptyText: "当前保留窗口未包含关系变更；更早 mutation 可能已裁剪。"
    };
  }
  return { label: "窗口完整", emptyText: "完整保留窗口中没有关系变更记录。" };
}

function journalColumns(): TableProps<Record<string, unknown> & { key: string }>["columns"] {
  return [
    { title: "#", dataIndex: "journalSeq", width: 64 },
    { title: "Agent", dataIndex: "owner", render: (value: string) => <Text code>{value}</Text> },
    { title: "变更", dataIndex: "mutationKind" },
    { title: "目标", dataIndex: "subjectId" },
    { title: "trace", dataIndex: "traceId", render: (value: string) => <Text code>{shortId(value)}</Text> },
    { title: "证据", dataIndex: "evidenceCount" }
  ];
}
