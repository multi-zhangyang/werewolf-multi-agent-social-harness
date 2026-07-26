import { memo, useMemo } from "react";
import { Alert, Button, Card, Col, Descriptions, Empty, Input, Row, Select, Space, Statistic, Tag, type TableProps } from "antd";
import { CloudDownloadOutlined, ReloadOutlined, ShareAltOutlined } from "@ant-design/icons";
import { Table, Text, type TournamentArtifactSetSummary, type TournamentPublicShareSummary, type TournamentPublicShareInventory, type TournamentExecutionStats, type TournamentExecutionTelemetry } from "./appShared";
import { decorativeIcon, descriptionItems, flattenTournamentPackFiles, tournamentPackAggregateFiles, DEFAULT_SHARE_ALLOWLIST, shortId, formatPackCommitDensity, formatPackMetricPromotion, formatDate } from "./appInspectors";

const PACK_TABLE_PAGINATION = { pageSize: 6 } as const;
const PACK_GAMES_OPTIONS = [
  { value: "1", label: "1 game" },
  { value: "2", label: "2 games" },
  { value: "3", label: "3 games" },
  { value: "5", label: "5 games" }
];
const SHARE_EXPIRY_OPTIONS = [
  { value: "0", label: "永不过期" },
  { value: "1", label: "1 小时后" },
  { value: "24", label: "24 小时后" },
  { value: "168", label: "7 天后" }
];
const naText = (value?: string | null) => value ?? "n/a";
const packShareDensityText = (share: TournamentPublicShareSummary) =>
  formatPackCommitDensity({
    nativeSteps: share.packDensity?.nativeSteps,
    committedSteps: share.packDensity?.committedSteps,
    rejectedSteps: share.packDensity?.rejectedSteps
  });
const modelColumns: TableProps<TournamentExecutionStats & { model: string }>["columns"] = [
  { title: "model", dataIndex: "model", fixed: "left", render: (value: string) => <Text code>{value}</Text> },
  { title: "calls", dataIndex: "calls", align: "right" },
  { title: "tokens", dataIndex: "totalTokens", align: "right" },
  { title: "avg latency", dataIndex: "averageLatencyMs", align: "right", render: (value: number) => `${value}ms` },
  {
    title: "attempts",
    align: "right",
    render: (_, row) => `${row.attempts.sum}/${row.attempts.count} · max ${row.attempts.max} · missing ${row.attempts.missing}`
  },
  { title: "harness errors", dataIndex: "harnessErrors", align: "right" },
  { title: "provider failures", align: "right", render: (_, row) => row.providerFailures.count },
  { title: "stream aborts", align: "right", render: (_, row) => row.providerFailures.streamAborts }
];

