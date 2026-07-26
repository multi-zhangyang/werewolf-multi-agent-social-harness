import { memo, useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Col, Empty, Row, Select, Space, Tag, type TableProps } from "antd";
import { CloudDownloadOutlined, SwapOutlined } from "@ant-design/icons";
import { applyMatchComparisonRowFilterToSearchParams, buildMatchComparisonFilterDeepLink, formatComparisonRegistryEntryLabel, parseMatchComparisonRowFilterFromSearchParams, projectFilteredMatchComparison, type MatchComparisonArtifact, type MatchComparisonEvidenceIdentityFilter, type MatchComparisonFilteredProjection, type MatchComparisonNumericDeltaFilter, type MatchComparisonPromotionFilter, type MatchComparisonRow, type MatchComparisonRowGroup } from "../../harness/matchComparisonView";
import { Table, Text, type ArtifactView, type ProjectedMatchArtifact, type ComparisonRequestContext, type MatchRecord, type ComparisonRegistrySummary } from "./appShared";
import { ArtifactSummary, decorativeIcon, isComparisonCurrentForRoute, shortId, formatValue } from "./appInspectors";

const GROUP_FILTER_OPTIONS = [
  { value: "all", label: "全部 group" },
  { value: "summary", label: "summary" },
  { value: "metric", label: "metric" },
  { value: "metric_evidence", label: "metric evidence" }
];
const PROMOTION_FILTER_OPTIONS = [
  { value: "all", label: "全部 promotion" },
  { value: "changed", label: "promotion 变化" },
  { value: "scorecard", label: "含 scorecard" },
  { value: "diagnostic", label: "含 diagnostic" },
  { value: "benchmark_only", label: "含 benchmark_only" },
  { value: "missing", label: "含 missing" }
];
const EVIDENCE_IDENTITY_FILTER_OPTIONS = [
  { value: "all", label: "全部 evidence identity" },
  { value: "changed", label: "evidence identity 变化" }
];
const NUMERIC_DELTA_FILTER_OPTIONS = [
  { value: "all", label: "全部 numeric delta" },
  { value: "changed", label: "numeric delta 变化" }
];
const MATRIX_TABLE_PAGINATION = { pageSize: 10 } as const;

