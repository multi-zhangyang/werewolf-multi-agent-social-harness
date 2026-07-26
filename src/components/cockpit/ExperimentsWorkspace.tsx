import { memo } from "react";
import { Alert, Button, Card, Col, Empty, Row, Select, Space, Statistic, Tag, type TableProps } from "antd";
import { ExperimentOutlined, ReloadOutlined } from "@ant-design/icons";
import { Table, Text, type ExperimentMatrixSubjectStat, type ExperimentMatrixPairwiseComparison, type ExperimentMatrixCellSummary, type ExperimentMatrixArtifactSetSummary, type ExperimentMatrixRunResponse } from "./appShared";
import { decorativeIcon, shortId, formatMatrixPValue, matrixArtifactDownloadEntries, formatDate } from "./appInspectors";

const MATRIX_TABLE_PAGINATION = { pageSize: 6 } as const;
const GAMES_OPTIONS = ["1", "2", "3", "5"].map((value) => ({ value, label: `${value} games` }));
const EXPORT_MODE_OPTIONS = [
  { value: "summary", label: "仅返回服务端摘要" },
  { value: "export", label: "导出本地研究工件" }
];
const codeText = (value: string) => <Text code>{value}</Text>;
const cellColumns: TableProps<ExperimentMatrixCellSummary>["columns"] = [
  { title: "cell", dataIndex: "label", render: (value: string, row) => <Text>{value || row.id}</Text> },
  { title: "group", dataIndex: "group", responsive: ["md"] },
  { title: "models", dataIndex: "models", render: (models: string[]) => models.join(", ") || "n/a" },
  {
    title: "lifecycle",
    dataIndex: "status",
    render: (value: ExperimentMatrixCellSummary["status"]) => (
      <Tag color={value === "completed" ? "success" : value === "truncated" ? "warning" : "error"}>{value}</Tag>
    )
  },
  { title: "completed", dataIndex: "gamesCompleted", align: "right" },
  { title: "truncated", dataIndex: "gamesTruncated", align: "right" },
  { title: "failed", dataIndex: "gamesFailed", align: "right" },
  { title: "unstarted", dataIndex: "gamesUnstarted", align: "right" },
  { title: "elapsed", dataIndex: "elapsedMs", render: (value: number) => `${value}ms`, responsive: ["lg"] },
  { title: "error", dataIndex: "error", render: (value?: string | null) => value ?? "—", responsive: ["lg"] }
];
const statColumns: TableProps<ExperimentMatrixSubjectStat>["columns"] = [
  { title: "subject", dataIndex: "subjectId", render: codeText },
  { title: "model", dataIndex: "model", render: (value?: string) => value ?? "—" },
  { title: "policy", dataIndex: "policyName", render: (value?: string) => value ?? "—", responsive: ["lg"] },
  { title: "seats", dataIndex: "seatGames", align: "right" },
  { title: "wins/losses", render: (_, row) => `${row.wins}/${row.losses}` },
  { title: "win rate", dataIndex: "winRate", render: (value: number) => `${(value * 100).toFixed(1)}%` },
  { title: "mean reward", dataIndex: "rewardMean", render: (value: number) => value.toFixed(3), responsive: ["md"] }
];
const comparisonColumns: TableProps<ExperimentMatrixPairwiseComparison>["columns"] = [
  { title: "left", dataIndex: "leftModel", render: codeText },
  { title: "right", dataIndex: "rightModel", render: codeText },
  { title: "seat rows", render: (_, row) => `${row.leftSeatGames}/${row.rightSeatGames}` },
  { title: "Δ win rate", dataIndex: "winRateDiff", render: (value: number) => value.toFixed(4) },
  { title: "p / Holm", render: (_, row) => `${formatMatrixPValue(row.pValueTwoSided)} / ${formatMatrixPValue(row.pValueHolm)}` },
  { title: "boundary", dataIndex: "warning", render: (value: string) => <Text type="secondary">{value}</Text>, responsive: ["xl"] }
];
const artifactSetColumns: TableProps<ExperimentMatrixArtifactSetSummary>["columns"] = [
  { title: "set", dataIndex: "artifactSetId", render: (value: string) => <Text code>{shortId(value)}</Text> },
  { title: "matrix", dataIndex: "matrixId", ellipsis: true },
  { title: "created", dataIndex: "createdAt", render: formatDate },
  {
    title: "registered downloads",
    render: (_, row: ExperimentMatrixArtifactSetSummary) => (
      <Space wrap>
        {matrixArtifactDownloadEntries(row.downloads).map((file) => (
          <Button key={file.key} size="small" type="link" href={file.href} target="_blank" rel="noreferrer">
            {file.label}
          </Button>
        ))}
      </Space>
    )
  }
];