const TournamentExecutionTelemetryPanel = memo(function TournamentExecutionTelemetryPanel({ telemetry }: { telemetry: TournamentExecutionTelemetry | null }) {
  if (!telemetry) {
    return (
      <Card title="生命周期执行遥测" data-testid="tournament-execution-telemetry">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="运行一次锦标赛公开包后，这里会直接显示服务端 lifecycle-inclusive executionTelemetry。"
        />
      </Card>
    );
  }

  const { lifecycle, totals } = telemetry;
  const modelRows = Object.entries(telemetry.byModel).map(([model, stats]) => ({ model, ...stats }));

  return (
    <Card
      title="生命周期执行遥测"
      extra={<Tag color="processing">{telemetry.schemaVersion}</Tag>}
      data-testid="tournament-execution-telemetry"
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          title="执行分母与结果分母严格分离"
          description={`${telemetry.denominatorPolicy.executionAggregates}；${telemetry.denominatorPolicy.outcomeAggregates}。本面板直接显示服务端 DTO，不在 React 重算或把截断结果提升进排行榜。`}
        />

        <Space wrap>
          <Tag color="processing">harness result {lifecycle.episodesWithHarnessResult}</Tag>
          <Tag color="success">completed {lifecycle.completed}</Tag>
          <Tag color="warning">truncated {lifecycle.truncated}</Tag>
          <Tag color="error">failed {lifecycle.failed}</Tag>
          <Tag>preparation failed {lifecycle.preparationFailed}</Tag>
          <Tag>unstarted {lifecycle.unstarted}</Tag>
        </Space>

        <Row gutter={[12, 12]}>
          <Col xs={12} md={8} xl={4} data-testid="tournament-execution-calls">
            <Card size="small"><Statistic title="calls" value={totals.calls} /></Card>
          </Col>
          <Col xs={12} md={8} xl={4} data-testid="tournament-execution-tokens">
            <Card size="small"><Statistic title="tokens" value={totals.totalTokens} /></Card>
          </Col>
          <Col xs={12} md={8} xl={4} data-testid="tournament-execution-latency">
            <Card size="small"><Statistic title="avg latency" value={totals.averageLatencyMs} suffix="ms" /></Card>
          </Col>
          <Col xs={12} md={8} xl={4} data-testid="tournament-execution-attempts">
            <Card size="small"><Statistic title="attempts" value={totals.attempts.sum} suffix={`/ ${totals.attempts.count}`} /></Card>
          </Col>
          <Col xs={12} md={8} xl={4} data-testid="tournament-execution-errors">
            <Card size="small"><Statistic title="harness errors" value={totals.harnessErrors} /></Card>
          </Col>
          <Col xs={12} md={8} xl={4} data-testid="tournament-execution-stream-aborts">
            <Card size="small"><Statistic title="stream aborts" value={totals.providerFailures.streamAborts} /></Card>
          </Col>
        </Row>

        <Descriptions
          size="small"
          bordered
          column={{ xs: 1, sm: 2, lg: 4 }}
          items={descriptionItems([
            ["prompt tokens", totals.promptTokens],
            ["completion tokens", totals.completionTokens],
            ["latency total", `${totals.latencyMs}ms`],
            ["attempt max", totals.attempts.max],
            ["attempt missing", totals.attempts.missing],
            ["provider failures", totals.providerFailures.count],
            ["timeouts", totals.providerFailures.timeouts],
            ["aborted", totals.providerFailures.aborted],
            ["native steps", totals.nativeSteps],
            ["committed steps", totals.committedSteps],
            ["rejected steps", totals.rejectedSteps],
            ["harness turns", totals.harnessTurns]
          ])}
        />

        <Card size="small" title="按模型执行遥测" extra={<Tag>{modelRows.length} models</Tag>}>
          <Table
            rowKey="model"
            size="small"
            bordered
            pagination={false}
            scroll={{ x: "max-content" }}
            columns={modelColumns}
            dataSource={modelRows}
            locale={{ emptyText: <Empty description="服务端没有记录按模型执行遥测。" /> }}
          />
        </Card>
      </Space>
    </Card>
  );
});

