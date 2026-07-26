import { Suspense, useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  Breadcrumb,
  Button,
  Card,
  ConfigProvider,
  Drawer,
  Flex,
  Grid,
  Input,
  Layout,
  Menu,
  Space,
  Tag,
  Tooltip
} from "antd";
import {
  EyeOutlined,
  ExperimentOutlined,
  FileSearchOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SettingOutlined,
  TeamOutlined
} from "@ant-design/icons";

import { parseMatchComparisonDeepLinkSelection } from "./harness/matchComparisonView";
import type { PolicyName } from "./harness/types";
import { POLICY_NAMES } from "./harness/profiles";
import {
  createCockpitExperimentDraft,
  validateCockpitExperimentDraft
} from "./components/cockpit/experimentDraft";
import { cockpitTheme } from "./components/cockpit/cockpitTheme";
import {
  SocietyEvidenceWorkspace,
  WerewolfLiveBoard,
  WerewolfReviewBoard,
  EvaluationWorkspace,
  Header,
  Sider,
  Text,
  Title,
  Paragraph,
  workspaceMenuItems,
  type Workspace,
  type ArtifactView,
  type MatchRecord
} from "./components/cockpit/appShared";
import {
  InspectorPanel,
  decorativeIcon,
  formatExperimentRosterSummary,
  shortId,
  inspectorFromMatch,
  inspectorFromPackShare,
  inspectorFromSocialExposure,
  inspectorFromSocialRelationship,
  inspectorFromSocialCommunication,
  inspectorFromMetric,
  inspectorFromWarning,
  inspectorFromComparisonRow,
  inspectorFromFilteredComparison,
  inspectorFromCheckpoint,
  inspectorFromForkLineage,
  inspectorFromBranchTree
} from "./components/cockpit/appInspectors";
import {
  LiveSpectatorShell,
  StatusBanner,
  CockpitChunkFallback,
  KpiGrid,
  RunContextPanel
} from "./components/cockpit/cockpitPanels";
import { ExperimentRosterComposer } from "./components/cockpit/ExperimentRosterComposer";
import { RunsWorkspace } from "./components/cockpit/RunsWorkspace";
import { TimelineWorkspace } from "./components/cockpit/TimelineWorkspace";
import { LineageWorkspace } from "./components/cockpit/LineageWorkspace";
import { CompareWorkspace } from "./components/cockpit/CompareWorkspace";
import { ExperimentsWorkspace } from "./components/cockpit/ExperimentsWorkspace";
import { PacksWorkspace } from "./components/cockpit/PacksWorkspace";
import { useCockpitStatus } from "./components/cockpit/hooks/useCockpitStatus";
import { useEvidenceInspector } from "./components/cockpit/hooks/useEvidenceInspector";
import { useWorkspaceRouting } from "./components/cockpit/hooks/useWorkspaceRouting";
import { useExperimentDraft } from "./components/cockpit/hooks/useExperimentDraft";
import { useCockpitConfig } from "./components/cockpit/hooks/useCockpitConfig";
import { useLiveProjectionState, useLiveMatchPolling } from "./components/cockpit/hooks/useLiveProjection";
import { useReplayState, useReplayActions } from "./components/cockpit/hooks/useReplay";
import { useComparisonState, useComparisonActions } from "./components/cockpit/hooks/useComparison";
import { useCheckpointState, useCheckpointActions } from "./components/cockpit/hooks/useCheckpoints";
import { useMatchArtifact } from "./components/cockpit/hooks/useMatchArtifact";
import { useEvidenceSelection } from "./components/cockpit/hooks/useEvidenceSelection";
import { useExperimentMatrix } from "./components/cockpit/hooks/useExperimentMatrix";
import { useTournamentPacks } from "./components/cockpit/hooks/useTournamentPacks";