export const CompareWorkspace = memo(function CompareWorkspace({
  artifact,
  candidateArtifact,
  comparison,
  comparisonContext,
  baselineId,
  candidates,
  candidateId,
  artifactView,
  comparisonRegistry,
  selectedComparisonId,
  onCandidateChange,
  onLoadComparison,
  onRefreshComparisonRegistry,
  onSelectComparisonId,
  onLoadSavedComparison,
  onDownloadComparison,
  onDownloadFilteredComparison,
  busy,
  onInspectRow,
  onInspectFilteredProjection
}: {
  artifact: ProjectedMatchArtifact | null;
  candidateArtifact: ProjectedMatchArtifact | null;
  comparison: MatchComparisonArtifact | null;
  comparisonContext: ComparisonRequestContext | null;
  /** Match route identity, intentionally kept outside a truth-redacted DTO. */
  baselineId: string;
  candidates: MatchRecord[];
  candidateId: string;
  artifactView: ArtifactView;
  comparisonRegistry: ComparisonRegistrySummary[];
  selectedComparisonId: string;
  onCandidateChange: (value: string) => void;
  onLoadComparison: () => void;
  onRefreshComparisonRegistry: () => void | Promise<void>;
  onSelectComparisonId: (value: string) => void;
  onLoadSavedComparison: () => void | Promise<void>;
  onDownloadComparison: (format: "json" | "markdown") => void;
  onDownloadFilteredComparison: (
    format: "json" | "markdown",
    filter: {
      group: "all" | MatchComparisonRowGroup;
      changedOnly: boolean;
      promotion: MatchComparisonPromotionFilter;
      evidenceIdentity: MatchComparisonEvidenceIdentityFilter;
      numericDelta: MatchComparisonNumericDeltaFilter;
    }
  ) => void | Promise<void>;
  busy: string | null;
  onInspectRow: (row: MatchComparisonRow) => void;
  onInspectFilteredProjection: (projection: MatchComparisonFilteredProjection) => void;
}) {
  const [copyDeepLinkStatus, setCopyDeepLinkStatus] = useState<string | null>(null);
  const initialFilter = useMemo(
    () =>
      typeof window === "undefined"
        ? {
            group: "all" as const,
            changedOnly: false,
            promotion: "all" as const,
            evidenceIdentity: "all" as const,
            numericDelta: "all" as const
          }
        : parseMatchComparisonRowFilterFromSearchParams(window.location.search),
    []
  );
  const [groupFilter, setGroupFilter] = useState<"all" | MatchComparisonRowGroup>(initialFilter.group);
  const [changedOnly, setChangedOnly] = useState(initialFilter.changedOnly);
  const [promotionFilter, setPromotionFilter] = useState<MatchComparisonPromotionFilter>(initialFilter.promotion);
  const [evidenceIdentityFilter, setEvidenceIdentityFilter] =
    useState<MatchComparisonEvidenceIdentityFilter>(initialFilter.evidenceIdentity);
  const [numericDeltaFilter, setNumericDeltaFilter] =
    useState<MatchComparisonNumericDeltaFilter>(initialFilter.numericDelta);
  const activeFilter = useMemo(
    () =>
      ({
        group: groupFilter,
        changedOnly,
        promotion: promotionFilter,
        evidenceIdentity: evidenceIdentityFilter,
        numericDelta: numericDeltaFilter
      }) as const,
    [changedOnly, evidenceIdentityFilter, groupFilter, numericDeltaFilter, promotionFilter]
  );
  const copyFilterDeepLink = async () => {
    try {
      const deepLink = buildMatchComparisonFilterDeepLink({
        origin: window.location.origin,
        pathname: window.location.pathname,
        hash: window.location.hash,
        search: window.location.search,
        filter: activeFilter,
        workspace: "compare",
        baselineId: baselineId || undefined,
        candidateId: candidateId || undefined,
        view: artifactView
      });
      await navigator.clipboard.writeText(deepLink);
      setCopyDeepLinkStatus("已复制过滤深链");
    } catch {
      setCopyDeepLinkStatus("复制失败");
    }
  };
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = applyMatchComparisonRowFilterToSearchParams(activeFilter, window.location.search);
    if (baselineId) params.set("compareBaseline", baselineId);
    else params.delete("compareBaseline");
    if (candidateId) params.set("compareCandidate", candidateId);
    else params.delete("compareCandidate");
    if (artifactView && artifactView !== "postgame-redacted") params.set("compareView", artifactView);
    else params.delete("compareView");
    params.set("workspace", "compare");
    params.delete("tab");
    const nextSearch = params.toString();
    const currentSearch = window.location.search.startsWith("?")
      ? window.location.search.slice(1)
      : window.location.search;
    if (nextSearch === currentSearch) return;
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [activeFilter, artifactView, baselineId, candidateId]);
  const comparisonCurrent = isComparisonCurrentForRoute({
    comparison,
    context: comparisonContext,
    baselineId,
    candidateId,
    view: artifactView
  });
  const comparisonMatchesCandidate =
    comparison?.view === "truth-redacted"
      ? comparisonContext?.comparisonId === comparison.comparisonId && comparisonContext.candidateId === candidateId
      : Boolean(comparison) &&
        Boolean(candidateId) &&
        (comparison?.candidate.matchId === candidateId || comparison?.candidate.runId === candidateId);
  const comparisonMatchesBaseline =
    comparison?.view === "truth-redacted"
      ? comparisonContext?.comparisonId === comparison.comparisonId && comparisonContext.baselineId === baselineId
      : Boolean(comparison) &&
        Boolean(baselineId) &&
        (comparison?.baseline.matchId === baselineId || comparison?.baseline.runId === baselineId);
  const comparisonMatchesView = Boolean(comparison) && comparison?.view === artifactView;
  const pendingComparison = Boolean(candidateId) && !comparisonCurrent;
  const currentComparison = comparisonCurrent ? comparison : null;
  const filteredProjection = useMemo(
    () =>
      currentComparison
        ? projectFilteredMatchComparison(currentComparison, activeFilter, {
            createdAt: currentComparison.createdAt
          })
        : null,
    [activeFilter, currentComparison]
  );
  const filteredRows = filteredProjection?.rows ?? [];
  const hasActiveFilter =
    activeFilter.group !== "all" ||
    activeFilter.changedOnly ||
    activeFilter.promotion !== "all" ||
    activeFilter.evidenceIdentity !== "all" ||
    activeFilter.numericDelta !== "all";
  const resetFilters = () => {
    setGroupFilter("all");
    setChangedOnly(false);
    setPromotionFilter("all");
    setEvidenceIdentityFilter("all");
    setNumericDeltaFilter("all");
  };
  const rowColumns: TableProps<MatchComparisonRow>["columns"] = useMemo(() => [
    { title: "row", dataIndex: "id", render: (value: string) => <Text code>{value}</Text> },
    {
      title: "group",
      dataIndex: "group",
      width: 120,
      render: (value: MatchComparisonRow["group"]) =>
        value === "metric_evidence" ? (
          <Tag color="purple">metric evidence</Tag>
        ) : value === "metric" ? (
          <Tag color="geekblue">metric</Tag>
        ) : (
          <Tag>summary</Tag>
        )
    },
    { title: "label", dataIndex: "label" },
    { title: "baseline", dataIndex: "baseline", render: formatValue },
    { title: "candidate", dataIndex: "candidate", render: formatValue },
    {
      title: "delta",
      dataIndex: "delta",
      render: (value: unknown, row) => (row.changed ? <Tag color="processing">{formatValue(value)}</Tag> : formatValue(value))
    },
    {
      title: "promotion",
      key: "promotion",
      width: 140,
      render: (_value, row) =>
        row.promotion ? (
          <Text type="secondary">
            {row.promotion.baseline}→{row.promotion.candidate}
            {row.promotion.details?.changedFields.length
              ? ` · ${row.promotion.details.changedFields.join(",")}`
              : ""}
          </Text>
        ) : (
          "—"
        )
    },
    {
      title: "evidence",
      key: "evidence",
      render: (_value, row) =>
        row.evidence ? (
          <Text type="secondary">
            {row.evidence.baselineRefs}→{row.evidence.candidateRefs}
            {row.evidence.candidateKinds.length || row.evidence.baselineKinds.length
              ? ` · ${(row.evidence.candidateKinds.length ? row.evidence.candidateKinds : row.evidence.baselineKinds).join(",")}`
              : ""}
            {row.evidence.onlyBaselineIds.length || row.evidence.onlyCandidateIds.length
              ? ` · Δids ${row.evidence.onlyBaselineIds.length}→${row.evidence.onlyCandidateIds.length}`
              : ""}
          </Text>
        ) : (
          "—"
        )
    },
    {
      title: "查看",
      fixed: "right",
      width: 72,
      render: (_value, row) => (
        <Button type="link" size="small" aria-label={`查看对比行 ${row.id}`} onClick={() => onInspectRow(row)}>
          查看
        </Button>
      )
    }
  ], [onInspectRow]);
  const pendingReason = !comparison
    ? "尚未加载服务端对比工件"
    : !comparisonMatchesCandidate
      ? "已加载对比的候选身份与当前选择不一致"
      : !comparisonMatchesBaseline
        ? "已加载对比的基准身份与当前基准工件不一致"
        : !comparisonMatchesView
          ? "已加载对比的投影模式与当前 view 不一致"
          : "需要重载对比工件";

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="工件对比"
        extra={
          <Space wrap>
            <Select
              aria-label="候选运行"
              style={{ minWidth: 220 }}
              placeholder="选择候选 run"
              value={candidateId || undefined}
              options={candidates.map((match) => ({
                value: match.id,
                label: `${shortId(match.id)} · ${match.status}`
              }))}
              onChange={onCandidateChange}
            />
            <Button type="primary" icon={decorativeIcon(<SwapOutlined />)} loading={busy === "compare"} disabled={!candidateId || Boolean(busy)} onClick={onLoadComparison}>
              {pendingComparison ? "加载/重载对比工件" : "加载对比工件"}
            </Button>
            <Select
              aria-label="已保存 comparison"
              style={{ minWidth: 280 }}
              placeholder="已保存 comparison"
              value={selectedComparisonId || undefined}
              options={comparisonRegistry.map((entry) => ({
                value: entry.comparisonId,
                label: formatComparisonRegistryEntryLabel(entry)
              }))}
              onChange={onSelectComparisonId}
            />
            <Button
              loading={busy === "comparison-registry"}
              disabled={Boolean(busy)}
              onClick={() => void onRefreshComparisonRegistry()}
            >
              刷新注册表
            </Button>
            <Button
              loading={busy === "comparison-registry-load"}
              disabled={!selectedComparisonId || Boolean(busy)}
              onClick={() => void onLoadSavedComparison()}
            >
              加载已保存
            </Button>
          </Space>
        }
      >
        <Text type="secondary">{`对比生成自 /api/matches/:id/compare/:candidateId；注册表为 /api/comparisons 与 /api/comparisons/:id。filtered 投影不入库。`}</Text>
        {pendingComparison ? (
          <Alert
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            title={pendingReason}
            description={`基准 ${shortId(baselineId || "n/a")} · 候选 ${shortId(candidateId)} · view=${artifactView}。点击加载/重载后才会更新对比矩阵与导出。`}
            action={
              <Button size="small" type="primary" loading={busy === "compare"} disabled={Boolean(busy)} onClick={onLoadComparison}>
                立即加载
              </Button>
            }
          />
        ) : comparison ? (
          <Alert
            style={{ marginTop: 12 }}
            type="success"
            showIcon
            title="对比已就绪"
            description={`基准 ${shortId(baselineId || comparison.baseline.matchId || comparison.baseline.runId)} · 候选 ${shortId(candidateId)} · view=${comparison.view} · rows=${comparison.rows.length}${filteredProjection ? ` · shown ${filteredProjection.summary.rowCount}` : ""} · filter ${activeFilter.group}/${activeFilter.promotion}/${activeFilter.evidenceIdentity}/${activeFilter.numericDelta}${activeFilter.changedOnly ? "/changedOnly" : ""} · socialΔ${comparison.summary.socialStepsDelta} · cΔ${comparison.summary.committedStepsDelta}/rΔ${comparison.summary.rejectedStepsDelta} · comparisonId=${shortId(comparison.comparisonId)}`}
            action={
              <Button size="small" onClick={() => void copyFilterDeepLink()}>
                {copyDeepLinkStatus ?? "复制过滤深链"}
              </Button>
            }
          />
        ) : null}
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={24} md={12}>
            <ArtifactSummary title="基准工件" artifact={artifact} />
          </Col>
          <Col xs={24} md={12}>
            <ArtifactSummary title="候选工件" artifact={candidateArtifact} />
          </Col>
        </Row>
      </Card>

      <Card
        title="对比矩阵"
        extra={
          currentComparison ? (
            <Space wrap>
              <Tag
                color={changedOnly ? "processing" : "default"}
                style={{ cursor: "pointer" }}
                onClick={() => setChangedOnly((value) => !value)}
              >
                changed {currentComparison.summary.changedRowCount}/{currentComparison.summary.rowCount}
              </Tag>
              <Tag
                color={hasActiveFilter ? "processing" : "default"}
                style={{ cursor: filteredProjection ? "pointer" : "default" }}
                onClick={() => {
                  if (filteredProjection) onInspectFilteredProjection(filteredProjection);
                }}
              >
                shown {filteredProjection?.summary.rowCount ?? 0}/{currentComparison.rows.length}
              </Tag>
              <Tag
                color={groupFilter === "summary" ? "processing" : "default"}
                style={{ cursor: "pointer" }}
                onClick={() => setGroupFilter((value) => (value === "summary" ? "all" : "summary"))}
              >
                S{filteredProjection?.summary.summaryRowCount ?? 0}
              </Tag>
              <Tag
                color={groupFilter === "metric" ? "geekblue" : "default"}
                style={{ cursor: "pointer" }}
                onClick={() => setGroupFilter((value) => (value === "metric" ? "all" : "metric"))}
              >
                M{filteredProjection?.summary.metricRowCount ?? 0}
              </Tag>
              <Tag
                color={groupFilter === "metric_evidence" ? "purple" : "default"}
                style={{ cursor: "pointer" }}
                onClick={() =>
                  setGroupFilter((value) => (value === "metric_evidence" ? "all" : "metric_evidence"))
                }
              >
                E{filteredProjection?.summary.metricEvidenceRowCount ?? 0}
              </Tag>
              <Tag
                color="processing"
                style={{ cursor: "pointer" }}
                onClick={() => setChangedOnly((value) => !value)}
              >
                filtered changed {filteredProjection?.summary.changedRowCount ?? 0}/
                {filteredProjection?.summary.sourceChangedRowCount ?? currentComparison.summary.changedRowCount}
              </Tag>
              <Tag
                color={
                  numericDeltaFilter === "changed" ||
                  (filteredProjection?.summary.numericDeltaCount ?? 0) > 0
                    ? "processing"
                    : "default"
                }
                style={{ cursor: "pointer" }}
                onClick={() =>
                  setNumericDeltaFilter((value) => (value === "changed" ? "all" : "changed"))
                }
              >
                filtered numericΔ {filteredProjection?.summary.numericDeltaCount ?? 0}
              </Tag>
              <Tag
                color={
                  (filteredProjection?.summary.promotionChangedMetricCount ?? 0) > 0
                    ? "purple"
                    : "default"
                }
                style={{ cursor: "pointer" }}
                onClick={() =>
                  setPromotionFilter((value) => (value === "changed" ? "all" : "changed"))
                }
              >
                filtered promotionΔ {filteredProjection?.summary.promotionChangedMetricCount ?? 0}
              </Tag>
              <Tag color={(filteredProjection?.summary.promotionProvenanceChangedMetricCount ?? 0) > 0 ? "purple" : "default"}>
                filtered provenanceΔ {filteredProjection?.summary.promotionProvenanceChangedMetricCount ?? 0}
              </Tag>
              <Tag
                color={
                  evidenceIdentityFilter === "changed" ||
                  (filteredProjection?.summary.evidenceIdentityChangedMetricCount ?? 0) > 0
                    ? "purple"
                    : "default"
                }
                style={{ cursor: "pointer" }}
                onClick={() =>
                  setEvidenceIdentityFilter((value) => (value === "changed" ? "all" : "changed"))
                }
              >
                filtered evidence idΔ{" "}
                {filteredProjection?.summary.evidenceIdentityChangedMetricCount ?? 0}
                {(filteredProjection?.summary.evidenceIdentityChangedMetricCount ?? 0) > 0
                  ? ` · ${filteredProjection?.summary.evidenceIdentityOnlyBaselineRefCount ?? 0}→${
                      filteredProjection?.summary.evidenceIdentityOnlyCandidateRefCount ?? 0
                    }`
                  : ""}
              </Tag>
              <Tag color={currentComparison.summary.metricKeysTruncated > 0 ? "warning" : "default"}>
                metric keys {currentComparison.summary.metricKeysEmitted}/{currentComparison.summary.metricKeysCompared}
                {currentComparison.summary.metricKeysTruncated > 0
                  ? ` · truncated ${currentComparison.summary.metricKeysTruncated}`
                  : ""}
              </Tag>
              <Tag color={currentComparison.summary.scorecardMetricKeysTruncated > 0 ? "error" : "success"}>
                scorecard keys {currentComparison.summary.scorecardMetricKeysEmitted}/
                {currentComparison.summary.scorecardMetricKeysCompared}
                {currentComparison.summary.scorecardMetricKeysTruncated > 0
                  ? ` · truncated ${currentComparison.summary.scorecardMetricKeysTruncated}`
                  : ""}
              </Tag>
              <Tag color={currentComparison.summary.diagnosticMetricKeysTruncated > 0 ? "warning" : "default"}>
                diagnostic keys {currentComparison.summary.diagnosticMetricKeysEmitted}/
                {currentComparison.summary.diagnosticMetricKeysCompared}
                {currentComparison.summary.diagnosticMetricKeysTruncated > 0
                  ? ` · truncated ${currentComparison.summary.diagnosticMetricKeysTruncated}`
                  : ""}
              </Tag>
              <Tag color={currentComparison.summary.benchmarkOnlyMetricKeysTruncated > 0 ? "warning" : "default"}>
                benchmark keys {currentComparison.summary.benchmarkOnlyMetricKeysEmitted}/
                {currentComparison.summary.benchmarkOnlyMetricKeysCompared}
                {currentComparison.summary.benchmarkOnlyMetricKeysTruncated > 0
                  ? ` · truncated ${currentComparison.summary.benchmarkOnlyMetricKeysTruncated}`
                  : ""}
              </Tag>
              <Tag
                color={
                  evidenceIdentityFilter === "changed"
                    ? "purple"
                    : currentComparison.summary.evidenceIdentityChangedMetricCount > 0
                      ? "purple"
                      : "default"
                }
                style={{ cursor: "pointer" }}
                onClick={() =>
                  setEvidenceIdentityFilter((value) => (value === "changed" ? "all" : "changed"))
                }
              >
                evidence idΔ {currentComparison.summary.evidenceIdentityChangedMetricCount}
                {currentComparison.summary.evidenceIdentityChangedMetricCount > 0
                  ? ` · ${currentComparison.summary.evidenceIdentityOnlyBaselineRefCount}→${currentComparison.summary.evidenceIdentityOnlyCandidateRefCount}`
                  : ""}
              </Tag>
              <Tag
                color={promotionFilter === "changed" ? "purple" : "default"}
                style={{ cursor: "pointer" }}
                onClick={() => setPromotionFilter((value) => (value === "changed" ? "all" : "changed"))}
              >
                promotionΔ {currentComparison.summary.promotionChangedMetricCount}
              </Tag>
              <Tag color={(currentComparison.summary.promotionProvenanceChangedMetricCount ?? 0) > 0 ? "purple" : "default"}>
                provenanceΔ {currentComparison.summary.promotionProvenanceChangedMetricCount ?? 0}
              </Tag>
              <Tag
                color={promotionFilter === "scorecard" ? "blue" : "default"}
                style={{ cursor: "pointer" }}
                onClick={() => setPromotionFilter((value) => (value === "scorecard" ? "all" : "scorecard"))}
              >
                scorecardΔ {currentComparison.summary.scorecardMetricDelta}
              </Tag>
              <Tag
                color={promotionFilter === "diagnostic" ? "orange" : "default"}
                style={{ cursor: "pointer" }}
                onClick={() => setPromotionFilter((value) => (value === "diagnostic" ? "all" : "diagnostic"))}
              >
                diagnosticΔ {currentComparison.summary.diagnosticMetricDelta}
              </Tag>
              <Tag
                color={promotionFilter === "benchmark_only" ? "geekblue" : "default"}
                style={{ cursor: "pointer" }}
                onClick={() => setPromotionFilter((value) => (value === "benchmark_only" ? "all" : "benchmark_only"))}
              >
                benchmarkΔ {currentComparison.summary.benchmarkOnlyMetricDelta}
              </Tag>
              <Tag
                color={
                  typeof currentComparison.summary.committedStepsDelta === "number" &&
                  currentComparison.summary.committedStepsDelta !== 0
                    ? "processing"
                    : "default"
                }
              >
                socialΔ {currentComparison.summary.socialStepsDelta}
              </Tag>
              <Tag
                color={
                  typeof currentComparison.summary.committedStepsDelta === "number" &&
                  (currentComparison.summary.committedStepsDelta !== 0 ||
                    currentComparison.summary.rejectedStepsDelta !== 0)
                    ? "processing"
                    : "default"
                }
              >
                cΔ{currentComparison.summary.committedStepsDelta}/rΔ{currentComparison.summary.rejectedStepsDelta}
              </Tag>
              <Button
                size="small"
                icon={decorativeIcon(<CloudDownloadOutlined />)}
                loading={busy === "download-compare-json"}
                disabled={Boolean(busy) || pendingComparison}
                onClick={() => onDownloadComparison("json")}
              >
                导出 JSON
              </Button>
              <Button
                size="small"
                icon={decorativeIcon(<CloudDownloadOutlined />)}
                loading={busy === "download-compare-md"}
                disabled={Boolean(busy) || pendingComparison}
                onClick={() => onDownloadComparison("markdown")}
              >
                导出 Markdown
              </Button>
              <Button
                size="small"
                icon={decorativeIcon(<CloudDownloadOutlined />)}
                loading={busy === "download-compare-filtered-json"}
                disabled={Boolean(busy) || pendingComparison}
                onClick={() => {
                  void onDownloadFilteredComparison("json", activeFilter);
                }}
              >
                导出过滤 JSON
              </Button>
              <Button
                size="small"
                icon={decorativeIcon(<CloudDownloadOutlined />)}
                loading={busy === "download-compare-filtered-md"}
                disabled={Boolean(busy) || pendingComparison}
                onClick={() => {
                  void onDownloadFilteredComparison("markdown", activeFilter);
                }}
              >
                导出过滤 Markdown
              </Button>
            </Space>
          ) : (
            <Tag>未加载</Tag>
          )
        }
      >
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            aria-label="对比分组过滤"
            style={{ minWidth: 180 }}
            value={groupFilter}
            disabled={pendingComparison || !currentComparison}
            options={GROUP_FILTER_OPTIONS}
            onChange={(value) => setGroupFilter(value as "all" | MatchComparisonRowGroup)}
          />
          <Select
            aria-label="对比 promotion 过滤"
            style={{ minWidth: 200 }}
            value={promotionFilter}
            disabled={pendingComparison || !currentComparison}
            options={PROMOTION_FILTER_OPTIONS}
            onChange={(value) => setPromotionFilter(value as MatchComparisonPromotionFilter)}
          />
          <Select
            aria-label="对比 evidence identity 过滤"
            style={{ minWidth: 220 }}
            value={evidenceIdentityFilter}
            disabled={pendingComparison || !currentComparison}
            options={EVIDENCE_IDENTITY_FILTER_OPTIONS}
            onChange={(value) =>
              setEvidenceIdentityFilter(value as MatchComparisonEvidenceIdentityFilter)
            }
          />
          <Select
            aria-label="对比 numeric delta 过滤"
            style={{ minWidth: 200 }}
            value={numericDeltaFilter}
            disabled={pendingComparison || !currentComparison}
            options={NUMERIC_DELTA_FILTER_OPTIONS}
            onChange={(value) =>
              setNumericDeltaFilter(value as MatchComparisonNumericDeltaFilter)
            }
          />
          <Button
            type={changedOnly ? "primary" : "default"}
            disabled={pendingComparison || !currentComparison}
            onClick={() => setChangedOnly((value) => !value)}
          >
            {changedOnly ? "仅看 changed" : "显示全部"}
          </Button>
          <Button disabled={pendingComparison || !hasActiveFilter} onClick={resetFilters}>
            重置过滤
          </Button>
          <Button
            disabled={pendingComparison || !filteredProjection}
            onClick={() => {
              if (filteredProjection) onInspectFilteredProjection(filteredProjection);
            }}
          >
            检查过滤投影
          </Button>
          <Button onClick={() => void copyFilterDeepLink()}>
            {copyDeepLinkStatus ?? "复制过滤深链"}
          </Button>
        </Space>
        <Table
          rowKey="id"
          size="small"
          bordered
          columns={rowColumns}
          dataSource={filteredRows}
          pagination={MATRIX_TABLE_PAGINATION}
          onRow={(row) => ({ onClick: () => onInspectRow(row) })}
          locale={{
            emptyText: (
              <Empty
                description={
                  pendingComparison
                    ? "当前对比工件与基准/候选/view 不一致，矩阵已冻结。请先加载/重载服务端对比。"
                    : "选择候选运行后点击加载，UI 会等待真实 comparison API。"
                }
              />
            )
          }}
        />
      </Card>
    </Space>
  );
});