export const PacksWorkspace = memo(function PacksWorkspace({
  packs,
  executionTelemetry,
  selectedPackId,
  shares,
  shareInventory,
  shareLabel,
  packGames,
  shareExpiresInHours,
  shareAllowlist,
  busy,
  rosterSummary,
  experimentReady,
  maxTransitions,
  timeoutSeconds,
  onRefresh,
  onRefreshShareInventory,
  onDownloadShareAnalyticsSummary,
  onExport,
  onSelectPack,
  onInspectTournamentComparison,
  onShareLabelChange,
  onPackGamesChange,
  onShareExpiresInHoursChange,
  onShareAllowlistChange,
  onCreateShare,
  onCopyShare,
  onRevokeShare,
  onRevokeAllActiveShares,
  onInspectShare
}: {
  packs: TournamentArtifactSetSummary[];
  executionTelemetry: TournamentExecutionTelemetry | null;
  selectedPackId: string;
  shares: TournamentPublicShareSummary[];
  shareInventory: TournamentPublicShareInventory | null;
  shareLabel: string;
  packGames: string;
  shareExpiresInHours: string;
  shareAllowlist: string[];
  busy: string | null;
  rosterSummary: string;
  experimentReady: boolean;
  maxTransitions: string;
  timeoutSeconds: string;
  onRefresh: () => void;
  onRefreshShareInventory: () => void;
  onDownloadShareAnalyticsSummary: (format: "json" | "markdown") => void;
  onExport: () => void;
  onSelectPack: (pack: TournamentArtifactSetSummary) => void;
  onInspectTournamentComparison: (pack: TournamentArtifactSetSummary) => void;
  onShareLabelChange: (value: string) => void;
  onPackGamesChange: (value: string) => void;
  onShareExpiresInHoursChange: (value: string) => void;
  onShareAllowlistChange: (value: string[]) => void;
  onCreateShare: () => void;
  onCopyShare: (share: TournamentPublicShareSummary) => void;
  onRevokeShare: (share: TournamentPublicShareSummary) => void;
  onRevokeAllActiveShares: () => void;
  onInspectShare: (share: TournamentPublicShareSummary) => void;
}) {
  const selectedPack = packs.find((pack) => pack.artifactSetId === selectedPackId) ?? null;
  const availableFiles = useMemo(() => flattenTournamentPackFiles(selectedPack?.files), [selectedPack?.files]);
  const shareAllowlistOptions = useMemo(
    () => availableFiles.map((file) => ({ value: file, label: file })),
    [availableFiles]
  );
  const packColumns: TableProps<TournamentArtifactSetSummary>["columns"] = useMemo(() => [
    {
      title: "artifact set",
      render: (_, pack) => (
        <Button type="link" size="small" onClick={() => onSelectPack(pack)}>
          <Text code>{shortId(pack.artifactSetId)}</Text>
        </Button>
      )
    },
    { title: "created", dataIndex: "createdAt", render: formatDate },
    { title: "seed", dataIndex: "seed", ellipsis: true },
    { title: "experiment", dataIndex: "experimentId", ellipsis: true },
    {
      title: "density",
      render: (_, pack) => <Text type="secondary">{formatPackCommitDensity(pack)}</Text>
    },
    {
      title: "promotion",
      render: (_, pack) => <Text type="secondary">{formatPackMetricPromotion(pack)}</Text>
    },
    {
      title: "projection",
      render: (_, pack) =>
        pack.projection ? (
          <Tag color={pack.projection.publicShareSafe ? "success" : "default"}>
            {pack.projection.matchArtifactView ?? "unknown"} · share=
            {pack.projection.publicShareSafe ? "safe" : "unsafe"}
          </Tag>
        ) : (
          <Tag>n/a</Tag>
        )
    }
  ], [onSelectPack]);
  const shareColumns: TableProps<TournamentPublicShareSummary>["columns"] = useMemo(() => [
    {
      title: "share",
      render: (_, share) => (
        <Button type="link" size="small" onClick={() => onInspectShare(share)}>
          <Text code>{shortId(share.shareId)}</Text>
        </Button>
      )
    },
    { title: "label", dataIndex: "label", render: naText },
    { title: "created", dataIndex: "createdAt", render: formatDate },
    { title: "expires", dataIndex: "expiresAt", render: (value: string | null) => (value ? formatDate(value) : "never") },
    {
      title: "files",
      render: (_, share) => (share.relativeFiles?.length ? `${share.relativeFiles.length} files` : "all")
    },
    {
      title: "usage",
      render: (_, share) => (
        <Space orientation="vertical" size={0}>
          <Text type="secondary">views {share.analytics?.detailViewCount ?? 0}</Text>
          <Text type="secondary">downloads {share.analytics?.downloadCount ?? 0}</Text>
        </Space>
      )
    },
    {
      title: "density",
      render: (_, share) => <Text type="secondary">{packShareDensityText(share)}</Text>
    },
    {
      title: "status",
      render: (_, share) => <Tag color={share.expired ? "error" : "success"}>{share.expired ? "expired" : "active"}</Tag>
    },
    {
      title: "action",
      fixed: "right",
      align: "right",
      render: (_, share) => (
        <Space>
          <Button size="small" icon={decorativeIcon(<ShareAltOutlined />)} onClick={() => onCopyShare(share)}>
            复制
          </Button>
          <Button size="small" danger loading={busy === "share-revoke"} onClick={() => onRevokeShare(share)}>
            吊销
          </Button>
        </Space>
      )
    }
  ], [busy, onCopyShare, onInspectShare, onRevokeShare]);

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="锦标赛公开包"
        extra={
          <Space wrap>
            <Select
              aria-label="锦标赛游戏局数"
              style={{ width: 120 }}
              value={packGames}
              options={PACK_GAMES_OPTIONS}
              onChange={onPackGamesChange}
              disabled={Boolean(busy)}
            />
            <Button icon={decorativeIcon(<ReloadOutlined />)} loading={busy === "packs"} disabled={Boolean(busy)} onClick={onRefresh}>
              刷新公开包
            </Button>
            <Button
              type="primary"
              icon={decorativeIcon(<CloudDownloadOutlined />)}
              loading={busy === "pack-export"}
              disabled={!experimentReady || Boolean(busy)}
              onClick={onExport}
            >
              导出公开包
            </Button>
          </Space>
        }
      >
        <Space orientation="vertical" size="small" style={{ width: "100%" }}>
          <Text type="secondary">
            导出调用 `POST /api/tournaments/run` 且 `exportArtifacts=true`，服务端写入 truth-redacted 公开包。当前控件：model=
            {rosterSummary} · games={packGames || "2"} · maxTransitions={maxTransitions || "n/a"} · timeout=
            {timeoutSeconds || "n/a"}s。
          </Text>
          <Text type="secondary">
            `games≥2` 时服务端会 seed pairwise comparison 并注册 episode match；导出后 cockpit 会按本 pack 的 episode id
            自动打开对应对比。`games=1` 只导出单局包，不会产生 pair comparison。
          </Text>
          <Text type="secondary">列表来自 `/api/tournament-artifacts`。仅 `publicShareSafe` 包可创建长期分享链接。</Text>
        </Space>
        <Table
          rowKey="artifactSetId"
          size="small"
          bordered
          style={{ marginTop: 16 }}
          columns={packColumns}
          dataSource={packs}
          pagination={PACK_TABLE_PAGINATION}
          rowSelection={{
            type: "radio",
            selectedRowKeys: selectedPackId ? [selectedPackId] : []
          }}
          onRow={(pack) => ({ onClick: () => onSelectPack(pack) })}
          locale={{ emptyText: <Empty description="暂无锦标赛公开包。点击“导出公开包”运行真实锦标赛导出。" /> }}
        />
      </Card>

      <TournamentExecutionTelemetryPanel telemetry={executionTelemetry} />

      <Card
        title="公开包聚合工件"
        extra={
          selectedPack ? (
            <Button
              size="small"
              type="primary"
              loading={busy === "pack-comparison"}
              disabled={Boolean(busy)}
              onClick={() => onInspectTournamentComparison(selectedPack)}
            >
              检视 tournament comparison
            </Button>
          ) : null
        }
      >
        {selectedPack ? (
          <Space orientation="vertical" size="small" style={{ width: "100%" }}>
            <Text type="secondary">
              聚合文件来自服务端注册的 `files` / `downloads`。React 只展示下载入口或加载服务端 JSON，不本地发明对比真相。
            </Text>
            <Table
              size="small"
              bordered
              pagination={false}
              rowKey="key"
              dataSource={tournamentPackAggregateFiles(selectedPack)}
              columns={[
                {
                  title: "file",
                  dataIndex: "file",
                  render: (value: string) => <Text code>{value}</Text>
                },
                {
                  title: "status",
                  dataIndex: "available",
                  render: (available: boolean) => (
                    <Tag color={available ? "success" : "default"}>{available ? "registered" : "missing"}</Tag>
                  )
                },
                {
                  title: "action",
                  align: "right",
                  render: (_, row) => (
                    <Space>
                      {row.file === "tournament_comparison.json" ? (
                        <Button
                          size="small"
                          loading={busy === "pack-comparison"}
                          disabled={!row.available || Boolean(busy)}
                          onClick={() => onInspectTournamentComparison(selectedPack)}
                        >
                          检视
                        </Button>
                      ) : null}
                      {row.href ? (
                        <Button size="small" type="link" href={row.href} target="_blank" rel="noreferrer">
                          打开
                        </Button>
                      ) : (
                        <Text type="secondary">n/a</Text>
                      )}
                    </Space>
                  )
                }
              ]}
              locale={{ emptyText: <Empty description="当前包没有聚合工件。" /> }}
            />
          </Space>
        ) : (
          <Empty description="先选择或导出一个锦标赛公开包。" />
        )}
      </Card>


      <Card
        title="分享链接"
        extra={
          <Space wrap>
            {selectedPack ? (
              <Tag color={selectedPack.projection?.publicShareSafe ? "success" : "warning"}>
                {selectedPack.projection?.publicShareSafe ? "可分享" : "不可分享"}
              </Tag>
            ) : (
              <Tag>未选择</Tag>
            )}
            <Button
              size="small"
              danger
              loading={busy === "share-revoke-all"}
              disabled={!shares.some((share) => !share.expired) || Boolean(busy)}
              onClick={onRevokeAllActiveShares}
            >
              吊销全部活跃
            </Button>
          </Space>
        }
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Space wrap>
            <Input
              style={{ width: 200 }}
              value={shareLabel}
              placeholder="分享标签"
              onChange={(event) => onShareLabelChange(event.target.value)}
            />
            <Select
              style={{ width: 160 }}
              value={shareExpiresInHours || "0"}
              options={SHARE_EXPIRY_OPTIONS}
              onChange={(value) => onShareExpiresInHoursChange(value === "0" ? "" : value)}
              disabled={Boolean(busy)}
            />
            <Button
              type="primary"
              icon={decorativeIcon(<ShareAltOutlined />)}
              loading={busy === "share-create"}
              disabled={!selectedPack?.projection?.publicShareSafe || Boolean(busy) || (availableFiles.length > 0 && shareAllowlist.length === 0)}
              onClick={onCreateShare}
            >
              创建分享链接
            </Button>
          </Space>
          <Select
            mode="multiple"
            allowClear
            style={{ width: "100%" }}
            placeholder={selectedPack ? "选择可公开下载的注册文件（留空不可创建；不选则需先加载包文件列表）" : "先选择公开包"}
            value={shareAllowlist}
            options={shareAllowlistOptions}
            onChange={(value) => onShareAllowlistChange(value)}
            disabled={!selectedPack || Boolean(busy)}
            maxTagCount="responsive"
          />
          <Space wrap>
            <Button
              size="small"
              disabled={!selectedPack || !availableFiles.length || Boolean(busy)}
              onClick={() => onShareAllowlistChange(availableFiles)}
            >
              全选注册文件
            </Button>
            <Button
              size="small"
              disabled={!selectedPack || Boolean(busy)}
              onClick={() =>
                onShareAllowlistChange(DEFAULT_SHARE_ALLOWLIST.filter((file) => availableFiles.includes(file)))
              }
            >
              默认摘要集
            </Button>
            <Button size="small" disabled={!selectedPack || Boolean(busy)} onClick={() => onShareAllowlistChange([])}>
              清空
            </Button>
            <Text type="secondary">
              已选 {shareAllowlist.length}/{availableFiles.length || "?"} · 仅允许当前包已注册路径
            </Text>
          </Space>
          <Text type="secondary">
            创建后可复制 `/api/public/tournament-shares/:shareId`。可设置过期时间与文件 allowlist；吊销后立即失效。链接只暴露
            truth-redacted 注册文件，不暴露绝对路径。
          </Text>
          <Table
            rowKey="shareId"
            size="small"
            bordered
            columns={shareColumns}
            dataSource={shares}
            pagination={PACK_TABLE_PAGINATION}
            locale={{ emptyText: <Empty description="当前公开包还没有分享链接。" /> }}
          />
        </Space>
      </Card>

      <Card
        title="跨包分享清单"
        extra={
          <Space wrap>
            <Button
              size="small"
              icon={decorativeIcon(<ReloadOutlined />)}
              loading={busy === "share-inventory"}
              disabled={Boolean(busy)}
              onClick={onRefreshShareInventory}
            >
              刷新清单
            </Button>
            <Button
              size="small"
              icon={decorativeIcon(<CloudDownloadOutlined />)}
              loading={busy === "share-summary"}
              disabled={Boolean(busy)}
              onClick={() => onDownloadShareAnalyticsSummary("json")}
            >
              导出 JSON
            </Button>
            <Button
              size="small"
              icon={decorativeIcon(<CloudDownloadOutlined />)}
              loading={busy === "share-summary"}
              disabled={Boolean(busy)}
              onClick={() => onDownloadShareAnalyticsSummary("markdown")}
            >
              导出 Markdown
            </Button>
          </Space>
        }
      >
        <Space orientation="vertical" size="small" style={{ width: "100%" }}>
          <Text type="secondary">
            来自 `GET /api/tournament-public-shares`。可导出 `GET /api/tournament-public-shares/summary` 的 JSON/Markdown 汇总，不暴露绝对路径。
          </Text>
          <Space wrap>
            <Tag>total={shareInventory?.count ?? 0}</Tag>
            <Tag color="success">active={shareInventory?.activeCount ?? 0}</Tag>
            <Tag color="default">expired={shareInventory?.expiredCount ?? 0}</Tag>
            <Tag color="processing">packsWithPromotion={shareInventory?.packsWithPromotionCount ?? 0}</Tag>
            <Tag color="processing">packsWithDensity={shareInventory?.packsWithDensityCount ?? 0}</Tag>
            <Tag>
              {formatPackMetricPromotion({
                metricCount: shareInventory?.metricCount,
                scorecardEligibleMetricCount: shareInventory?.scorecardEligibleMetricCount,
                metricPromotionClassCounts: shareInventory?.metricPromotionClassCounts
              })}
            </Tag>
            <Tag>
              {formatPackCommitDensity({
                nativeSteps: shareInventory?.nativeSteps,
                committedSteps: shareInventory?.committedSteps,
                rejectedSteps: shareInventory?.rejectedSteps
              })}
            </Tag>
          </Space>
          <Table
            rowKey="shareId"
            size="small"
            bordered
            dataSource={shareInventory?.shares ?? []}
            pagination={PACK_TABLE_PAGINATION}
            columns={[
              {
                title: "share",
                render: (_: unknown, share: TournamentPublicShareSummary) => (
                  <Button type="link" size="small" onClick={() => onInspectShare(share)}>
                    <Text code>{shortId(share.shareId)}</Text>
                  </Button>
                )
              },
              { title: "label", dataIndex: "label", render: naText },
              {
                title: "pack",
                render: (_: unknown, share: TournamentPublicShareSummary) => (
                  <Space orientation="vertical" size={0}>
                    <Text code>{shortId(share.artifactSetId)}</Text>
                    <Text type="secondary">{share.packSeed ?? "pack missing"}</Text>
                  </Space>
                )
              },
              {
                title: "usage",
                render: (_: unknown, share: TournamentPublicShareSummary) => {
                  const topFiles = Object.entries(share.analytics?.downloadsByFile ?? {})
                    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                    .slice(0, 3)
                    .map(([file, count]) => `${file}×${count}`);
                  const recentMinutes = (share.analytics?.downloadsByMinute ?? [])
                    .slice(-3)
                    .map((bucket) => `${bucket.minute.slice(11, 16)}×${bucket.count}`);
                  return (
                    <Space orientation="vertical" size={0}>
                      <Text type="secondary">views {share.analytics?.detailViewCount ?? 0}</Text>
                      <Text type="secondary">downloads {share.analytics?.downloadCount ?? 0}</Text>
                      <Text type="secondary">{topFiles.length ? topFiles.join(", ") : share.analytics?.lastDownloadedFile ?? "no downloads"}</Text>
                      <Text type="secondary">{recentMinutes.length ? `min ${recentMinutes.join(", ")}` : "no minute series"}</Text>
                    </Space>
                  );
                }
              },
              {
                title: "density",
                render: (_: unknown, share: TournamentPublicShareSummary) => (
                  <Text type="secondary">{packShareDensityText(share)}</Text>
                )
              },
              {
                title: "status",
                render: (_: unknown, share: TournamentPublicShareSummary) => (
                  <Tag color={share.expired ? "error" : share.packFound === false ? "warning" : "success"}>
                    {share.expired ? "expired" : share.packFound === false ? "pack missing" : "active"}
                  </Tag>
                )
              },
              {
                title: "action",
                render: (_: unknown, share: TournamentPublicShareSummary) => (
                  <Space>
                    <Button size="small" onClick={() => onCopyShare(share)}>
                      复制
                    </Button>
                    <Button size="small" danger disabled={Boolean(share.expired)} onClick={() => onRevokeShare(share)}>
                      吊销
                    </Button>
                  </Space>
                )
              }
            ]}
            locale={{ emptyText: <Empty description="尚未加载跨包分享清单。点击“刷新清单”。" /> }}
          />
        </Space>
      </Card>
    </Space>
  );
});