export function App() {
  const screens = Grid.useBreakpoint();
  const initialCompareSelection = useMemo(
    () =>
      typeof window === "undefined"
        ? {}
        : parseMatchComparisonDeepLinkSelection(window.location.search),
    []
  );
  const [artifactView, setArtifactView] = useState<ArtifactView>(
    initialCompareSelection.view ?? "postgame-redacted"
  );
  // Keep only one fixed side rail on ordinary desktop widths. Mounting both
  // the 292px run-context rail and 384px evidence inspector at Ant's 1200px
  // `xl` breakpoint left the actual workspace only 524px wide. The existing
  // bounded evidence Drawer remains the inspector surface until `xxl`.
  const isCompactLayout = !screens.xxl;
  const isNarrowLayout = !screens.xl;

  const { status, error, busy, setBusy, setActionStatus } = useCockpitStatus();

  const {
    inspector,
    setInspector,
    revealInspector,
    rawOpen,
    setRawOpen,
    mobileContextOpen,
    setMobileContextOpen,
    mobileInspectorOpen,
    setMobileInspectorOpen,
    mobileContextTriggerRef,
    mobileInspectorTriggerRef,
    rawReturnFocusRef
  } = useEvidenceInspector({ isCompactLayout });

  const { workspace, setWorkspace, handleWorkspaceChange, activeWorkspace } = useWorkspaceRouting({ setActionStatus });

  const {
    experimentDraft,
    setExperimentDraft,
    rosterComposerOpen,
    setRosterComposerOpen,
    maxTransitions,
    setMaxTransitions,
    timeoutSeconds,
    setTimeoutSeconds,
    jointPhaseScheduler,
    setJointPhaseScheduler,
    experimentRequest
  } = useExperimentDraft();

  const {
    config,
    models,
    selectedModel,
    operatorRegistryEnabled,
    canUsePostgameArtifact,
    canUsePostgameReplay,
    canExportMatchArtifacts,
    canUseCheckpointControls,
    loadConfig
  } = useCockpitConfig({ artifactView, setArtifactView, setExperimentDraft });

  const experimentDraftError = useMemo(
    () => validateCockpitExperimentDraft(experimentDraft, models),
    [experimentDraft, models]
  );

  const {
    liveMatchId,
    setLiveMatchId,
    liveProjection,
    setLiveProjection,
    livePollError,
    setLivePollError,
    livePollSeqRef
  } = useLiveProjectionState();

  const {
    replay,
    setReplay,
    replayFrame,
    setReplayFrame,
    replayFrameCursorIndex,
    setReplayFrameCursorIndex,
    replayFrameLoadState,
    setReplayFrameLoadState,
    replayFrameError,
    setReplayFrameError,
    replayFrameLoadSeqRef
  } = useReplayState();

  const {
    candidateArtifact,
    setCandidateArtifact,
    comparison,
    setComparison,
    comparisonRequestContext,
    setComparisonRequestContext,
    comparisonRegistry,
    setComparisonRegistry,
    selectedComparisonId,
    setSelectedComparisonId,
    comparisonLoadSeqRef,
    candidateId,
    setCandidateId,
    loadComparisonPair
  } = useComparisonState({
    initialCandidateId: initialCompareSelection.candidateId,
    setInspector,
    setActionStatus,
    setBusy
  });

  const {
    checkpoints,
    setCheckpoints,
    selectedCheckpointId,
    setSelectedCheckpointId,
    forkLineage,
    setForkLineage,
    branchTree,
    setBranchTree
  } = useCheckpointState();

  const {
    matches,
    setMatches,
    selectedMatch,
    setSelectedMatch,
    artifact,
    setArtifact,
    selectedStepIndex,
    setSelectedStepIndex,
    selectedAgentId,
    setSelectedAgentId,
    query,
    setQuery,
    artifactBackedMatches,
    currentMatchId,
    filteredMatches,
    refreshMatches,
    loadArtifact,
    handleArtifactViewChange,
    handleRefresh,
    handleLoadLatest,
    handleRunExperiment,
    handleDownloadArtifact,
    handleDownloadMatchArtifact
  } = useMatchArtifact({
    initialCompareSelection,
    artifactView,
    setArtifactView,
    loadConfig,
    canUsePostgameArtifact,
    operatorRegistryEnabled,
    canExportMatchArtifacts,
    experimentRequest,
    experimentDraftError,
    jointPhaseScheduler,
    maxTransitions,
    timeoutSeconds,
    liveMatchId,
    setLiveMatchId,
    setLiveProjection,
    setLivePollError,
    livePollSeqRef,
    setReplay,
    replayFrameLoadSeqRef,
    setReplayFrame,
    setReplayFrameCursorIndex,
    setReplayFrameLoadState,
    setReplayFrameError,
    candidateId,
    setCandidateArtifact,
    setComparison,
    setComparisonRequestContext,
    loadComparisonPair,
    setCheckpoints,
    setSelectedCheckpointId,
    setForkLineage,
    setBranchTree,
    setWorkspace,
    setInspector,
    setActionStatus,
    setBusy
  });

  useLiveMatchPolling({
    liveMatchId,
    livePollSeqRef,
    setLiveProjection,
    setLivePollError,
    loadArtifact,
    canUsePostgameArtifact,
    candidateId,
    setActionStatus
  });

  const { handleReplay, handleLoadReplayFrame } = useReplayActions({
    artifact,
    currentMatchId,
    artifactView,
    canUsePostgameReplay,
    setReplay,
    replayFrameLoadSeqRef,
    setReplayFrame,
    setReplayFrameCursorIndex,
    setReplayFrameLoadState,
    setReplayFrameError,
    setInspector,
    setActionStatus,
    setBusy
  });

  const {
    compareCandidates,
    handleCandidateChange,
    handleLoadComparison,
    refreshComparisonRegistry,
    loadSavedComparisonById,
    handleLoadSavedComparison,
    handleDownloadComparison,
    handleDownloadFilteredComparison
  } = useComparisonActions({
    artifact,
    selectedMatch,
    matches,
    artifactBackedMatches,
    artifactView,
    setArtifact,
    setArtifactView,
    setMatches,
    setSelectedMatch,
    candidateId,
    setCandidateId,
    setCandidateArtifact,
    comparison,
    comparisonRequestContext,
    setComparison,
    setComparisonRequestContext,
    selectedComparisonId,
    setSelectedComparisonId,
    setComparisonRegistry,
    comparisonLoadSeqRef,
    loadComparisonPair,
    loadArtifact,
    setWorkspace,
    setInspector,
    setActionStatus,
    setBusy
  });

  const {
    handleRefreshCheckpoints,
    handleCreateCheckpoint,
    handleForkCheckpoint,
    handleLoadForkLineage,
    handleSelectCheckpoint,
    handleLoadBranchTree
  } = useCheckpointActions({
    canUseCheckpointControls,
    currentMatchId,
    artifactView,
    replayFrame,
    maxTransitions,
    timeoutSeconds,
    selectedCheckpointId,
    setCheckpoints,
    setSelectedCheckpointId,
    setForkLineage,
    setBranchTree,
    setCandidateId,
    loadComparisonPair,
    refreshMatches,
    setWorkspace,
    setInspector,
    setActionStatus,
    setBusy
  });

  const {
    selectedStep,
    agents,
    selectedAgent,
    messages,
    metrics,
    warnings,
    handleSelectStep,
    handleSelectAgent,
    handleSelectMessage
  } = useEvidenceSelection({
    artifact,
    selectedStepIndex,
    setSelectedStepIndex,
    selectedAgentId,
    setSelectedAgentId,
    revealInspector,
    setActionStatus
  });

  const {
    matrixResult,
    matrixArtifactSets,
    matrixGames,
    setMatrixGames,
    matrixExportArtifacts,
    setMatrixExportArtifacts,
    handleRefreshMatrixArtifacts,
    handleRunMatrixExperiment
  } = useExperimentMatrix({
    experimentRequest,
    experimentDraftError,
    jointPhaseScheduler,
    maxTransitions,
    timeoutSeconds,
    matrixExportCapability: config?.capabilities?.artifactExport?.matrix,
    setActionStatus,
    setBusy
  });

  const {
    tournamentPacks,
    tournamentExecutionTelemetry,
    selectedPackId,
    packShares,
    shareInventory,
    shareLabel,
    setShareLabel,
    packGames,
    setPackGames,
    shareExpiresInHours,
    setShareExpiresInHours,
    shareAllowlist,
    setShareAllowlist,
    handleRefreshTournamentPacks,
    handleRefreshShareInventory,
    handleDownloadShareAnalyticsSummary,
    handleExportTournamentPack,
    handleSelectTournamentPack,
    handleInspectTournamentComparison,
    handleCreateTournamentShare,
    handleCopyShareUrl,
    handleRevokeTournamentShare,
    handleRevokeAllActiveShares
  } = useTournamentPacks({
    experimentRequest,
    experimentDraftError,
    jointPhaseScheduler,
    maxTransitions,
    timeoutSeconds,
    refreshMatches,
    loadSavedComparisonById,
    setComparisonRegistry,
    setSelectedComparisonId,
    setWorkspace,
    setInspector,
    setActionStatus,
    setBusy
  });

  const werewolfReviewSource = useMemo(
    () =>
      replayFrame
        ? {
            projection: replayFrame.projection,
            finalState: replayFrame.state,
            werewolfReviewLedger: replayFrame.werewolfReviewLedger
          }
        : artifact,
    [artifact, replayFrame]
  );
  // Referentially stable values/handlers for the memoized workspace
  // components. Every underlying hook handler is already useCallback-stable;
  // these wrappers only close over the additional route context they need.
  const rosterSummary = useMemo(() => formatExperimentRosterSummary(experimentRequest), [experimentRequest]);
  const handleLoadArtifactFromRegistry = useCallback(
    (match: MatchRecord) => void loadArtifact(match, artifactView, candidateId),
    [artifactView, candidateId, loadArtifact]
  );
  const inspect = useMemo(() => {
    const bind =
      <A extends unknown[]>(build: (...args: A) => Parameters<typeof revealInspector>[0]) =>
      (...args: A) =>
        revealInspector(build(...args));
    return {
      match: bind(inspectorFromMatch),
      socialExposure: bind(inspectorFromSocialExposure),
      socialRelationship: bind(inspectorFromSocialRelationship),
      socialCommunication: bind(inspectorFromSocialCommunication),
      checkpoint: bind(inspectorFromCheckpoint),
      metric: bind(inspectorFromMetric),
      warning: bind(inspectorFromWarning),
      comparisonRow: bind(inspectorFromComparisonRow),
      filteredComparison: bind(inspectorFromFilteredComparison),
      packShare: bind(inspectorFromPackShare)
    };
  }, [revealInspector]);
  const handleSelectReplayBoundary = useCallback(
    (nativeStepCount: number) => void handleLoadReplayFrame(nativeStepCount - 1),
    [handleLoadReplayFrame]
  );
  const handleInspectForkLineageEvidence = useCallback(() => {
    if (forkLineage) revealInspector(inspectorFromForkLineage(forkLineage));
  }, [forkLineage, revealInspector]);
  const handleInspectBranchTreeEvidence = useCallback(() => {
    if (branchTree) revealInspector(inspectorFromBranchTree(branchTree));
  }, [branchTree, revealInspector]);
  const openRawEvidence = useCallback(() => setRawOpen(true), [setRawOpen]);
  const openRawEvidenceFromMobileInspector = useCallback(() => {
    rawReturnFocusRef.current = mobileInspectorTriggerRef.current;
    setMobileInspectorOpen(false);
    setRawOpen(true);
  }, [mobileInspectorTriggerRef, rawReturnFocusRef, setMobileInspectorOpen, setRawOpen]);
  const werewolfReviewBoardSource = useMemo(
    () =>
      replayFrame
        ? {
            kind: "replay-frame" as const,
            nativeStepCount: replayFrame.cursor.nativeStepCount,
            stateHash: replayFrame.cursor.stateHash ?? replayFrame.cursor.recordedPostStateHash
          }
        : { kind: "artifact-final" as const },
    [replayFrame]
  );

  // Only the active workspace's element is built; the other panels do not
  // exist as element trees, so switching workspaces stays cheap and the
  // memoized workspace components only diff their own props.
  let workspacePanel: ReactNode;
  switch (workspace) {
    case "timeline":
      workspacePanel = (
        <TimelineWorkspace
          artifact={artifact}
          selectedStepIndex={selectedStepIndex}
          selectedStep={selectedStep}
          onSelectStep={handleSelectStep}
          onSelectReplayFrame={handleLoadReplayFrame}
          onReplay={handleReplay}
          onDownloadJsonl={handleDownloadArtifact}
          onDownloadMatch={handleDownloadMatchArtifact}
          artifactView={artifactView}
          replay={replay}
          replayFrame={replayFrame}
          replayFrameCursorIndex={replayFrameCursorIndex}
          replayFrameLoadState={replayFrameLoadState}
          replayEnabled={canUsePostgameReplay}
          artifactDownloadEnabled={canExportMatchArtifacts}
          busy={busy}
        />
      );
      break;
    case "domain":
      workspacePanel = liveProjection ? (
        <Suspense fallback={<CockpitChunkFallback label="正在加载实时公开桌面…" />}>
          <WerewolfLiveBoard projection={liveProjection} pollError={livePollError} />
        </Suspense>
      ) : liveMatchId ? (
        <Card bordered={false} data-testid="werewolf-live-board">
          <Alert
            type="info"
            showIcon
            title="实时公开局正在连接"
            description="等待服务端的公开投影；浏览器不会从旧工件或本地状态构造实时局面。"
          />
        </Card>
      ) : (
        <Suspense fallback={<CockpitChunkFallback label="正在加载领域适配器复盘…" />}>
          <WerewolfReviewBoard
            reviewSource={werewolfReviewSource}
            source={werewolfReviewBoardSource}
            onSelectReplayBoundary={handleSelectReplayBoundary}
            loading={replayFrameLoadState === "loading"}
            error={replayFrameLoadState === "error" ? replayFrameError : null}
          />
        </Suspense>
      );
      break;
    case "society":
      workspacePanel = (
        <Suspense fallback={<CockpitChunkFallback label="正在加载社会证据工作台…" />}>
          <SocietyEvidenceWorkspace
            artifact={artifact}
            agents={agents}
            selectedAgent={selectedAgent}
            messages={messages}
            onSelectAgent={handleSelectAgent}
            onSelectMessage={handleSelectMessage}
            onInspectExposure={inspect.socialExposure}
            onInspectRelationship={inspect.socialRelationship}
            onInspectCommunication={inspect.socialCommunication}
          />
        </Suspense>
      );
      break;
    case "lineage":
      workspacePanel = (
        <LineageWorkspace
          currentMatchId={currentMatchId}
          checkpoints={checkpoints}
          selectedCheckpointId={selectedCheckpointId}
          forkLineage={forkLineage}
          branchTree={branchTree}
          replayBoundaryNativeStepCount={replayFrame?.cursor.nativeStepCount ?? null}
          operatorEnabled={canUseCheckpointControls}
          busy={busy}
          onRefreshCheckpoints={handleRefreshCheckpoints}
          onCreateCheckpoint={handleCreateCheckpoint}
          onForkCheckpoint={handleForkCheckpoint}
          onLoadForkLineage={handleLoadForkLineage}
          onSelectCheckpoint={handleSelectCheckpoint}
          onLoadBranchTree={handleLoadBranchTree}
          onInspectCheckpoint={inspect.checkpoint}
          onInspectForkLineage={handleInspectForkLineageEvidence}
          onInspectBranchTree={handleInspectBranchTreeEvidence}
        />
      );
      break;
    case "evaluation":
      workspacePanel = (
        <Suspense fallback={<CockpitChunkFallback label="正在加载评测工作区…" />}>
          <EvaluationWorkspace
            artifact={artifact}
            metrics={metrics}
            warnings={warnings}
            onInspectMetric={inspect.metric}
            onInspectWarning={inspect.warning}
          />
        </Suspense>
      );
      break;
    case "experiments":
      workspacePanel = (
        <ExperimentsWorkspace
          result={matrixResult}
          artifactSets={matrixArtifactSets}
          games={matrixGames}
          exportArtifacts={matrixExportArtifacts}
          exportAvailable={config?.capabilities?.artifactExport?.matrix === true}
          rosterSummary={rosterSummary}
          experimentReady={!experimentDraftError}
          maxTransitions={maxTransitions}
          timeoutSeconds={timeoutSeconds}
          busy={busy}
          onGamesChange={setMatrixGames}
          onExportArtifactsChange={setMatrixExportArtifacts}
          onRun={handleRunMatrixExperiment}
          onRefreshArtifacts={handleRefreshMatrixArtifacts}
        />
      );
      break;
    case "compare":
      workspacePanel = (
        <CompareWorkspace
          artifact={artifact}
          candidateArtifact={candidateArtifact}
          comparison={comparison}
          comparisonContext={comparisonRequestContext}
          baselineId={currentMatchId}
          candidates={compareCandidates}
          candidateId={candidateId}
          artifactView={artifactView}
          comparisonRegistry={comparisonRegistry}
          selectedComparisonId={selectedComparisonId}
          onCandidateChange={handleCandidateChange}
          onLoadComparison={handleLoadComparison}
          onRefreshComparisonRegistry={refreshComparisonRegistry}
          onSelectComparisonId={setSelectedComparisonId}
          onLoadSavedComparison={handleLoadSavedComparison}
          onDownloadComparison={handleDownloadComparison}
          onDownloadFilteredComparison={handleDownloadFilteredComparison}
          busy={busy}
          onInspectRow={inspect.comparisonRow}
          onInspectFilteredProjection={inspect.filteredComparison}
        />
      );
      break;
    case "packs":
      workspacePanel = (
        <PacksWorkspace
          packs={tournamentPacks}
          executionTelemetry={tournamentExecutionTelemetry}
          selectedPackId={selectedPackId}
          shares={packShares}
          shareInventory={shareInventory}
          shareLabel={shareLabel}
          packGames={packGames}
          shareExpiresInHours={shareExpiresInHours}
          shareAllowlist={shareAllowlist}
          busy={busy}
          rosterSummary={rosterSummary}
          experimentReady={!experimentDraftError}
          maxTransitions={maxTransitions}
          timeoutSeconds={timeoutSeconds}
          onRefresh={handleRefreshTournamentPacks}
          onRefreshShareInventory={handleRefreshShareInventory}
          onDownloadShareAnalyticsSummary={handleDownloadShareAnalyticsSummary}
          onExport={handleExportTournamentPack}
          onSelectPack={handleSelectTournamentPack}
          onInspectTournamentComparison={handleInspectTournamentComparison}
          onShareLabelChange={setShareLabel}
          onPackGamesChange={setPackGames}
          onShareExpiresInHoursChange={setShareExpiresInHours}
          onShareAllowlistChange={setShareAllowlist}
          onCreateShare={handleCreateTournamentShare}
          onCopyShare={handleCopyShareUrl}
          onRevokeShare={handleRevokeTournamentShare}
          onRevokeAllActiveShares={handleRevokeAllActiveShares}
          onInspectShare={inspect.packShare}
        />
      );
      break;
    case "runs":
    default:
      workspacePanel = (
        <RunsWorkspace
          matches={filteredMatches}
          selectedMatchId={currentMatchId}
          query={query}
          onQueryChange={setQuery}
          onLoadArtifact={handleLoadArtifactFromRegistry}
          onInspect={inspect.match}
          busy={busy}
        />
      );
      break;
  }
  const busyAny = Boolean(busy);
  // A live spectator is a distinct audience from the local research
  // operator. While this is true, no registry, model/profile, phase-detail,
  // scheduler, replay, checkpoint, comparison, or inspector UI is mounted.
  // The only current-match truth rendered by the browser is the narrow
  // `/api/matches/:id/live` DTO parsed above.
  const liveSpectatorPresentationActive = Boolean(liveMatchId || liveProjection);

  return (
    <ConfigProvider theme={cockpitTheme}>
      {liveSpectatorPresentationActive ? (
        <LiveSpectatorShell
          projection={liveProjection}
          pollError={livePollError}
          onExit={() => {
            livePollSeqRef.current += 1;
            setLiveMatchId(null);
            setLiveProjection(null);
            setLivePollError(null);
            setActionStatus("已返回研究台 · 服务端 live 局如仍在运行则继续，本机仅停止观战投影。");
          }}
        />
      ) : (
        <>
      <a
        className="skip-to-workspace"
        href="#workspace-main"
        onClick={() => {
          window.requestAnimationFrame(() => document.getElementById("workspace-main")?.focus());
        }}
      >
        跳至工作区内容
      </a>
      <Layout className="cockpit-shell" style={{ minWidth: 0, minHeight: "100vh" }}>
        {!isNarrowLayout ? (
          <Sider
            width={232}
            trigger={null}
            className="cockpit-sidebar"
          >
            <Flex vertical className="cockpit-sidebar__inner">
              <div className="cockpit-brand">
                <span className="cockpit-brand__mark" aria-hidden="true"><ExperimentOutlined /></span>
                <span><strong>多 Agent 社会实验台</strong><small>HARNESS COCKPIT</small></span>
              </div>

              <nav aria-label="工作区导航">
                <Menu
                  mode="inline"
                  theme="dark"
                  selectedKeys={[workspace]}
                  items={workspaceMenuItems}
                  onClick={({ key }) => handleWorkspaceChange(key as Workspace)}
                />
              </nav>
              <div className="cockpit-sidebar__footer">
                <div><span>当前 Run</span><Text code>{currentMatchId ? shortId(currentMatchId) : "未选择"}</Text></div>
                <div><span>投影视图</span><Tag color={artifactView === "truth-redacted" ? "gold" : "processing"}>{artifactView}</Tag></div>
                <Button
                  ref={mobileContextTriggerRef}
                  block
                  icon={decorativeIcon(<SettingOutlined />)}
                  onClick={() => setMobileContextOpen(true)}
                >
                  运行上下文
                </Button>
              </div>
            </Flex>
          </Sider>
        ) : null}

        <Layout style={{ minWidth: 0 }}>
          <Header className="cockpit-header">
            <Flex gap="middle" justify="space-between" align="center" wrap={isNarrowLayout}>
              <Flex vertical gap={2} className="cockpit-header__identity">
                {isNarrowLayout ? (
                  <Space size={6}>
                    <ExperimentOutlined style={{ color: "#3558d6" }} />
                    <Title level={1} className="cockpit-header__mobile-title">
                      多 Agent 社会实验台
                    </Title>
                  </Space>
                ) : null}
                <Breadcrumb
                  items={[
                    { title: "Harness" },
                    { title: activeWorkspace.label },
                    { title: currentMatchId ? shortId(currentMatchId) : "未选择 run" }
                  ]}
                />
                <Space size={8} wrap className="cockpit-header__title-row">
                  <Title level={2} className="cockpit-header__title">
                    {activeWorkspace.label}
                  </Title>
                  <Tag color={liveProjection?.lifecycle === "running" || liveMatchId ? "processing" : artifact ? "processing" : "default"}>
                    {liveProjection?.lifecycle === "running" || liveMatchId ? "服务端公开观战" : artifact ? "工件已加载" : "未加载工件"}
                  </Tag>
                </Space>
              </Flex>
              <Space wrap className="cockpit-header__actions">
                <Tooltip title="运行上下文">
                  <Button
                    ref={isNarrowLayout ? mobileContextTriggerRef : undefined}
                    aria-label="打开运行上下文"
                    icon={decorativeIcon(<SettingOutlined />)}
                    onClick={() => setMobileContextOpen(true)}
                  />
                </Tooltip>
                {isCompactLayout ? (
                  <Tooltip title="证据检查器">
                    <Button
                      ref={mobileInspectorTriggerRef}
                      aria-label="打开证据检查器"
                      icon={decorativeIcon(<FileSearchOutlined />)}
                      onClick={() => setMobileInspectorOpen(true)}
                    />
                  </Tooltip>
                ) : null}
                <Tooltip title="实验编排">
                  <Button aria-label="实验编排" icon={decorativeIcon(<TeamOutlined />)} onClick={() => setRosterComposerOpen(true)} disabled={busyAny}>
                    实验编排
                  </Button>
                </Tooltip>
                <Tooltip title="刷新运行注册表"><Button aria-label="刷新运行" icon={decorativeIcon(<ReloadOutlined />)} onClick={handleRefresh} disabled={busyAny || !operatorRegistryEnabled} /></Tooltip>
                <Tooltip title="加载最近工件"><Button aria-label="加载最近" icon={decorativeIcon(<EyeOutlined />)} onClick={handleLoadLatest} disabled={busyAny || !operatorRegistryEnabled} /></Tooltip>
                <Tooltip title="运行实验">
                  <Button aria-label="运行实验" type="primary" icon={decorativeIcon(<PlayCircleOutlined />)} loading={busy === "run"} onClick={handleRunExperiment} disabled={busyAny}>
                    运行实验
                  </Button>
                </Tooltip>
              </Space>
            </Flex>
          </Header>

          <Layout style={{ minWidth: 0 }}>
            <main id="workspace-main" tabIndex={-1} aria-label={`${activeWorkspace.label} 工作区`} className="cockpit-main">
              <StatusBanner status={status} error={error} busy={busy} />

              {workspace === "runs" ? (
                <KpiGrid
                  matches={matches}
                  artifact={artifact}
                  comparison={comparison}
                  replay={replay}
                />
              ) : null}

              <section
                role="region"
                aria-label={`${activeWorkspace.label} 工作区内容`}
                data-testid={`workspace-${workspace}`}
                className="cockpit-workspace"
              >
                {workspacePanel}
              </section>
            </main>

            {!isCompactLayout && inspector ? (
              <Sider
                width={320}
                trigger={null}
                className="cockpit-inspector"
              >
                <InspectorPanel item={inspector} onOpenRaw={openRawEvidence} artifactView={artifactView} />
              </Sider>
            ) : null}
          </Layout>
        </Layout>

        <Drawer
          title="实验编排 · Agent Roster"
          placement="left"
          width={screens.md ? 620 : "100vw"}
          open={rosterComposerOpen}
          onClose={() => setRosterComposerOpen(false)}
          destroyOnHidden
        >
          <ExperimentRosterComposer
            draft={experimentDraft}
            models={models}
            selectedModel={selectedModel}
            policyNames={(config?.policyNames?.filter((value): value is PolicyName => POLICY_NAMES.includes(value as PolicyName)) ?? POLICY_NAMES)}
            invalidReason={experimentDraftError}
            disabled={busyAny}
            onChange={setExperimentDraft}
            onReset={() =>
              setExperimentDraft(
                createCockpitExperimentDraft({
                  defaultProfiles: config?.defaultProfiles,
                  models,
                  selectedModel
                })
              )
            }
            onClose={() => setRosterComposerOpen(false)}
          />
        </Drawer>

        <Drawer
          title="运行上下文"
          placement="left"
          width={screens.sm ? 360 : "100vw"}
          open={mobileContextOpen}
          onClose={() => {
            setMobileContextOpen(false);
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => mobileContextTriggerRef.current?.focus());
            });
          }}
          afterOpenChange={(open) => {
            if (!open) mobileContextTriggerRef.current?.focus();
          }}
          destroyOnHidden
        >
          <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
            <Menu
              mode="inline"
              selectedKeys={[workspace]}
              items={workspaceMenuItems}
              onClick={({ key }) => {
                handleWorkspaceChange(key as Workspace);
                setMobileContextOpen(false);
              }}
            />
            <RunContextPanel
              artifactView={artifactView}
              postgameArtifactEnabled={canUsePostgameArtifact}
              onArtifactViewChange={(value) => void handleArtifactViewChange(value)}
              busy={busyAny}
              currentMatchId={currentMatchId}
              artifact={artifact}
              selectedMatch={selectedMatch}
              messageCount={artifact ? messages.length : null}
              metricCount={artifact ? metrics.length : null}
              maxTransitions={maxTransitions}
              onMaxTransitionsChange={setMaxTransitions}
              timeoutSeconds={timeoutSeconds}
              onTimeoutSecondsChange={setTimeoutSeconds}
              jointPhaseScheduler={jointPhaseScheduler}
              onJointPhaseSchedulerChange={setJointPhaseScheduler}
              rosterSummary={rosterSummary}
              rosterInvalidReason={experimentDraftError}
              onOpenRosterComposer={() => setRosterComposerOpen(true)}
            />
          </Space>
        </Drawer>

        <Drawer
          title="Evidence Inspector"
          placement="right"
          width={screens.sm ? 440 : "100vw"}
          open={mobileInspectorOpen}
          onClose={() => {
            setMobileInspectorOpen(false);
            if (!rawOpen) {
              window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => mobileInspectorTriggerRef.current?.focus());
              });
            }
          }}
          afterOpenChange={(open) => {
            if (!open && !rawOpen) mobileInspectorTriggerRef.current?.focus();
          }}
          destroyOnHidden
          styles={{ body: { padding: 0 } }}
        >
          <InspectorPanel
            item={inspector}
            onOpenRaw={openRawEvidenceFromMobileInspector}
            artifactView={artifactView}
          />
        </Drawer>

        <Drawer
          title={inspector?.title ?? "原始证据片段"}
          width={screens.md ? 760 : "100vw"}
          open={rawOpen}
          onClose={() => setRawOpen(false)}
          afterOpenChange={(open) => {
            if (open) return;
            const target = rawReturnFocusRef.current;
            rawReturnFocusRef.current = null;
            if (target?.isConnected) target.focus();
            else document.getElementById("workspace-main")?.focus();
          }}
          extra={<Tag color="processing">{artifactView}</Tag>}
        >
          <Paragraph type="secondary">
            只读片段来自当前服务端投影。private evidence redacted；
            {artifactView === "truth-redacted" ? " postgame truth redacted。" : " postgame truth visible。"}
          </Paragraph>
          <Input.TextArea readOnly value={JSON.stringify(inspector?.json ?? inspector ?? null, null, 2)} autoSize={{ minRows: 24, maxRows: 40 }} />
        </Drawer>
      </Layout>
        </>
      )}
    </ConfigProvider>
  );
}
