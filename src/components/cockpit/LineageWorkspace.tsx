import { memo, useMemo } from "react";
import { Alert, Button, Card, Col, Descriptions, Empty, Row, Space, Tabs, Tag, type TableProps } from "antd";
import { ApiOutlined, BranchesOutlined, CodeOutlined, DatabaseOutlined, ReloadOutlined } from "@ant-design/icons";
import { Table, Text, type CheckpointSummary, type ForkLineageSummary, type BranchTreeSummary } from "./appShared";
import { StatusTag, BoundaryTag, decorativeIcon, descriptionItems, shortId, formatDate } from "./appInspectors";
import { CompactKpi } from "./cockpitPanels";

const NODE_TABLE_PAGINATION = { pageSize: 6 } as const;
const CHECKPOINT_TABLE_SCROLL = { x: 1180 } as const;

const codeShortId = (value?: string) => <Text code>{shortId(value)}</Text>;
const dateOrNa = (value?: string) => (value ? formatDate(value) : "n/a");
const statusOrNa = (value?: string) => (value ? <StatusTag status={value} /> : "n/a");

const checkpointNodeColumns: TableProps<NonNullable<BranchTreeSummary["checkpoints"]>[number]>["columns"] = [
  { title: "depth", dataIndex: "depth", width: 72 },
  { title: "checkpoint", dataIndex: "checkpointId", render: codeShortId },
  { title: "created", dataIndex: "createdAt", render: dateOrNa },
  { title: "child forks", dataIndex: "childForkCount", render: (value?: number) => value ?? 0 },
  { title: "native steps", render: (_, node) => node.summary?.counts.nativeSteps ?? "n/a" },
  { title: "messages", render: (_, node) => node.summary?.counts.socialMessages ?? "n/a" }
];
const matchNodeColumns: TableProps<NonNullable<BranchTreeSummary["matches"]>[number]>["columns"] = [
  { title: "depth", dataIndex: "depth", width: 72 },
  { title: "run", dataIndex: "runId", render: codeShortId },
  { title: "match", dataIndex: "matchId", render: (value?: string | null) => (value ? <Text code>{shortId(value)}</Text> : "n/a") },
  { title: "status", dataIndex: "status", render: statusOrNa },
  { title: "native steps", dataIndex: "nativeStepCount", render: (value?: number) => value ?? 0 },
  { title: "messages", dataIndex: "socialMessages", render: (value?: number) => value ?? 0 },
  {
    title: "boundary",
    render: (_, node) => <BoundaryTag status={node.lineage?.boundary?.status} ok={node.lineage?.ok} />
  }
];
const attemptNodeColumns: TableProps<NonNullable<BranchTreeSummary["attempts"]>[number]>["columns"] = [
  { title: "depth", dataIndex: "depth", width: 72 },
  { title: "run", dataIndex: "runId", render: codeShortId },
  { title: "status", dataIndex: "status", render: statusOrNa },
  { title: "updated", dataIndex: "updatedAt", render: dateOrNa },
  { title: "timeout", dataIndex: "timedOut", render: (value?: boolean | null) => (value == null ? "n/a" : String(value)) },
  { title: "failure", dataIndex: "failureCode", render: (value?: string | null) => value ?? "n/a" },
  {
    title: "boundary",
    render: (_, node) => <BoundaryTag status={node.boundary?.status} ok={node.boundary?.ok} />
  }
];
const edgeColumns: TableProps<NonNullable<BranchTreeSummary["edges"]>[number]>["columns"] = [
  { title: "kind", dataIndex: "kind", render: (value?: string) => <Tag>{value ?? "edge"}</Tag> },
  {
    title: "from",
    render: (_, edge) => <Text code>{shortId(edge.fromCheckpointId ?? edge.fromRunId)}</Text>
  },
  {
    title: "to",
    render: (_, edge) => <Text code>{shortId(edge.toRunId ?? edge.toCheckpointId)}</Text>
  },
  { title: "ok", dataIndex: "ok", render: (value?: boolean) => (value === undefined ? "n/a" : <Tag color={value ? "success" : "error"}>{String(value)}</Tag>) },
  { title: "boundary", dataIndex: "boundaryStatus", render: (value?: string) => value ?? "n/a" }
];