export const ExperimentsWorkspace = memo(function ExperimentsWorkspace({
  result,
  artifactSets,
  games,
  exportArtifacts,
  exportAvailable,
  rosterSummary,
  experimentReady,
  maxTransitions,
  timeoutSeconds,
  busy,
  onGamesChange,
  onExportArtifactsChange,
  onRun,
  onRefreshArtifacts
}: {
  result: ExperimentMatrixRunResponse | null;
  artifactSets: ExperimentMatrixArtifactSetSummary[];
  games: string;
  exportArtifacts: boolean;
  exportAvailable: boolean;
  rosterSummary: string;
  experimentReady: boolean;
  maxTransitions: string;
  timeoutSeconds: string;
  busy: string | null;
  onGamesChange: (value: string) => void;
  onExportArtifactsChange: (value: boolean) => void;
  onRun: () => void;
  onRefreshArtifacts: () => void;
}) {
  const cells = result?.cells ?? [];
  const statistics = result?.statistics;
  const summary = result?.summary;

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="实验矩阵控制面"
        extra={
          <Space wrap>
            <Select
              aria-label="矩阵游戏局数"
              style={{ width: 120 }}
              value={games}
              disabled={Boolean(busy)}
              options={GAMES_OPTIONS}
              onChange={onGamesChange}
            />
            <Select
              aria-label="导出矩阵研究工件"
              style={{ width: 190 }}
              value={exportArtifacts ? "export" : "summary"}
              disabled={Boolean(busy) || !exportAvailable}
              options={EXPORT_MODE_OPTIONS}
              onChange={(value) => onExportArtifactsChange(value === "export")}
            />
            <Button icon={decorativeIcon(<ReloadOutlined />)} loading={busy === "matrix-artifacts"} disabled={Boolean(busy)} onClick={onRefreshArtifacts}>
              刷新研究工件
            </Button>
            <Button
              type="primary"
              icon={decorativeIcon(<ExperimentOutlined />)}
              loading={busy === "matrix-run"}
              disabled={!experimentReady || Boolean(busy)}
              onClick={onRun}
            >
              运行矩阵
            </Button>
          </Space>
        }
      >
        <Space orientation="vertical" size="small" style={{ width: "100%" }}>
          <Text type="secondary">
            该工作区提交 `POST /api/experiments/matrix/run`，由 harness 调度 cell 与 tournament；当前编排={rosterSummary}
            、games={games}、maxTransitions={maxTransitions || "n/a"}、timeout={timeoutSeconds || "n/a"}s。
          </Text>
          <Text type="secondary">
            completed、truncated、partial、failed 是不同的生命周期；unstarted 表示控制面在 deadline 后未启动的局。截断与未启动记录仍保留在状态分母中，但不进入胜率、奖励或 scorecard 分母。
            {exportAvailable ? " 导出的内容为仅本地可读的 research artifact，不会进入公开分享路径。" : " 当前未配置研究工件目录，因此只能运行并查看服务端摘要。"}
          </Text>
          <Alert
            type="info"
            showIcon
            title="模型比较只作描述性筛选"
            description={
              statistics?.denominatorPolicy?.significance ??
              "Pairwise p 值由服务端记录的 completed seat rows 生成；它不是独立样本、因果结论或模型优劣声明。"
            }
          />
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        {[
          ["requested", summary?.gamesRequested ?? statistics?.status?.gamesRequested ?? 0],
          ["completed", summary?.gamesCompleted ?? statistics?.status?.gamesCompleted ?? 0],
          ["truncated", summary?.gamesTruncated ?? statistics?.status?.gamesTruncated ?? 0],
          ["failed", summary?.gamesFailed ?? statistics?.status?.gamesFailed ?? 0],
          ["unstarted", summary?.gamesUnstarted ?? statistics?.status?.gamesUnstarted ?? 0]
        ].map(([label, value]) => (
          <Col xs={12} md={6} key={String(label)}>
            <Card size="small">
              <Statistic title={String(label)} value={Number(value)} styles={{ content: { color: label === "failed" ? "#b42318" : label === "truncated" ? "#b54708" : undefined } }} />
            </Card>
          </Col>
        ))}
      </Row>

      <Card title="已记录的 Matrix Cells" extra={<Tag>{cells.length} cells</Tag>}>
        <Table
          rowKey="id"
          size="small"
          bordered
          columns={cellColumns}
          dataSource={cells}
          pagination={MATRIX_TABLE_PAGINATION}
          locale={{ emptyText: <Empty description="尚未运行矩阵。结果只会来自服务端控制面响应。" /> }}
        />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card title="模型统计" extra={<Tag>completed seat rows {statistics?.status?.completedSeatRows ?? 0}</Tag>}>
            <Table
              rowKey={(row) => `model:${row.subjectId}`}
              size="small"
              bordered
              columns={statColumns}
              dataSource={statistics?.modelStats ?? []}
              pagination={MATRIX_TABLE_PAGINATION}
              locale={{ emptyText: <Empty description="没有 terminal completed outcome rows。" /> }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="Profile 统计">
            <Table
              rowKey={(row) => `profile:${row.subjectId}`}
              size="small"
              bordered
              columns={statColumns}
              dataSource={statistics?.profileStats ?? []}
              pagination={MATRIX_TABLE_PAGINATION}
              locale={{ emptyText: <Empty description="没有 terminal completed outcome rows。" /> }}
            />
          </Card>
        </Col>
      </Row>

      <Card title="描述性 Pairwise 比较">
        <Table
          rowKey={(row) => `${row.leftModel}:${row.rightModel}`}
          size="small"
          bordered
          columns={comparisonColumns}
          dataSource={statistics?.pairwiseModelComparisons ?? []}
          pagination={MATRIX_TABLE_PAGINATION}
          locale={{ emptyText: <Empty description="需要至少两个有 completed outcome rows 的模型。" /> }}
        />
      </Card>

      <Card title="本地研究工件注册表" extra={<Tag>{artifactSets.length} sets</Tag>}>
        <Table
          rowKey="artifactSetId"
          size="small"
          bordered
          columns={artifactSetColumns}
          dataSource={artifactSets}
          pagination={MATRIX_TABLE_PAGINATION}
          locale={{ emptyText: <Empty description="未注册矩阵研究工件。工件只能由服务端注册并提供下载 URL。" /> }}
        />
      </Card>
    </Space>
  );
});