export const LineageWorkspace = memo(function LineageWorkspace({
  currentMatchId,
  checkpoints,
  selectedCheckpointId,
  forkLineage,
  branchTree,
  replayBoundaryNativeStepCount,
  operatorEnabled,
  busy,
  onRefreshCheckpoints,
  onCreateCheckpoint,
  onForkCheckpoint,
  onLoadForkLineage,
  onSelectCheckpoint,
  onLoadBranchTree,
  onInspectCheckpoint,
  onInspectForkLineage,
  onInspectBranchTree
}: {
  currentMatchId: string;
  checkpoints: CheckpointSummary[];
  selectedCheckpointId: string;
  forkLineage: ForkLineageSummary | null;
  branchTree: BranchTreeSummary | null;
  replayBoundaryNativeStepCount: number | null;
  operatorEnabled: boolean;
  busy: string | null;
  onRefreshCheckpoints: () => void;
  onCreateCheckpoint: () => void;
  onForkCheckpoint: (checkpoint: CheckpointSummary) => void;
  onLoadForkLineage: () => void;
  onSelectCheckpoint: (checkpoint: CheckpointSummary) => void;
  onLoadBranchTree: (checkpointId?: string) => void;
  onInspectCheckpoint: (checkpoint: CheckpointSummary) => void;
  onInspectForkLineage: () => void;
  onInspectBranchTree: () => void;
}) {
  const selectedCheckpoint = checkpoints.find((checkpoint) => checkpoint.checkpointId === selectedCheckpointId) ?? null;
  const checkpointColumns: TableProps<CheckpointSummary>["columns"] = useMemo(() => [
    {
      title: "checkpoint",
      fixed: "left",
      render: (_, checkpoint) => (
        <Button type="link" size="small" onClick={() => onInspectCheckpoint(checkpoint)}>
          <Text code>{shortId(checkpoint.checkpointId)}</Text>
        </Button>
      )
    },
    { title: "created", dataIndex: "createdAt", render: formatDate },
    { title: "reason", dataIndex: "reason", ellipsis: true, render: (value?: string | null) => value ?? "n/a" },
    { title: "source run", render: (_, checkpoint) => <Text code>{shortId(checkpoint.source.runId)}</Text> },
    { title: "trace", render: (_, checkpoint) => (checkpoint.source.boundaryTraceRef ? <Text code>{checkpoint.source.boundaryTraceRef}</Text> : "initial") },
    { title: "native turn", render: (_, checkpoint) => checkpoint.source.boundaryTurnIndex ?? "n/a" },
    { title: "native steps", render: (_, checkpoint) => checkpoint.counts.nativeSteps },
    {
      title: "committed",
      render: (_, checkpoint) =>
        typeof checkpoint.counts.committedSteps === "number" ? checkpoint.counts.committedSteps : "n/a"
    },
    {
      title: "rejected",
      render: (_, checkpoint) =>
        typeof checkpoint.counts.rejectedSteps === "number" ? checkpoint.counts.rejectedSteps : "n/a"
    },
    { title: "messages", render: (_, checkpoint) => checkpoint.counts.socialMessages },
    { title: "state hash", render: (_, checkpoint) => <Text code>{shortId(checkpoint.source.stateHash)}</Text> },
    {
      title: "选择",
      fixed: "right",
      align: "right",
      render: (_, checkpoint) => (
        <Space size={2}>
          <Button
            size="small"
            type={selectedCheckpointId === checkpoint.checkpointId ? "primary" : "default"}
            disabled={!operatorEnabled}
            aria-label={`选择 checkpoint ${shortId(checkpoint.checkpointId)}`}
            onClick={() => onSelectCheckpoint(checkpoint)}
          >
            选择
          </Button>
          <Button
            size="small"
            icon={decorativeIcon(<BranchesOutlined />)}
            loading={busy === "branch-tree" && selectedCheckpointId === checkpoint.checkpointId}
            disabled={!operatorEnabled || Boolean(busy)}
            aria-label={`加载 checkpoint ${shortId(checkpoint.checkpointId)} 的 branch tree`}
            onClick={() => onLoadBranchTree(checkpoint.checkpointId)}
          >
            Tree
          </Button>
          <Button
            size="small"
            icon={decorativeIcon(<BranchesOutlined />)}
            loading={busy === `checkpoint:fork:${checkpoint.checkpointId}`}
            disabled={!operatorEnabled || (Boolean(busy) && busy !== `checkpoint:fork:${checkpoint.checkpointId}`)}
            aria-label={`从 checkpoint ${shortId(checkpoint.checkpointId)} 创建 fork`}
            onClick={(event) => {
              event.stopPropagation();
              onForkCheckpoint(checkpoint);
            }}
          >
            Fork
          </Button>
        </Space>
      )
    },
    {
      title: "证据",
      fixed: "right",
      align: "right",
      render: (_, checkpoint) => (
        <Button
          size="small"
          icon={decorativeIcon(<CodeOutlined />)}
          disabled={!operatorEnabled}
          aria-label={`查看 checkpoint ${shortId(checkpoint.checkpointId)} 证据`}
          onClick={() => onInspectCheckpoint(checkpoint)}
        >
          证据
        </Button>
      )
    }
  ], [busy, onForkCheckpoint, onInspectCheckpoint, onLoadBranchTree, onSelectCheckpoint, operatorEnabled, selectedCheckpointId]);

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <div className="cockpit-kpi-strip" aria-label="谱系摘要">
        <CompactKpi label="Checkpoint" value={String(checkpoints.length)} detail={currentMatchId ? shortId(currentMatchId) : "未选择 run"} />
        <CompactKpi label="Selected prefix" value={String(selectedCheckpoint?.counts.nativeSteps ?? 0)} detail="native steps" />
        <CompactKpi label="Fork lineage" value={forkLineage ? (forkLineage.isFork ? "fork" : "root") : "待加载"} detail={forkLineage?.boundary?.status ?? "未加载"} />
        <CompactKpi label="Branch tree" value={String(branchTree?.counts?.edges ?? 0)} detail={`${branchTree?.counts?.matches ?? 0} matches · ${branchTree?.counts?.attempts ?? 0} attempts`} />
      </div>

      <Card
        title="Checkpoint Registry"
        extra={
          <Space wrap>
            <Button icon={decorativeIcon(<ReloadOutlined />)} loading={busy === "checkpoints"} disabled={!operatorEnabled || !currentMatchId || Boolean(busy)} onClick={onRefreshCheckpoints}>
              刷新 checkpoint
            </Button>
            <Button
              type="primary"
              icon={decorativeIcon(<DatabaseOutlined />)}
              loading={busy === "checkpoint:create"}
              disabled={!operatorEnabled || !currentMatchId || Boolean(busy)}
              aria-label={
                replayBoundaryNativeStepCount === null
                  ? "创建最终边界 checkpoint"
                  : `创建 replay native ${replayBoundaryNativeStepCount} checkpoint`
              }
              onClick={onCreateCheckpoint}
            >
              {replayBoundaryNativeStepCount === null
                ? "创建最终 checkpoint"
                : `创建 replay #${replayBoundaryNativeStepCount} checkpoint`}
            </Button>
          </Space>
        }
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          {!operatorEnabled ? (
            <Alert
              type="info"
              showIcon
              title="当前连接没有 checkpoint operator 能力"
              description="Cockpit 同时检查 postgame-redacted 视图与 /api/config capabilities；缺少 registry、create 或 fork 任一能力时都会 fail closed。"
            />
          ) : null}
          <Text type="secondary">
            {replayBoundaryNativeStepCount === null
              ? "当前 selector：artifact 最终边界。先在回放或领域事件账本定位服务端帧，可创建 prefix checkpoint。"
              : `当前 selector：服务端 replay native #${replayBoundaryNativeStepCount}；创建时会提交该 nativeStepCount。`}
          </Text>
          <Text type="secondary">列表来自 `/api/checkpoints?matchId=...`，只展示 summary，不读取 full checkpoint artifact。</Text>
          <Table
            rowKey="checkpointId"
            size="small"
            bordered
            columns={checkpointColumns}
            dataSource={checkpoints}
            pagination={NODE_TABLE_PAGINATION}
            rowSelection={{
              type: "radio",
              selectedRowKeys: selectedCheckpointId ? [selectedCheckpointId] : []
            }}
            onRow={(checkpoint) => ({ onClick: () => onSelectCheckpoint(checkpoint) })}
            scroll={CHECKPOINT_TABLE_SCROLL}
            locale={{ emptyText: <Empty description="当前 run 没有 checkpoint。点击“创建 checkpoint”会调用真实服务端 API。" /> }}
          />
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xxl={10}>
          <Card
            title="Fork Lineage"
            extra={
              <Space wrap>
                {forkLineage ? <BoundaryTag status={forkLineage.boundary?.status} ok={forkLineage.ok} /> : <Tag>未加载</Tag>}
                <Button icon={decorativeIcon(<ApiOutlined />)} loading={busy === "fork-lineage"} disabled={!operatorEnabled || !currentMatchId || Boolean(busy)} onClick={onLoadForkLineage}>
                  加载 lineage
                </Button>
                <Button icon={decorativeIcon(<CodeOutlined />)} disabled={!operatorEnabled || !forkLineage} onClick={onInspectForkLineage}>
                  证据
                </Button>
              </Space>
            }
          >
            {forkLineage ? (
              <Descriptions
                size="small"
                bordered
                column={1}
                items={descriptionItems([
                  ["run", forkLineage.runId ?? "n/a"],
                  ["match", forkLineage.matchId ?? "n/a"],
                  ["is fork", String(Boolean(forkLineage.isFork))],
                  ["ok", String(Boolean(forkLineage.ok))],
                  ["boundary", forkLineage.boundary?.status ?? "n/a"],
                  ["checkpoint found", String(forkLineage.boundary?.checkpointFound ?? false)],
                  ["state hash match", String(forkLineage.boundary?.stateHashMatches ?? "n/a")],
                  ["message prefix", String(forkLineage.boundary?.messagePrefixMatchesCheckpoint ?? "n/a")],
                  ["new native steps", forkLineage.boundary?.newNativeSteps ?? "n/a"],
                  ["new committed", forkLineage.boundary?.newCommittedSteps ?? "n/a"],
                  ["new rejected", forkLineage.boundary?.newRejectedSteps ?? "n/a"],
                  ["child committed", forkLineage.child?.committedSteps ?? "n/a"],
                  ["child rejected", forkLineage.child?.rejectedSteps ?? "n/a"],
                  ["new messages", forkLineage.boundary?.newSocialMessages ?? "n/a"]
                ])}
              />
            ) : (
              <Empty description="点击“加载 lineage”，读取 `/api/matches/:id/fork-lineage`。" />
            )}
          </Card>
        </Col>
        <Col xs={24} xxl={14}>
          <Card
            title="Branch Tree Summary"
            extra={
              <Space wrap>
                {branchTree ? <Tag color={branchTree.truncation?.isTruncated ? "warning" : "success"}>{branchTree.truncation?.isTruncated ? "truncated" : "complete"}</Tag> : <Tag>未加载</Tag>}
                <Button
                  icon={decorativeIcon(<BranchesOutlined />)}
                  loading={busy === "branch-tree"}
                  disabled={!operatorEnabled || !selectedCheckpointId || Boolean(busy)}
                  onClick={() => onLoadBranchTree(selectedCheckpointId)}
                >
                  加载 branch tree
                </Button>
                <Button icon={decorativeIcon(<CodeOutlined />)} disabled={!operatorEnabled || !branchTree} onClick={onInspectBranchTree}>
                  证据
                </Button>
              </Space>
            }
          >
            {branchTree ? (
              <Descriptions
                size="small"
                bordered
                column={{ xs: 1, sm: 2 }}
                items={descriptionItems([
                  ["root", branchTree.rootCheckpointId ?? "n/a"],
                  ["ok", String(Boolean(branchTree.ok))],
                  ["ok scope", branchTree.okScope ?? "n/a"],
                  ["checkpoints", branchTree.counts?.checkpoints ?? 0],
                  ["matches", branchTree.counts?.matches ?? 0],
                  ["attempts", branchTree.counts?.attempts ?? 0],
                  ["failed attempts", branchTree.counts?.failedAttempts ?? 0],
                  ["edges", branchTree.counts?.edges ?? 0],
                  ["max depth", branchTree.counts?.maxDepth ?? 0],
                  ["truncated", String(Boolean(branchTree.truncation?.isTruncated))]
                ])}
              />
            ) : (
              <Empty description="选择 checkpoint 后加载 branch tree，展示 fork/checkpoint 谱系摘要。" />
            )}
          </Card>
        </Col>
      </Row>

      <Card title="Branch Tree Nodes" extra={<Tag>summary API</Tag>}>
        <Tabs
          items={[
            {
              key: "checkpoint-nodes",
              label: `Checkpoints ${branchTree?.checkpoints?.length ?? 0}`,
              children: (
                <Table
                  rowKey={(node) => node.checkpointId ?? node.summary?.checkpointId ?? `${node.depth}-${node.createdAt}`}
                  size="small"
                  bordered
                  columns={checkpointNodeColumns}
                  dataSource={branchTree?.checkpoints ?? []}
                  pagination={NODE_TABLE_PAGINATION}
                  locale={{ emptyText: <Empty description="branch tree 尚未返回 checkpoint nodes。" /> }}
                />
              )
            },
            {
              key: "match-nodes",
              label: `Matches ${branchTree?.matches?.length ?? 0}`,
              children: (
                <Table
                  rowKey={(node) => node.runId ?? `${node.depth}-${node.createdAt}`}
                  size="small"
                  bordered
                  columns={matchNodeColumns}
                  dataSource={branchTree?.matches ?? []}
                  pagination={NODE_TABLE_PAGINATION}
                  locale={{ emptyText: <Empty description="branch tree 尚未返回 forked match nodes。" /> }}
                />
              )
            },
            {
              key: "attempt-nodes",
              label: `Attempts ${branchTree?.attempts?.length ?? 0}`,
              children: (
                <Table
                  rowKey={(node) => node.runId ?? `${node.depth}-${node.createdAt}`}
                  size="small"
                  bordered
                  columns={attemptNodeColumns}
                  dataSource={branchTree?.attempts ?? []}
                  pagination={NODE_TABLE_PAGINATION}
                  locale={{ emptyText: <Empty description="branch tree 尚未返回未完成或失败的 fork attempts。" /> }}
                />
              )
            },
            {
              key: "edges",
              label: `Edges ${branchTree?.edges?.length ?? 0}`,
              children: (
                <Table
                  rowKey={(edge) => edge.id ?? `${edge.kind}-${edge.fromCheckpointId ?? edge.fromRunId}-${edge.toRunId ?? edge.toCheckpointId}`}
                  size="small"
                  bordered
                  columns={edgeColumns}
                  dataSource={branchTree?.edges ?? []}
                  pagination={NODE_TABLE_PAGINATION}
                  locale={{ emptyText: <Empty description="branch tree 尚未返回 edges。" /> }}
                />
              )
            }
          ]}
        />
      </Card>
    </Space>
  );
});
