import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  Badge,
  Breadcrumb,
  Button,
  Card,
  Col,
  ConfigProvider,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Form,
  Grid,
  Input,
  Layout,
  Menu,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table as AntTable,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography
} from "antd";
import type { DescriptionsProps, MenuProps, TableProps, TabsProps } from "antd";
import zhCN from "antd/locale/zh_CN";
import {
  ApiOutlined,
  BarChartOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  CloudDownloadOutlined,
  CodeOutlined,
  DatabaseOutlined,
  EyeOutlined,
  ExperimentOutlined,
  FileSearchOutlined,
  MessageOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ShareAltOutlined,
  SwapOutlined,
  TeamOutlined,
  WarningOutlined
} from "@ant-design/icons";

import type { PublicGameState } from "./core/types";
import type { MatchArtifact } from "./harness/artifacts";
import {
  applyMatchComparisonRowFilterToSearchParams,
  buildMatchComparisonFilterDeepLink,
  formatComparisonRegistryEntryLabel,
  isMatchComparisonSelectionCurrent,
  mergeExportedTournamentPackList,
  parseMatchComparisonDeepLinkSelection,
  parseMatchComparisonRowFilterFromSearchParams,
  projectFilteredMatchComparison,
  resolvePackSeededComparisonSelection,
  type MatchComparisonArtifact,
  type MatchComparisonEvidenceIdentityFilter,
  type MatchComparisonFilteredProjection,
  type MatchComparisonNumericDeltaFilter,
  type MatchComparisonPromotionFilter,
  type MatchComparisonRow,
  type MatchComparisonRowGroup,
  type ResolvePackSeededComparisonSource
} from "./harness/matchComparisonView";
import type { PostgameMatchProjectionDto, PostgameReplayFrameDto, RedactedHarnessStepDto, RedactedSocialStepDto } from "./server/artifactProjection";
import type {
  AgentHarnessState,
  HarnessEvaluationWarning,
  HarnessMetricRecord,
  HarnessMetricPromotionDecision,
  HarnessRunStatus
} from "./harness/types";
import { DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER, WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS } from "./harness/types";
import { legacyMetricPromotionPolicyFromSummary, resolveRecordedMetricPromotion } from "./harness/evaluation";
import { countSocialStepCommits, isSocialStepCommitted, type SocialChannel, type SocialExposureRecord, type SocialMessage } from "./harness/social";
import { isSafeHarnessCheckpointBoundary } from "./harness/episodeArtifacts";
import type { SocialStateMutationJournalEntry } from "./harness/socialState";
import { AgentDecisionEvidencePanel, buildDecisionJournalEvidence } from "./components/cockpit/AgentDecisionEvidencePanel";
import { SocialEvidenceGraph } from "./components/cockpit/SocialEvidenceGraph";
import { WerewolfReviewBoard } from "./components/cockpit/WerewolfReviewBoard";
import { buildWerewolfReviewModel } from "./components/cockpit/werewolfReviewProjection";

type Workspace = "runs" | "timeline" | "domain" | "society" | "lineage" | "evaluation" | "experiments" | "compare" | "packs";

const DEFAULT_TABLE_SCROLL = { x: "max-content" } as const;

function Table<RecordType extends object>(props: TableProps<RecordType>) {
  // Evidence tables may be wider than a compact cockpit viewport. Keep that
  // overflow within the table so it never widens the page or mobile drawers.
  return <AntTable {...props} scroll={props.scroll ?? DEFAULT_TABLE_SCROLL} />;
}

function parseWorkspaceFromSearch(search: string): Workspace | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const raw = params.get("workspace") ?? params.get("tab");
  if (
    raw === "runs" ||
    raw === "timeline" ||
    raw === "domain" ||
    raw === "society" ||
    raw === "lineage" ||
    raw === "evaluation" ||
    raw === "experiments" ||
    raw === "compare" ||
    raw === "packs"
  ) {
    return raw;
  }
  return null;
}
type ArtifactView = "postgame-redacted" | "truth-redacted";

type ProjectedMatchArtifact = PostgameMatchProjectionDto;

/**
 * The truth-redacted comparison DTO intentionally has no canonical match ids.
 * Keep the route-owned request pair separately so the cockpit can render it
 * without asking a public response to reveal its private provenance.
 */
interface ComparisonRequestContext {
  comparisonId: string;
  baselineId: string;
  candidateId: string;
  view: ArtifactView;
}

/**
 * The cockpit graph deliberately accepts only the server projection contract.
 * A canonical MatchArtifact is execution/replay authority, not browser input;
 * accepting it here would make a future caller accidentally rederive scoped
 * exposure evidence from private observations.
 */
type SocialGraphArtifact = Pick<PostgameMatchProjectionDto, "agents" | "socialEpisode" | "projection">;
type ProjectedSocialStep = RedactedSocialStepDto;

export interface SocialGraphNode {
  id: string;
  sent: number;
  received: number;
  observed: number;
}

export interface SocialGraphMessageEdge {
  sourceId: string;
  targetId: string;
  messages: number;
}

export interface SocialGraphExposureEdge {
  sourceId: string;
  targetId: string;
  channelId: string;
  visibility: SocialMessage["visibility"];
  kind?: string;
  messages: number;
  observations: number;
  actionKinds: string[];
  traceIds: string[];
  turnIndexes: number[];
  evidenceCount: number;
  evidenceLabels: string[];
}

export interface SocialGraph {
  nodes: SocialGraphNode[];
  messageEdges: SocialGraphMessageEdge[];
  exposureEdges: SocialGraphExposureEdge[];
}

interface SocialJournalRow extends SocialStateMutationJournalEntry {
  key: string;
  owner: string;
  evidenceCount: number;
}

interface ConfigResponse {
  models?: string[];
  policyNames?: string[];
  defaultProfiles?: Array<{
    id: string;
    model: string;
    temperature?: number;
    policyName?: string;
  }>;
  provider?: {
    protocol?: string;
    configured?: boolean;
    models?: string[];
  };
  artifactExport?: {
    tournamentConfigured?: boolean;
    matrixConfigured?: boolean;
    checkpointConfigured?: boolean;
    matchConfigured?: boolean;
  };
}

interface MatchRecord {
  id: string;
  createdAt: string;
  state: PublicGameState;
  models: string[];
  status: "created" | "running" | "completed" | "failed";
  harnessStatus?: HarnessRunStatus | null;
  truncationReason?: string | null;
  error?: string;
  hasArtifact?: boolean;
  profileCount?: number;
  nativeSteps?: number;
  committedSteps?: number;
  rejectedSteps?: number;
  trajectorySteps?: number;
  legacyProjectionSteps?: number;
  checkpointCount?: number;
  summary?: unknown;
}

interface ComparisonRegistrySummary {
  comparisonId: string;
  createdAt: string;
  view: string;
  projection?: {
    view?: string;
    privateEvidenceRedacted?: boolean;
    postgameTruthRedacted?: boolean;
  };
  baseline: {
    matchId?: string;
    runId?: string;
    seed?: string;
  };
  candidate: {
    matchId?: string;
    runId?: string;
    seed?: string;
  };
  summary: {
    rowCount: number;
    changedRowCount: number;
    numericDeltaCount?: number;
    promotionChangedMetricCount?: number;
    promotionProvenanceChangedMetricCount?: number;
    scorecardMetricDelta?: number;
    diagnosticMetricDelta?: number;
    benchmarkOnlyMetricDelta?: number;
    evidenceIdentityChangedMetricCount?: number;
    evidenceIdentityOnlyBaselineRefCount?: number;
    evidenceIdentityOnlyCandidateRefCount?: number;
    metricKeysCompared?: number;
    metricKeysEmitted?: number;
    metricKeysTruncated?: number;
    scorecardMetricKeysCompared?: number;
    scorecardMetricKeysEmitted?: number;
    scorecardMetricKeysTruncated?: number;
    diagnosticMetricKeysCompared?: number;
    diagnosticMetricKeysEmitted?: number;
    diagnosticMetricKeysTruncated?: number;
    benchmarkOnlyMetricKeysCompared?: number;
    benchmarkOnlyMetricKeysEmitted?: number;
    benchmarkOnlyMetricKeysTruncated?: number;
    metricRowsMax?: number;
    baselineSocialSteps?: number;
    candidateSocialSteps?: number;
    baselineCommittedSteps?: number;
    candidateCommittedSteps?: number;
    baselineRejectedSteps?: number;
    candidateRejectedSteps?: number;
    socialStepsDelta?: number;
    committedStepsDelta?: number;
    rejectedStepsDelta?: number;
    baselineHash: string;
    candidateHash: string;
  };
}


interface TournamentArtifactSetSummary {
  artifactSetId: string;
  id: string;
  createdAt: string;
  experimentId: string;
  seed: string;
  files: Record<string, unknown>;
  downloads: Record<string, unknown>;
  nativeSteps?: number | null;
  committedSteps?: number | null;
  rejectedSteps?: number | null;
  metricCount?: number | null;
  scorecardEligibleMetricCount?: number | null;
  metricPromotionClassCounts?: {
    scorecard?: number;
    diagnostic?: number;
    benchmark_only?: number;
  } | null;
  scorecardEligibleMetricClassCounts?: {
    scorecard?: number;
    diagnostic?: number;
    benchmark_only?: number;
  } | null;
  projection?: {
    matchArtifactView?: "full" | "postgame-redacted" | "truth-redacted";
    assignmentTruthRedacted?: boolean;
    publicShareSafe?: boolean;
  } | null;
}

interface TournamentComparisonAggregateView {
  artifactVersion: string;
  kind: "tournament-comparison";
  comparisonSetId: string;
  createdAt: string;
  view: string;
  tournamentSeed: string;
  experimentId?: string | null;
  gamesRequested: number;
  artifactMatchCount: number;
  pairCount: number;
  pairs: Array<{
    comparisonId: string;
    baseline: { episodeIndex: number; seed: string; runId: string; matchId?: string };
    candidate: { episodeIndex: number; seed: string; runId: string; matchId?: string };
    changedRowCount: number;
    numericDeltaCount: number;
    scorecardMetricDelta: number;
    diagnosticMetricDelta: number;
    benchmarkOnlyMetricDelta: number;
    promotionProvenanceChangedMetricCount: number;
    evidenceIdentityChangedMetricCount: number;
    baselineSocialSteps?: number;
    candidateSocialSteps?: number;
    baselineCommittedSteps?: number;
    candidateCommittedSteps?: number;
    baselineRejectedSteps?: number;
    candidateRejectedSteps?: number;
    socialStepsDelta?: number;
    committedStepsDelta?: number;
    rejectedStepsDelta?: number;
  }>;
  metricChangeFrequency: Array<{
    metricKey: string;
    label: string;
    pairCount: number;
    changedPairCount: number;
    averageAbsoluteDelta: number | null;
  }>;
  summary: {
    changedPairCount: number;
    totalChangedRows: number;
    averageChangedRows: number;
    totalScorecardMetricDelta: number;
    totalDiagnosticMetricDelta: number;
    totalBenchmarkOnlyMetricDelta: number;
    totalPromotionProvenanceChangedMetrics: number;
    totalEvidenceIdentityChangedMetrics: number;
    totalSocialStepsDelta?: number;
    totalCommittedStepsDelta?: number;
    totalRejectedStepsDelta?: number;
    pairIdentityHash: string;
  };
  projection?: {
    view: string;
    privateEvidenceRedacted: boolean;
    postgameTruthRedacted: boolean;
    generatedAt: string;
  };
}


interface TournamentPublicShareSummary {
  shareId: string;
  id: string;
  artifactSetId: string;
  createdAt: string;
  expiresAt: string | null;
  label?: string | null;
  relativeFiles?: string[] | null;
  projection?: TournamentArtifactSetSummary["projection"];
  expired?: boolean;
  urls?: {
    detail?: string;
    filesBase?: string;
  };
  analytics?: {
    detailViewCount?: number;
    downloadCount?: number;
    downloadsByFile?: Record<string, number>;
    downloadEvents?: Array<{ at: string; file: string }>;
    detailViewEvents?: string[];
    downloadsByMinute?: Array<{ minute: string; count: number }>;
    detailViewsByMinute?: Array<{ minute: string; count: number }>;
    lastDetailViewedAt?: string | null;
    lastDownloadedAt?: string | null;
    lastDownloadedFile?: string | null;
  };
  packFound?: boolean;
  packSeed?: string | null;
  packExperimentId?: string | null;
  packCreatedAt?: string | null;
  packProjection?: TournamentArtifactSetSummary["projection"];
  packDensity?: {
    nativeSteps?: number | null;
    committedSteps?: number | null;
    rejectedSteps?: number | null;
  } | null;
  packMetricPromotion?: {
    metricCount?: number | null;
    scorecardEligibleMetricCount?: number | null;
    metricPromotionClassCounts?: {
      scorecard?: number;
      diagnostic?: number;
      benchmark_only?: number;
    } | null;
    scorecardEligibleMetricClassCounts?: {
      scorecard?: number;
      diagnostic?: number;
      benchmark_only?: number;
    } | null;
  } | null;
}

interface TournamentPublicShareInventory {
  count: number;
  activeCount: number;
  expiredCount: number;
  packsWithPromotionCount?: number;
  metricCount?: number;
  scorecardEligibleMetricCount?: number;
  metricPromotionClassCounts?: {
    scorecard?: number;
    diagnostic?: number;
    benchmark_only?: number;
  };
  packsWithDensityCount?: number;
  nativeSteps?: number;
  committedSteps?: number;
  rejectedSteps?: number;
  shares: TournamentPublicShareSummary[];
}

interface TournamentRunResponse {
  summary?: {
    ok?: boolean;
    status?: "completed" | "truncated" | "failed";
    seed?: string;
    gamesRequested?: number;
    gamesCompleted?: number;
    gamesFailed?: number;
    gamesTruncated?: number;
    nativeSteps?: number;
    committedSteps?: number;
    rejectedSteps?: number;
    failureReason?: string;
    evaluation?: {
      gamesEvaluated?: number;
      gamesWithoutEvaluation?: number;
      nativeSteps?: number;
      committedSteps?: number;
      rejectedSteps?: number;
      metricCount?: number;
      scorecardEligibleMetricCount?: number;
      metricPromotionClassCounts?: {
        scorecard?: number;
        diagnostic?: number;
        benchmark_only?: number;
      };
      scorecardEligibleMetricClassCounts?: {
        scorecard?: number;
        diagnostic?: number;
        benchmark_only?: number;
      };
      modelRewards?: Record<
        string,
        {
          agentGames?: number;
          wins?: number;
          winRate?: number;
          averageReward?: number;
          nativeSteps?: number;
          committedSteps?: number;
          rejectedSteps?: number;
        }
      >;
    };
    evaluationReports?: {
      reports?: number;
      metricCount?: number;
      scorecardEligibleMetricCount?: number;
      metricPromotionClassCounts?: {
        scorecard?: number;
        diagnostic?: number;
        benchmark_only?: number;
      };
      scorecardEligibleMetricClassCounts?: {
        scorecard?: number;
        diagnostic?: number;
        benchmark_only?: number;
      };
      warningCount?: number;
      reportsWithWarnings?: number;
    };
    artifacts?: TournamentArtifactSetSummary | null;
  };
  artifacts?: TournamentArtifactSetSummary | null;
  episodes?: Array<{
    index?: number;
    seed?: string;
    runId?: string;
    matchId?: string;
    status?: string;
    hasArtifact?: boolean;
    nativeSteps?: number;
    committedSteps?: number;
    rejectedSteps?: number;
    metricCount?: number;
    scorecardEligibleMetricCount?: number;
    metricPromotionClassCounts?: {
      scorecard?: number;
      diagnostic?: number;
      benchmark_only?: number;
    };
  }>;
  error?: string;
}

interface ExperimentMatrixSubjectStat {
  subjectType: "model" | "profile";
  subjectId: string;
  model?: string;
  profileId?: string;
  policyName?: string;
  seatGames: number;
  wins: number;
  losses: number;
  winRate: number;
  rewardCount: number;
  rewardMean: number;
}

interface ExperimentMatrixPairwiseComparison {
  leftModel: string;
  rightModel: string;
  leftSeatGames: number;
  rightSeatGames: number;
  winRateDiff: number;
  pValueTwoSided: number | null;
  pValueHolm: number | null;
  warning: string;
}

interface ExperimentMatrixStatisticsView {
  kind?: string;
  matrixId?: string;
  denominatorPolicy?: {
    seatLevelRows?: string;
    completedEpisodeRows?: string;
    truncatedEpisodes?: string;
    failedEpisodes?: string;
    significance?: string;
    superiorityClaims?: false;
  };
  status?: {
    cellsRequested?: number;
    cellsCompleted?: number;
    cellsTruncated?: number;
    cellsFailed?: number;
    gamesRequested?: number;
    gamesCompleted?: number;
    gamesTruncated?: number;
    gamesFailed?: number;
    completedSeatRows?: number;
  };
  modelStats?: ExperimentMatrixSubjectStat[];
  profileStats?: ExperimentMatrixSubjectStat[];
  pairwiseModelComparisons?: ExperimentMatrixPairwiseComparison[];
}

interface ExperimentMatrixCellSummary {
  index: number;
  id: string;
  label: string;
  group: string;
  status: "completed" | "truncated" | "failed";
  elapsedMs: number;
  gamesRequested: number;
  gamesCompleted: number;
  gamesTruncated: number;
  gamesFailed: number;
  models: string[];
  profileCount?: number;
  hasArtifacts?: boolean;
  error?: string | null;
}

interface ExperimentMatrixArtifactSetSummary {
  artifactSetId: string;
  id: string;
  createdAt: string;
  matrixId: string;
  files: Record<string, unknown>;
  downloads: Record<string, unknown>;
}

interface ExperimentMatrixRunResponse {
  summary?: {
    ok?: boolean;
    matrixId?: string;
    status?: "completed" | "partial" | "failed";
    cellsRequested?: number;
    cellsCompleted?: number;
    cellsTruncated?: number;
    cellsFailed?: number;
    gamesRequested?: number;
    gamesCompleted?: number;
    gamesTruncated?: number;
    gamesFailed?: number;
    failureReason?: string | null;
    artifacts?: ExperimentMatrixArtifactSetSummary | null;
  };
  artifacts?: ExperimentMatrixArtifactSetSummary | null;
  cells?: ExperimentMatrixCellSummary[];
  statistics?: ExperimentMatrixStatisticsView;
  error?: string;
}

interface ReplayResponse {
  summary?: {
    kind?: "replay";
    authority?: "native-social-episode";
    ok?: boolean;
    replayedSteps?: number;
    replayedBatches?: number;
    rejectedSteps?: number;
    nativeSteps?: number;
    committedSteps?: number;
    finalHash?: string;
    expectedFinalHash?: string;
    finalHashMatchesArtifact?: boolean;
    finalHashMatchesExpected?: boolean;
    messagesHashMatchesExpected?: boolean;
    mismatchCount?: number;
  };
  replay?: unknown;
  error?: string;
}

interface ReplayFrameResponse {
  frame: PostgameReplayFrameDto;
}

type ReplayFrameLoadState = "idle" | "loading" | "error";

interface CheckpointSummary {
  kind?: "checkpoint";
  ok?: boolean;
  checkpointId: string;
  createdAt: string;
  reason?: string | null;
  source: {
    runId: string;
    matchId?: string | null;
    seed?: string;
    status?: string;
    boundaryTraceRef?: string | null;
    boundaryTurnIndex?: number | null;
    boundaryBatchId?: string | null;
    boundaryBatchIndex?: number | null;
    boundarySchedulerMode?: string | null;
    nativeStepCount: number;
    messageCount: number;
    lastMessageSeq?: number | null;
    stateHash: string;
    executionPrefixHash?: string | null;
    agentsHash?: string | null;
    channelsHash?: string | null;
    messagesHash?: string | null;
    failureReason?: string | null;
    truncationReason?: string | null;
  };
  counts: {
    agents: number;
    nativeSteps: number;
    committedSteps?: number;
    rejectedSteps?: number;
    socialMessages: number;
    channels: number;
  };
}

interface CheckpointsResponse {
  checkpoints: CheckpointSummary[];
}

interface CheckpointCreateResponse {
  summary: CheckpointSummary;
  artifactUrl?: string;
}

interface ForkLineageSummary {
  kind?: "fork-lineage";
  schemaVersion?: string;
  ok?: boolean;
  isFork?: boolean;
  runId?: string;
  matchId?: string | null;
  forkOf?: Record<string, unknown> | null;
  parent?: Record<string, unknown> | null;
  child?: {
    runId?: string;
    matchId?: string | null;
    status?: string;
    nativeStepCount?: number;
    committedSteps?: number;
    rejectedSteps?: number;
    legacyProjectionSteps?: number;
    socialMessages?: number;
    firstStepPreStateHash?: string | null;
    finalStepPostStateHash?: string | null;
    finalStateHash?: string;
  };
  boundary?: {
    status?: string;
    checkpointFound?: boolean;
    stateHashMatches?: boolean | null;
    checkpointSourceMatchesForkOf?: boolean | null;
    messagePrefixMatchesCheckpoint?: boolean | null;
    newNativeSteps?: number;
    newCommittedSteps?: number;
    newRejectedSteps?: number;
    newSocialMessages?: number | null;
  };
}

interface ForkLineageResponse {
  summary: ForkLineageSummary;
}

interface BranchTreeSummary {
  kind?: "checkpoint-branch-tree";
  schemaVersion?: string;
  ok?: boolean;
  okScope?: string;
  rootCheckpointId?: string;
  counts?: {
    checkpoints?: number;
    matches?: number;
    edges?: number;
    maxDepth?: number;
  };
  truncation?: {
    isTruncated?: boolean;
    reasons?: string[];
    omittedCheckpoints?: number;
    omittedMatches?: number;
    omittedEdges?: number;
  };
  checkpoints?: Array<{
    depth?: number;
    checkpointId?: string;
    createdAt?: string;
    childForkCount?: number;
    summary?: CheckpointSummary;
  }>;
  matches?: Array<{
    depth?: number;
    parentCheckpointId?: string;
    runId?: string;
    matchId?: string | null;
    createdAt?: string;
    status?: string;
    nativeStepCount?: number;
    legacyProjectionSteps?: number;
    socialMessages?: number;
    lineage?: ForkLineageSummary;
  }>;
  edges?: Array<{
    id?: string;
    kind?: string;
    fromCheckpointId?: string;
    toRunId?: string;
    fromRunId?: string;
    toCheckpointId?: string;
    ok?: boolean;
    boundaryStatus?: string;
  }>;
}

interface BranchTreeResponse {
  summary: BranchTreeSummary;
}

interface InspectorItem {
  kind: string;
  title: string;
  subtitle?: string;
  fields: Array<[string, unknown]>;
  json?: unknown;
  actions?: Array<{
    key: string;
    label: string;
    disabled?: boolean;
    onClick: () => void;
  }>;
}

const { Header, Sider, Content } = Layout;
const { Text, Title, Paragraph } = Typography;

const DEFAULT_MAX_TRANSITIONS = 4;
const DEFAULT_TIMEOUT_SECONDS = 180;

const workspaceItems: Array<{
  id: Workspace;
  label: string;
  description: string;
  icon: ReactNode;
}> = [
  { id: "runs", label: "运行", description: "实验注册表与真实执行", icon: <DatabaseOutlined /> },
  { id: "timeline", label: "时间线", description: "step / trace / action debugger", icon: <BranchesOutlined /> },
  { id: "domain", label: "狼人杀复盘", description: "赛后局面、公开发言与投票", icon: <RobotOutlined /> },
  { id: "society", label: "社会", description: "agent、消息、关系证据", icon: <TeamOutlined /> },
  { id: "lineage", label: "谱系", description: "checkpoint、fork、branch tree", icon: <ApiOutlined /> },
  { id: "evaluation", label: "评测", description: "指标、证据、告警", icon: <SafetyCertificateOutlined /> },
  { id: "experiments", label: "实验矩阵", description: "矩阵控制面、统计与研究工件", icon: <DatabaseOutlined /> },
  { id: "compare", label: "对比", description: "基准与候选工件矩阵", icon: <SwapOutlined /> },
  { id: "packs", label: "公开包", description: "锦标赛工件与分享链接", icon: <ShareAltOutlined /> }
];

export function App() {
  const screens = Grid.useBreakpoint();
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<MatchRecord | null>(null);
  const [artifact, setArtifact] = useState<ProjectedMatchArtifact | null>(null);
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
  const [candidateArtifact, setCandidateArtifact] = useState<ProjectedMatchArtifact | null>(null);
  const [comparison, setComparison] = useState<MatchComparisonArtifact | null>(null);
  const [comparisonRequestContext, setComparisonRequestContext] = useState<ComparisonRequestContext | null>(null);
  const [comparisonRegistry, setComparisonRegistry] = useState<ComparisonRegistrySummary[]>([]);
  const [selectedComparisonId, setSelectedComparisonId] = useState("");
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState("");
  const [forkLineage, setForkLineage] = useState<ForkLineageSummary | null>(null);
  const [branchTree, setBranchTree] = useState<BranchTreeSummary | null>(null);
  const [workspace, setWorkspace] = useState<Workspace>(() => parseWorkspaceFromSearch(window.location.search) ?? "runs");
  const [selectedStepIndex, setSelectedStepIndex] = useState(0);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [maxTransitions, setMaxTransitions] = useState(String(DEFAULT_MAX_TRANSITIONS));
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(DEFAULT_TIMEOUT_SECONDS));
  const [jointPhaseScheduler, setJointPhaseScheduler] = useState<"aec-batched-decision" | "parallel">(DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER);
  const [status, setStatus] = useState("正在连接 harness API...");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const comparisonLoadSeqRef = useRef(0);
  const artifactLoadSeqRef = useRef(0);
  // Startup is an initialization transaction, not a reaction to later view or
  // comparison selection changes. Re-running it would overwrite user intent.
  const bootstrapStartedRef = useRef(false);
  const inspectTournamentComparisonRef = useRef<(pack: TournamentArtifactSetSummary) => Promise<boolean>>(async () => false);
  const [candidateId, setCandidateId] = useState<string>(initialCompareSelection.candidateId ?? "");
  const [replay, setReplay] = useState<ReplayResponse | null>(null);
  // Cursor state is presentation-only. The server owns replay, state hashes,
  // redaction, and native batch-boundary validation.
  const [replayFrame, setReplayFrame] = useState<PostgameReplayFrameDto | null>(null);
  const [replayFrameCursorIndex, setReplayFrameCursorIndex] = useState<number | null>(null);
  const [replayFrameLoadState, setReplayFrameLoadState] = useState<ReplayFrameLoadState>("idle");
  const [replayFrameError, setReplayFrameError] = useState<string | null>(null);
  const replayFrameLoadSeqRef = useRef(0);
  const [inspector, setInspector] = useState<InspectorItem | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [tournamentPacks, setTournamentPacks] = useState<TournamentArtifactSetSummary[]>([]);
  const [matrixResult, setMatrixResult] = useState<ExperimentMatrixRunResponse | null>(null);
  const [matrixArtifactSets, setMatrixArtifactSets] = useState<ExperimentMatrixArtifactSetSummary[]>([]);
  const [matrixGames, setMatrixGames] = useState("2");
  const [matrixExportArtifacts, setMatrixExportArtifacts] = useState(false);
  const [selectedPackId, setSelectedPackId] = useState("");
  const [packShares, setPackShares] = useState<TournamentPublicShareSummary[]>([]);
  const [shareInventory, setShareInventory] = useState<TournamentPublicShareInventory | null>(null);
  const [shareLabel, setShareLabel] = useState("paper-pack");
  const [packGames, setPackGames] = useState("2");
  const [shareExpiresInHours, setShareExpiresInHours] = useState("");
  const [shareAllowlist, setShareAllowlist] = useState<string[]>(DEFAULT_SHARE_ALLOWLIST);

  const models = useMemo(() => config?.models ?? config?.provider?.models ?? [], [config]);
  const artifactBackedMatches = useMemo(() => matches.filter((match) => match.hasArtifact), [matches]);
  const currentMatchId = selectedMatch?.id ?? artifact?.matchId ?? artifact?.runId ?? "";
  const selectedStep = artifact?.socialEpisode?.steps?.[selectedStepIndex] ?? null;
  const agents = artifact?.agents ?? [];
  const selectedAgent = selectedAgentId ? agents.find((agent) => agent.playerId === selectedAgentId) ?? null : agents[0] ?? null;
  const messages = artifact?.socialEpisode?.messages ?? [];
  const channels = artifact?.socialEpisode?.channels ?? [];
  const metrics = artifact?.evaluationReport?.metrics ?? [];
  const warnings = artifact?.evaluationReport?.warnings ?? [];
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
  const werewolfReview = useMemo(() => buildWerewolfReviewModel(werewolfReviewSource), [werewolfReviewSource]);
  const activeWorkspace = workspaceItems.find((item) => item.id === workspace) ?? workspaceItems[0];
  const isCompactLayout = !screens.lg;
  const isNarrowLayout = !screens.xl;

  const filteredMatches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return matches;
    return matches.filter((match) => {
      const haystack = [
        match.id,
        match.status,
        match.harnessStatus ?? "",
        match.state.phase,
        match.models.join(" ")
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [matches, query]);

  const compareCandidates = useMemo(() => {
    const baselineIds = new Set([selectedMatch?.id, artifact?.runId, artifact?.matchId].filter(Boolean));
    return artifactBackedMatches.filter((match) => !baselineIds.has(match.id));
  }, [artifact?.matchId, artifact?.runId, artifactBackedMatches, selectedMatch?.id]);

  const setActionStatus = useCallback((message: string, nextError: string | null = null) => {
    setStatus(message);
    setError(nextError);
  }, []);

  const loadConfig = useCallback(async () => {
    const nextConfig = await apiJson<ConfigResponse>("/api/config");
    setConfig(nextConfig);
    const nextModels = nextConfig.models ?? nextConfig.provider?.models ?? [];
    setSelectedModel((current) => {
      if (current && (!nextModels.length || nextModels.includes(current))) return current;
      const profileModel = nextConfig.defaultProfiles?.find((profile) => profile.model && (!nextModels.length || nextModels.includes(profile.model)))?.model;
      return profileModel ?? nextModels[0] ?? current;
    });
    return nextConfig;
  }, []);

  const refreshMatches = useCallback(async () => {
    const records = await apiJson<MatchRecord[]>("/api/matches");
    const ordered = [...records].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    setMatches(ordered);
    return ordered;
  }, []);

  const loadComparisonPair = useCallback(
    async (options: {
      baselineId: string;
      candidateId: string;
      view: ArtifactView;
      statusPrefix?: string;
    }) => {
      const { baselineId, candidateId, view, statusPrefix } = options;
      const requestSeq = comparisonLoadSeqRef.current + 1;
      comparisonLoadSeqRef.current = requestSeq;
      setBusy("compare");
      try {
        const [candidate, nextComparison] = await Promise.all([
          apiJson<ProjectedMatchArtifact>(
            `/api/matches/${encodeURIComponent(candidateId)}/artifact?view=${view}`
          ),
          apiJson<MatchComparisonArtifact>(
            `/api/matches/${encodeURIComponent(baselineId)}/compare/${encodeURIComponent(candidateId)}?view=${view}`
          )
        ]);
        if (requestSeq !== comparisonLoadSeqRef.current) {
          return false;
        }
        assertServerProjectedArtifact(candidate, "candidate artifact");
        assertArtifactMatchesId(candidate, candidateId, "candidate artifact");
        assertServerProjectedComparison(nextComparison);
        assertComparisonMatchesIds(nextComparison, baselineId, candidateId);
        setCandidateArtifact(candidate);
        setComparison(nextComparison);
        setComparisonRequestContext({
          comparisonId: nextComparison.comparisonId,
          baselineId,
          candidateId,
          view
        });
        setInspector(inspectorFromComparison(nextComparison));
        setActionStatus(
          `${statusPrefix ?? "对比工件已加载"}：${shortId(baselineId)} vs ${shortId(candidateId)} · view=${view} · rows=${nextComparison.rows.length} · socialΔ${nextComparison.summary.socialStepsDelta} · cΔ${nextComparison.summary.committedStepsDelta}/rΔ${nextComparison.summary.rejectedStepsDelta}`
        );
        try {
          const response = await apiJson<{ comparisons: ComparisonRegistrySummary[] }>(
            `/api/comparisons?view=${encodeURIComponent(view)}`
          );
          const entries = Array.isArray(response.comparisons) ? response.comparisons : [];
          setComparisonRegistry(entries);
          setSelectedComparisonId(nextComparison.comparisonId);
        } catch {
          // Registry refresh is best-effort; the just-loaded comparison remains authoritative.
        }
        return true;
      } catch (nextError) {
        if (requestSeq !== comparisonLoadSeqRef.current) {
          return false;
        }
        setActionStatus("对比工件加载失败", errorMessage(nextError));
        return false;
      } finally {
        if (requestSeq === comparisonLoadSeqRef.current) {
          setBusy(null);
        }
      }
    },
    [setActionStatus]
  );

  const loadArtifact = useCallback(
    async (match: MatchRecord, view: ArtifactView, comparisonCandidateId?: string) => {
      const requestSeq = artifactLoadSeqRef.current + 1;
      artifactLoadSeqRef.current = requestSeq;
      setBusy(`artifact:${match.id}`);
      try {
        const nextArtifact = await apiJson<ProjectedMatchArtifact>(`/api/matches/${encodeURIComponent(match.id)}/artifact?view=${view}`);
        if (requestSeq !== artifactLoadSeqRef.current) return;
        assertServerProjectedArtifact(nextArtifact, "match artifact");
        assertArtifactMatchesId(nextArtifact, match.id, "match artifact");
        setSelectedMatch(match);
        setArtifact(nextArtifact);
        setArtifactView(view);
        setReplay(null);
        replayFrameLoadSeqRef.current += 1;
        setReplayFrame(null);
        setReplayFrameCursorIndex(null);
        setReplayFrameLoadState("idle");
        setReplayFrameError(null);
        setComparison(null);
        setComparisonRequestContext(null);
        setCandidateArtifact(null);
        setCheckpoints([]);
        setSelectedCheckpointId("");
        setForkLineage(null);
        setBranchTree(null);
        const loadedStepCounts = countSocialStepCommits(nextArtifact.socialEpisode.steps);
        setSelectedStepIndex(clampIndex(loadedStepCounts.nativeSteps - 1, loadedStepCounts.nativeSteps));
        setSelectedAgentId(nextArtifact.agents[0]?.playerId ?? "");
        setInspector(inspectorFromArtifact(nextArtifact));
        setActionStatus(
          `已加载脱敏工件：${shortId(match.id)} · view=${view} · native=${loadedStepCounts.nativeSteps} · committed=${loadedStepCounts.committedSteps} · rejected=${loadedStepCounts.rejectedSteps} · legacy projection=${nextArtifact.trajectory.length}`
        );
        if (comparisonCandidateId && comparisonCandidateId !== match.id) {
          await loadComparisonPair({
            baselineId: match.id,
            candidateId: comparisonCandidateId,
            view,
            statusPrefix: "基准切换后对比已重载"
          });
        }
      } catch (nextError) {
        if (requestSeq === artifactLoadSeqRef.current) {
          setActionStatus("工件加载失败", errorMessage(nextError));
        }
      } finally {
        if (requestSeq === artifactLoadSeqRef.current) {
          setBusy(null);
        }
      }
    },
    [loadComparisonPair, setActionStatus]
  );

  const handleArtifactViewChange = useCallback(
    async (view: ArtifactView) => {
      if (!selectedMatch?.hasArtifact) {
        setArtifactView(view);
        setActionStatus(`投影模式已切换为 ${view}；加载工件后生效。`);
        return;
      }
      await loadArtifact(selectedMatch, view, candidateId);
    },
    [candidateId, loadArtifact, selectedMatch, setActionStatus]
  );

  const bootstrap = useCallback(async () => {
    setBusy("bootstrap");
    try {
      await loadConfig();
      const records = await refreshMatches();
      const preferredBaselineId = initialCompareSelection.baselineId;
      const preferredCandidateId = initialCompareSelection.candidateId;
      const preferredView = initialCompareSelection.view ?? "postgame-redacted";
      const preferredBaseline = preferredBaselineId
        ? records.find((match) => match.hasArtifact && match.id === preferredBaselineId)
        : undefined;
      const latest = preferredBaseline ?? records.find((match) => match.hasArtifact);
      if (latest) {
        // candidateId is already bootstrapped from the deep link when present.
        // loadArtifact auto-reloads the comparison pair for a selected candidate.
        await loadArtifact(latest, preferredView, preferredCandidateId);
      } else {
        setActionStatus("API 已连接，但当前没有可加载的 harness 工件。");
      }
      if (latest && preferredCandidateId && preferredCandidateId !== latest.id) {
        setWorkspace("compare");
      }
    } catch (nextError) {
      setActionStatus("初始化失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [
    initialCompareSelection.baselineId,
    initialCompareSelection.candidateId,
    initialCompareSelection.view,
    loadArtifact,
    loadConfig,
    refreshMatches,
    setActionStatus
  ]);

  useEffect(() => {
    if (bootstrapStartedRef.current) return;
    bootstrapStartedRef.current = true;
    void bootstrap();
  }, [bootstrap]);

  const handleRefresh = useCallback(async () => {
    setBusy("matches");
    try {
      const records = await refreshMatches();
      setActionStatus(`运行注册表已刷新：${records.length} 条`);
    } catch (nextError) {
      setActionStatus("运行注册表刷新失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [refreshMatches, setActionStatus]);

  const handleLoadLatest = useCallback(async () => {
    setBusy("latest");
    try {
      const records = await refreshMatches();
      const latest = records.find((match) => match.hasArtifact);
      if (!latest) {
        setActionStatus("没有可加载的 artifact-backed run。");
        return;
      }
      await loadArtifact(latest, "postgame-redacted", candidateId);
      setWorkspace("timeline");
    } catch (nextError) {
      setActionStatus("加载最近工件失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [candidateId, loadArtifact, refreshMatches, setActionStatus]);

  const handleRunExperiment = useCallback(async () => {
    if (!selectedModel) {
      setActionStatus("无法启动：没有可用模型", "请先确认 /api/config 返回模型列表。");
      return;
    }
    setBusy("run");
    setActionStatus("正在通过真实 API 启动 harness run...");
    try {
      const timeoutMs = parsePositiveInteger(timeoutSeconds, DEFAULT_TIMEOUT_SECONDS) * 1000;
      const transitions = parsePositiveInteger(maxTransitions, DEFAULT_MAX_TRANSITIONS);
      if (jointPhaseScheduler === "parallel" && transitions < WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS) {
        throw new Error(
          `parallel 联合阶段需要 maxTransitions >= ${WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS}（system.advance + seer.inspect + 双狼 joint batch）。`
        );
      }
      const sourceProfiles: Array<{ id: string; model?: string; temperature?: number; policyName?: string }> = config?.defaultProfiles?.length
        ? config.defaultProfiles.slice(0, 5)
        : [{ id: "research-agent-1" }, { id: "research-agent-2" }, { id: "research-agent-3" }];
      const profiles = sourceProfiles.map((profile, index) => ({
        ...profile,
        id: profile.id || `research-agent-${index + 1}`,
        model: selectedModel,
        temperature: profile.temperature ?? 0.7
      }));
      const record = await apiJson<MatchRecord>("/api/matches/run", {
        method: "POST",
        body: JSON.stringify({
          models: [selectedModel],
          profiles,
          assignment: { strategy: "profile-rotation" },
          seed: `ui-cockpit-${Date.now()}`,
          maxTransitions: transitions,
          timeoutMs,
          jointPhaseScheduler
        })
      });
      await refreshMatches();
      if (record.hasArtifact) {
        await loadArtifact(record, "postgame-redacted", candidateId);
        setWorkspace("timeline");
      }
      setActionStatus(
        `真实 harness run 完成：${shortId(record.id)} · artifact=${record.hasArtifact ? "yes" : "no"} · joint=${jointPhaseScheduler}`
      );
    } catch (nextError) {
      setActionStatus("真实 harness run 失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [candidateId, config?.defaultProfiles, jointPhaseScheduler, loadArtifact, maxTransitions, refreshMatches, selectedModel, setActionStatus, timeoutSeconds]);

  const handleReplay = useCallback(async () => {
    if (!currentMatchId) {
      setActionStatus("无法复现：尚未选择 run。");
      return;
    }
    if (artifactView !== "postgame-redacted") {
      setReplay(null);
      setActionStatus("原生复现仅在 postgame-redacted 本地研究复盘视图可用。");
      return;
    }
    setBusy("replay");
    try {
      const nextReplay = await apiJson<ReplayResponse>(`/api/matches/${encodeURIComponent(currentMatchId)}/replay`, {
        method: "POST",
        body: JSON.stringify({ stopOnMismatch: true })
      });
      setReplay(nextReplay);
      setInspector(inspectorFromReplay(nextReplay));
      const ok = Boolean(nextReplay.summary?.ok);
      setActionStatus(
        ok
          ? `原生复现通过：${nextReplay.summary?.replayedSteps ?? 0} steps / ${nextReplay.summary?.replayedBatches ?? 0} batches，state=${String(nextReplay.summary?.finalHashMatchesArtifact ?? nextReplay.summary?.finalHashMatchesExpected ?? false)}，messages=${String(nextReplay.summary?.messagesHashMatchesExpected ?? false)}`
          : `复现失败：mismatch=${nextReplay.summary?.mismatchCount ?? "unknown"}`,
        ok ? null : nextReplay.error ?? "replay validator reported mismatch"
      );
    } catch (nextError) {
      setActionStatus("复现请求失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [artifactView, currentMatchId, setActionStatus]);

  const handleLoadReplayFrame = useCallback(
    async (index: number) => {
      if (!artifact || !currentMatchId) {
        setActionStatus("无法定位回放帧：尚未选择带工件的 run。");
        return;
      }
      if (artifactView !== "postgame-redacted") {
        setActionStatus("原生步骤回放帧仅在 postgame-redacted 本地复盘视图可用。");
        return;
      }
      const step = artifact.socialEpisode.steps[index];
      if (!step) {
        setActionStatus("无法定位回放帧：原生步骤不存在。");
        return;
      }
      if (!isSafeHarnessCheckpointBoundary(artifact.socialEpisode.steps, index)) {
        setActionStatus("该步骤处于原子并行批次中间；只能在完整批次末尾定位服务端回放局面。");
        return;
      }
      const requestSeq = replayFrameLoadSeqRef.current + 1;
      replayFrameLoadSeqRef.current = requestSeq;
      setReplayFrame(null);
      setReplayFrameLoadState("loading");
      setReplayFrameError(null);
      setBusy("replay-frame");
      try {
        const response = await apiJson<ReplayFrameResponse>(`/api/matches/${encodeURIComponent(currentMatchId)}/replay/frame`, {
          method: "POST",
          body: JSON.stringify({ nativeStepCount: index + 1 })
        });
        if (requestSeq !== replayFrameLoadSeqRef.current) return;
        assertServerReplayFrame(response.frame, step, index + 1);
        setReplayFrame(response.frame);
        setReplayFrameCursorIndex(index);
        setReplayFrameLoadState("idle");
        setActionStatus(
          `已定位服务端回放帧：native #${index + 1} · state=${shortId(response.frame.cursor.stateHash)} · messages=${response.frame.cursor.messageCount}`
        );
      } catch (nextError) {
        if (requestSeq !== replayFrameLoadSeqRef.current) return;
        const message = errorMessage(nextError);
        setReplayFrameLoadState("error");
        setReplayFrameError(message);
        setActionStatus("服务端回放帧加载失败", message);
      } finally {
        if (requestSeq === replayFrameLoadSeqRef.current) setBusy(null);
      }
    },
    [artifact, artifactView, currentMatchId, setActionStatus]
  );

  const handleCandidateChange = useCallback(
    async (value: string) => {
      setCandidateId(value);
      setCandidateArtifact(null);
      setComparison(null);
      setComparisonRequestContext(null);
      const baselineId = selectedMatch?.id ?? artifact?.matchId ?? artifact?.runId;
      if (!baselineId || !value || value === baselineId) {
        setActionStatus(`候选运行已选择：${shortId(value)}`);
        return;
      }
      setActionStatus(`候选运行已选择：${shortId(value)}，正在自动加载对比…`);
      await loadComparisonPair({
        baselineId,
        candidateId: value,
        view: artifactView,
        statusPrefix: "候选切换后对比已加载"
      });
    },
    [artifact?.matchId, artifact?.runId, artifactView, loadComparisonPair, selectedMatch?.id, setActionStatus]
  );

  const handleLoadComparison = useCallback(async () => {
    const baselineId = selectedMatch?.id ?? artifact?.matchId ?? artifact?.runId;
    if (!baselineId || !candidateId) {
      setActionStatus("无法对比：需要基准 run 和候选 run。");
      return;
    }
    await loadComparisonPair({
      baselineId,
      candidateId,
      view: artifactView
    });
  }, [artifact?.matchId, artifact?.runId, artifactView, candidateId, loadComparisonPair, selectedMatch?.id, setActionStatus]);

  const refreshComparisonRegistry = useCallback(async () => {
    setBusy("comparison-registry");
    try {
      const baselineId = selectedMatch?.id ?? artifact?.matchId ?? artifact?.runId;
      const query = new URLSearchParams();
      query.set("view", artifactView);
      if (baselineId) query.set("baselineId", baselineId);
      if (candidateId) query.set("candidateId", candidateId);
      const path = query.size > 0 ? `/api/comparisons?${query.toString()}` : "/api/comparisons";
      const response = await apiJson<{ comparisons: ComparisonRegistrySummary[] }>(path);
      const entries = Array.isArray(response.comparisons) ? response.comparisons : [];
      setComparisonRegistry(entries);
      setSelectedComparisonId((current) =>
        current && entries.some((entry) => entry.comparisonId === current)
          ? current
          : entries[0]?.comparisonId ?? ""
      );
      setActionStatus(`对比注册表已刷新：${entries.length} 条`);
    } catch (nextError) {
      setActionStatus("对比注册表刷新失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [artifact?.matchId, artifact?.runId, artifactView, candidateId, selectedMatch?.id, setActionStatus]);

  const loadSavedComparisonById = useCallback(
    async (
      comparisonId: string,
      options?: { switchToCompareWorkspace?: boolean; preserveInspector?: boolean }
    ): Promise<boolean> => {
      if (!comparisonId) {
        setActionStatus("无法加载已保存对比：请先选择 comparisonId。");
        return false;
      }
      const requestSeq = comparisonLoadSeqRef.current + 1;
      comparisonLoadSeqRef.current = requestSeq;
      setBusy("comparison-registry-load");
      try {
        const nextComparison = await apiJson<MatchComparisonArtifact>(
          `/api/comparisons/${encodeURIComponent(comparisonId)}?view=${encodeURIComponent(artifactView)}`
        );
        if (requestSeq !== comparisonLoadSeqRef.current) {
          return false;
        }
        assertServerProjectedComparison(nextComparison);
        setSelectedComparisonId(comparisonId);
        const nextView =
          nextComparison.view === "truth-redacted" || nextComparison.view === "postgame-redacted"
            ? nextComparison.view
            : artifactView;
        const nextCandidateId = nextComparison.candidate.matchId ?? nextComparison.candidate.runId;
        const nextBaselineId = nextComparison.baseline.matchId ?? nextComparison.baseline.runId;
        let candidateHydrated = false;
        let baselineHydrated = false;

        if (nextCandidateId) {
          setCandidateId(nextCandidateId);
          try {
            const candidate = await apiJson<ProjectedMatchArtifact>(
              `/api/matches/${encodeURIComponent(nextCandidateId)}/artifact?view=${nextView}`
            );
            if (requestSeq !== comparisonLoadSeqRef.current) {
              return false;
            }
            assertServerProjectedArtifact(candidate, "candidate artifact");
            assertArtifactMatchesId(candidate, nextCandidateId, "candidate artifact");
            setCandidateArtifact(candidate);
            candidateHydrated = true;
          } catch {
            // Comparison matrix can still render from the server comparison artifact.
          }
        }

        if (nextBaselineId) {
          try {
            const baselineMatch = matches.find((match) => match.id === nextBaselineId);
            if (baselineMatch?.hasArtifact) {
              await loadArtifact(baselineMatch, nextView, nextCandidateId);
              if (requestSeq !== comparisonLoadSeqRef.current) {
                return false;
              }
              baselineHydrated = true;
            } else {
              const baseline = await apiJson<ProjectedMatchArtifact>(
                `/api/matches/${encodeURIComponent(nextBaselineId)}/artifact?view=${nextView}`
              );
              if (requestSeq !== comparisonLoadSeqRef.current) {
                return false;
              }
              assertServerProjectedArtifact(baseline, "baseline artifact");
              assertArtifactMatchesId(baseline, nextBaselineId, "baseline artifact");
              setArtifact(baseline);
              setArtifactView(nextView);
              try {
                const listed = await apiJson<MatchRecord[]>("/api/matches");
                if (requestSeq !== comparisonLoadSeqRef.current) {
                  return false;
                }
                if (Array.isArray(listed)) {
                  setMatches(listed);
                  const listedBaseline = listed.find((match) => match.id === nextBaselineId);
                  if (listedBaseline) setSelectedMatch(listedBaseline);
                }
              } catch {
                // Artifact hydration already succeeded.
              }
              baselineHydrated = true;
            }
          } catch {
            if (requestSeq === comparisonLoadSeqRef.current && nextView !== artifactView) {
              setArtifactView(nextView);
            }
          }
        } else if (requestSeq === comparisonLoadSeqRef.current && nextView !== artifactView) {
          setArtifactView(nextView);
        }

        if (requestSeq !== comparisonLoadSeqRef.current) {
          return false;
        }

        setComparison(nextComparison);
        setComparisonRequestContext(
          nextBaselineId && nextCandidateId
            ? {
                comparisonId: nextComparison.comparisonId,
                baselineId: nextBaselineId,
                candidateId: nextCandidateId,
                view: nextView
              }
            : null
        );
        // Preserve an existing aggregate inspector (e.g. tournament comparison with pair
        // actions) when the caller is auto-loading a pair matrix as a side effect.
        if (!options?.preserveInspector) {
          setInspector(inspectorFromComparison(nextComparison));
        }
        if (options?.switchToCompareWorkspace) setWorkspace("compare");
        setActionStatus(
          `已加载注册表对比：${shortId(nextComparison.comparisonId)} · view=${nextComparison.view} · rows=${nextComparison.rows.length}` +
            ` · socialΔ${nextComparison.summary.socialStepsDelta} · cΔ${nextComparison.summary.committedStepsDelta}/rΔ${nextComparison.summary.rejectedStepsDelta}` +
            ` · baseline=${baselineHydrated ? "hydrated" : "summary-only"}` +
            ` · candidate=${candidateHydrated ? "hydrated" : "summary-only"}`
        );
        return true;
      } catch (nextError) {
        if (requestSeq !== comparisonLoadSeqRef.current) {
          return false;
        }
        setActionStatus("注册表对比加载失败", errorMessage(nextError));
        return false;
      } finally {
        if (requestSeq === comparisonLoadSeqRef.current) {
          setBusy(null);
        }
      }
    },
    [artifactView, loadArtifact, matches, setActionStatus]
  );

  const handleLoadSavedComparison = useCallback(async () => {
    await loadSavedComparisonById(selectedComparisonId);
  }, [loadSavedComparisonById, selectedComparisonId]);


  const handleDownloadComparison = useCallback(
    async (format: "json" | "markdown") => {
      const baselineId = selectedMatch?.id ?? artifact?.matchId ?? artifact?.runId;
      if (!baselineId || !candidateId) {
        setActionStatus("无法导出对比：需要基准 run 和候选 run。");
        return;
      }
      if (
        !isComparisonCurrentForRoute({
          comparison,
          context: comparisonRequestContext,
          baselineId,
          candidateId,
          view: artifactView
        })
      ) {
        setActionStatus("无法导出对比：当前对比工件与基准/候选/view 不一致，请先加载/重载。");
        return;
      }
      const target =
        `/api/matches/${encodeURIComponent(baselineId)}/compare/${encodeURIComponent(candidateId)}` +
        `?view=${artifactView}&format=${format}&download=1`;
      setBusy(format === "markdown" ? "download-compare-md" : "download-compare-json");
      try {
        const response = await fetch(target);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        const extension = format === "markdown" ? "md" : "json";
        anchor.download = `${shortId(baselineId)}-vs-${shortId(candidateId)}-comparison.${extension}`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        setActionStatus(
          `对比工件已从服务端导出：${shortId(baselineId)} vs ${shortId(candidateId)} · format=${format} · view=${artifactView}`
        );
      } catch (nextError) {
        setActionStatus("对比工件导出失败", errorMessage(nextError));
      } finally {
        setBusy(null);
      }
    },
    [artifact?.matchId, artifact?.runId, artifactView, candidateId, comparison, comparisonRequestContext, selectedMatch?.id, setActionStatus]
  );

  const handleDownloadFilteredComparison = useCallback(
    async (
      format: "json" | "markdown",
      filter: {
        group: "all" | MatchComparisonRowGroup;
        changedOnly: boolean;
        promotion: MatchComparisonPromotionFilter;
        evidenceIdentity: MatchComparisonEvidenceIdentityFilter;
        numericDelta: MatchComparisonNumericDeltaFilter;
      }
    ) => {
      const baselineId = selectedMatch?.id ?? artifact?.matchId ?? artifact?.runId;
      if (!baselineId || !candidateId) {
        setActionStatus("无法导出过滤对比：需要基准 run 和候选 run。");
        return;
      }
      if (
        !isComparisonCurrentForRoute({
          comparison,
          context: comparisonRequestContext,
          baselineId,
          candidateId,
          view: artifactView
        })
      ) {
        setActionStatus("无法导出过滤对比：当前对比工件与基准/候选/view 不一致，请先加载/重载。");
        return;
      }
      const params = new URLSearchParams({
        view: artifactView,
        format,
        download: "1",
        filtered: "1",
        group: filter.group,
        changedOnly: filter.changedOnly ? "1" : "0",
        promotion: filter.promotion,
        evidenceIdentity: filter.evidenceIdentity,
        numericDelta: filter.numericDelta
      });
      const target =
        `/api/matches/${encodeURIComponent(baselineId)}/compare/${encodeURIComponent(candidateId)}?` +
        params.toString();
      setBusy(format === "markdown" ? "download-compare-filtered-md" : "download-compare-filtered-json");
      try {
        const response = await fetch(target);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        const extension = format === "markdown" ? "md" : "json";
        anchor.download = `${shortId(baselineId)}-vs-${shortId(candidateId)}-comparison-filtered.${extension}`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        setActionStatus(
          `过滤对比投影已从服务端导出：${shortId(baselineId)} vs ${shortId(candidateId)} · format=${format} · view=${artifactView} · filter=${filter.group}/${filter.promotion}/${filter.evidenceIdentity}/${filter.numericDelta}${filter.changedOnly ? "/changedOnly" : ""}`
        );
      } catch (nextError) {
        setActionStatus("过滤对比投影导出失败", errorMessage(nextError));
      } finally {
        setBusy(null);
      }
    },
    [artifact?.matchId, artifact?.runId, artifactView, candidateId, comparison, comparisonRequestContext, selectedMatch?.id, setActionStatus]
  );

  const handleRefreshMatrixArtifacts = useCallback(async () => {
    setBusy("matrix-artifacts");
    try {
      const response = await apiJson<{ artifactSets: ExperimentMatrixArtifactSetSummary[] }>("/api/experiments/matrix/artifacts");
      const sets = response.artifactSets ?? [];
      setMatrixArtifactSets(sets);
      setActionStatus(`实验矩阵研究工件已刷新：${sets.length} 套`);
    } catch (nextError) {
      setActionStatus("实验矩阵研究工件刷新失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [setActionStatus]);

  const handleRunMatrixExperiment = useCallback(async () => {
    if (!selectedModel) {
      setActionStatus("无法运行实验矩阵：没有可用模型", "请先确认 /api/config 返回模型列表。");
      return;
    }
    setBusy("matrix-run");
    setActionStatus("正在通过 harness control plane 运行实验矩阵...");
    try {
      const games = Math.min(10, Math.max(1, parsePositiveInteger(matrixGames, 1)));
      const transitions = parsePositiveInteger(maxTransitions, DEFAULT_MAX_TRANSITIONS);
      const timeoutMs = parsePositiveInteger(timeoutSeconds, DEFAULT_TIMEOUT_SECONDS) * 1000;
      const matrixId = `ui-matrix-${Date.now()}`;
      const exportArtifacts = matrixExportArtifacts && Boolean(config?.artifactExport?.matrixConfigured);
      const response = await apiJson<ExperimentMatrixRunResponse>("/api/experiments/matrix/run", {
        method: "POST",
        body: JSON.stringify({
          version: "harness.experiment-matrix.v1",
          kind: "matrix",
          id: matrixId,
          continueOnError: true,
          base: {
            models: [selectedModel],
            games,
            seed: matrixId,
            maxTransitions: transitions,
            timeout: timeoutMs,
            continueOnError: true
          },
          cells: [
            {
              id: `${matrixId}-selected-model`,
              label: selectedModel,
              group: "cockpit-selected-model",
              models: [selectedModel]
            }
          ],
          exportArtifacts
        })
      });
      setMatrixResult(response);
      const artifactSet = response.artifacts ?? response.summary?.artifacts ?? null;
      if (artifactSet) {
        setMatrixArtifactSets((current) => [artifactSet, ...current.filter((item) => item.artifactSetId !== artifactSet.artifactSetId)]);
      }
      const summary = response.summary;
      setActionStatus(
        `实验矩阵完成：${summary?.matrixId ?? matrixId} · completed=${summary?.gamesCompleted ?? 0} · truncated=${summary?.gamesTruncated ?? 0} · failed=${summary?.gamesFailed ?? 0}`,
        summary?.failureReason ?? response.error ?? null
      );
    } catch (nextError) {
      setActionStatus("实验矩阵运行失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [config?.artifactExport?.matrixConfigured, matrixExportArtifacts, matrixGames, maxTransitions, selectedModel, setActionStatus, timeoutSeconds]);

  const handleRefreshTournamentPacks = useCallback(async () => {
    setBusy("packs");
    try {
      const response = await apiJson<{ artifactSets: TournamentArtifactSetSummary[] }>("/api/tournament-artifacts");
      const packs = response.artifactSets ?? [];
      setTournamentPacks(packs);
      setSelectedPackId((current) => (current && packs.some((pack) => pack.artifactSetId === current) ? current : packs[0]?.artifactSetId ?? ""));
      setActionStatus(`锦标赛公开包已刷新：${packs.length} 套`);
    } catch (nextError) {
      setActionStatus("锦标赛公开包刷新失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [setActionStatus]);

  const handleRefreshShareInventory = useCallback(async () => {
    setBusy("share-inventory");
    try {
      const inventory = await apiJson<TournamentPublicShareInventory>("/api/tournament-public-shares");
      setShareInventory(inventory);
      const promotionLabel = formatPackMetricPromotion({
        metricCount: inventory.metricCount,
        scorecardEligibleMetricCount: inventory.scorecardEligibleMetricCount,
        metricPromotionClassCounts: inventory.metricPromotionClassCounts
      });
      const densityLabel = formatPackCommitDensity({
        nativeSteps: inventory.nativeSteps,
        committedSteps: inventory.committedSteps,
        rejectedSteps: inventory.rejectedSteps
      });
      setActionStatus(
        `分享清单已刷新：total=${inventory.count} · active=${inventory.activeCount} · expired=${inventory.expiredCount} · packsWithPromotion=${inventory.packsWithPromotionCount ?? 0} · packsWithDensity=${inventory.packsWithDensityCount ?? 0}${promotionLabel === "n/a" ? "" : ` · promotion=${promotionLabel}`}${densityLabel === "n/a" ? "" : ` · density=${densityLabel}`}`
      );
    } catch (nextError) {
      setActionStatus("分享清单刷新失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [setActionStatus]);

  const handleDownloadShareAnalyticsSummary = useCallback(
    async (format: "json" | "markdown") => {
      setBusy("share-summary");
      try {
        const target = `/api/tournament-public-shares/summary?format=${format}`;
        const response = await fetch(target);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download =
          format === "markdown" ? "tournament-public-share-analytics.md" : "tournament-public-share-analytics.json";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        setActionStatus(`分享分析摘要已导出：format=${format}`);
      } catch (nextError) {
        setActionStatus("分享分析摘要导出失败", errorMessage(nextError));
      } finally {
        setBusy(null);
      }
    },
    [setActionStatus]
  );

  const handleExportTournamentPack = useCallback(async () => {
    if (!selectedModel) {
      setActionStatus("无法导出锦标赛公开包：没有可用模型", "请先确认 /api/config 返回模型列表。");
      return;
    }
    setBusy("pack-export");
    setActionStatus("正在运行锦标赛并导出 truth-redacted 公开包...");
    try {
      const timeoutMs = parsePositiveInteger(timeoutSeconds, DEFAULT_TIMEOUT_SECONDS) * 1000;
      const transitions = parsePositiveInteger(maxTransitions, DEFAULT_MAX_TRANSITIONS);
      const games = Math.min(10, Math.max(1, parsePositiveInteger(packGames, 1)));
      const sourceProfiles: Array<{ id: string; model?: string; temperature?: number; policyName?: string }> = config?.defaultProfiles?.length
        ? config.defaultProfiles.slice(0, 5)
        : [{ id: "research-agent-1" }, { id: "research-agent-2" }, { id: "research-agent-3" }];
      const profiles = sourceProfiles.map((profile, index) => ({
        ...profile,
        id: profile.id || `research-agent-${index + 1}`,
        model: selectedModel,
        temperature: profile.temperature ?? 0.7
      }));
      const response = await apiJson<TournamentRunResponse>("/api/tournaments/run", {
        method: "POST",
        body: JSON.stringify({
          models: [selectedModel],
          profiles,
          assignment: { strategy: "profile-rotation" },
          seed: `ui-pack-${Date.now()}`,
          games,
          maxTransitions: transitions,
          timeoutMs,
          exportArtifacts: true
        })
      });
      const pack = response.artifacts ?? response.summary?.artifacts ?? null;
      if (!pack?.artifactSetId) {
        throw new Error(response.error ?? response.summary?.failureReason ?? "tournament export returned no artifact set");
      }
      const degradedNotes: string[] = [];
      let packs: TournamentArtifactSetSummary[] = [pack];
      try {
        const listed = await apiJson<{ artifactSets: TournamentArtifactSetSummary[] }>("/api/tournament-artifacts");
        const merged = mergeExportedTournamentPackList({
          exportedPack: pack,
          listedPacks: listed.artifactSets ?? []
        });
        packs = merged.packs;
        if (merged.note !== "ok") {
          degradedNotes.push(merged.note);
        }
      } catch {
        // Pack export already succeeded; list refresh is best-effort.
        const merged = mergeExportedTournamentPackList({
          exportedPack: pack,
          listRefreshFailed: true
        });
        packs = merged.packs;
        degradedNotes.push(merged.note);
      }
      setTournamentPacks(packs);
      setSelectedPackId(pack.artifactSetId);
      const available = flattenTournamentPackFiles(pack.files);
      const preferred = DEFAULT_SHARE_ALLOWLIST.filter((file) => available.includes(file));
      setShareAllowlist(preferred.length ? preferred : available.slice(0, Math.min(8, available.length)));
      try {
        const sharesResponse = await apiJson<{ artifactSetId: string; shares: TournamentPublicShareSummary[] }>(
          `/api/tournament-artifacts/${encodeURIComponent(pack.artifactSetId)}/shares`
        );
        setPackShares(sharesResponse.shares ?? []);
      } catch {
        // Pack export already succeeded; share inventory refresh is best-effort.
        setPackShares([]);
        degradedNotes.push("share-refresh-degraded");
      }
      let registeredMatchCount = 0;
      let packMatchIds = new Set<string>();
      try {
        const matchRecords = await refreshMatches();
        registeredMatchCount = matchRecords.filter((match) => match.hasArtifact).length;
      } catch {
        // Pack export already succeeded; match registry refresh is best-effort.
        degradedNotes.push("match-refresh-degraded");
      }
      // Episode ids from the just-finished tournament run. Prefer these over a
      // global newest comparison, which may belong to an older pack.
      for (const episode of response.episodes ?? []) {
        if (typeof episode.matchId === "string" && episode.matchId) packMatchIds.add(episode.matchId);
        if (typeof episode.runId === "string" && episode.runId) packMatchIds.add(episode.runId);
      }
      let autoLoadComparisonId = "";
      let seededComparisonSource: ResolvePackSeededComparisonSource =
        packMatchIds.size >= 2 ? "missing" : "none";
      try {
        // Keep the full comparison registry for the compare workspace UI.
        // Pack-scoped matchIds filtering is used only to select the export pair.
        // Fetch both lists in parallel, but isolate failures so a pack-scoped
        // filter error cannot wipe the full registry refresh.
        const fullRegistryPromise = apiJson<{ comparisons: ComparisonRegistrySummary[] }>("/api/comparisons").then(
          (response) => ({ ok: true as const, response }),
          () => ({ ok: false as const, response: null })
        );
        const packScopedPromise =
          packMatchIds.size >= 2
            ? apiJson<{ comparisons: ComparisonRegistrySummary[] }>(
                `/api/comparisons?matchIds=${encodeURIComponent(Array.from(packMatchIds).join(","))}`
              ).then(
                (response) => ({ ok: true as const, response }),
                () => ({ ok: false as const, response: null })
              )
            : Promise.resolve({ ok: false as const, response: null });
        const [fullResult, packScopedResult] = await Promise.all([fullRegistryPromise, packScopedPromise]);

        const fullEntries =
          fullResult.ok && Array.isArray(fullResult.response?.comparisons)
            ? fullResult.response.comparisons
            : [];
        if (fullResult.ok) {
          setComparisonRegistry(fullEntries);
        } else {
          degradedNotes.push("comparison-registry-refresh-degraded");
        }

        const selection = resolvePackSeededComparisonSelection({
          packMatchIds,
          packScopedEntries: packScopedResult.ok ? packScopedResult.response?.comparisons ?? [] : null,
          packScopedRefreshOk: packScopedResult.ok,
          fullEntries
        });
        autoLoadComparisonId = selection.comparisonId;
        seededComparisonSource = selection.source;
        for (const note of selection.degradedNotes) {
          degradedNotes.push(note);
        }
        setSelectedComparisonId(autoLoadComparisonId);
      } catch {
        // Pack export already succeeded; comparison registry refresh is best-effort.
        degradedNotes.push("comparison-refresh-degraded");
      }
      setWorkspace("packs");
      setInspector({
        kind: "tournament-artifact-set",
        title: `Pack ${shortId(pack.artifactSetId)}`,
        subtitle: pack.seed,
        fields: [
          ["artifactSetId", pack.artifactSetId],
          ["seed", pack.seed],
          ["experimentId", pack.experimentId],
          ["publicShareSafe", String(Boolean(pack.projection?.publicShareSafe))],
          ["matchArtifactView", pack.projection?.matchArtifactView ?? "n/a"],
          ["density", formatPackCommitDensity(pack)],
          [
            "runSummaryDensity",
            formatPackCommitDensity({
              nativeSteps: response.summary?.nativeSteps,
              committedSteps: response.summary?.committedSteps,
              rejectedSteps: response.summary?.rejectedSteps
            })
          ],
          [
            "evaluationDensity",
            formatPackCommitDensity({
              nativeSteps: response.summary?.evaluation?.nativeSteps,
              committedSteps: response.summary?.evaluation?.committedSteps,
              rejectedSteps: response.summary?.evaluation?.rejectedSteps
            })
          ],
          [
            "evaluationPromotion",
            formatPackMetricPromotion({
              metricCount: response.summary?.evaluation?.metricCount,
              scorecardEligibleMetricCount: response.summary?.evaluation?.scorecardEligibleMetricCount,
              metricPromotionClassCounts: response.summary?.evaluation?.metricPromotionClassCounts
            })
          ],
          [
            "evaluationReportsPromotion",
            formatPackMetricPromotion({
              metricCount: response.summary?.evaluationReports?.metricCount,
              scorecardEligibleMetricCount: response.summary?.evaluationReports?.scorecardEligibleMetricCount,
              metricPromotionClassCounts: response.summary?.evaluationReports?.metricPromotionClassCounts
            })
          ],
          ["evaluationModelRewards", formatModelRewardDensity(response.summary?.evaluation?.modelRewards)],
          ["metricCount", typeof pack.metricCount === "number" ? pack.metricCount : "n/a"],
          [
            "scorecardEligibleMetrics",
            typeof pack.scorecardEligibleMetricCount === "number" ? pack.scorecardEligibleMetricCount : "n/a"
          ],
          ["metricPromotion", formatPackMetricPromotion(pack)],
          ["artifactBackedMatches", registeredMatchCount],
          ["packEpisodeIds", packMatchIds.size],
          ["seededComparisons", seededComparisonSource],
          ["seededComparisonId", autoLoadComparisonId || "none"],
          ["postExportRefresh", degradedNotes.length ? degradedNotes.join(",") : "ok"]
        ],
        json: pack
      });
      const degradedSuffix = degradedNotes.length ? ` · ${degradedNotes.join(" · ")}` : "";
      const selectionSuffix =
        seededComparisonSource === "none"
          ? ""
          : ` · selection=${seededComparisonSource}${autoLoadComparisonId ? `:${shortId(autoLoadComparisonId)}` : ""}`;
      const summaryDensity = formatPackCommitDensity({
        nativeSteps: response.summary?.nativeSteps,
        committedSteps: response.summary?.committedSteps,
        rejectedSteps: response.summary?.rejectedSteps
      });
      const densityLabel =
        summaryDensity !== "n/a" ? summaryDensity : formatPackCommitDensity(pack);
      const densitySuffix = densityLabel === "n/a" ? "" : ` · density=${densityLabel}`;
      const evaluationPromotionLabel = formatPackMetricPromotion({
        metricCount: response.summary?.evaluation?.metricCount,
        scorecardEligibleMetricCount: response.summary?.evaluation?.scorecardEligibleMetricCount,
        metricPromotionClassCounts: response.summary?.evaluation?.metricPromotionClassCounts
      });
      const packPromotionLabel = formatPackMetricPromotion(pack);
      const promotionLabel =
        evaluationPromotionLabel !== "n/a" ? evaluationPromotionLabel : packPromotionLabel;
      const promotionSuffix = promotionLabel === "n/a" ? "" : ` · promotion=${promotionLabel}`;
      const exportStatusBase =
        `锦标赛公开包已导出：${shortId(pack.artifactSetId)} · publicShareSafe=${String(Boolean(pack.projection?.publicShareSafe))} · completed=${response.summary?.gamesCompleted ?? "?"} · truncated=${response.summary?.gamesTruncated ?? "?"} · matches=${registeredMatchCount}${densitySuffix}${promotionSuffix}${selectionSuffix}${degradedSuffix}`;
      setActionStatus(
        exportStatusBase +
          (packMatchIds.size >= 2
            ? " · opening tournament comparison"
            : autoLoadComparisonId
              ? ` · loading pack comparison ${shortId(autoLoadComparisonId)}`
              : "")
      );
      // Multi-episode packs seed pairwise comparisons and emit tournament_comparison.json.
      // Prefer the aggregate inspect path so operators get pair navigation, loading busy
      // state, and active-pair highlighting instead of only a single pairwise matrix.
      // If aggregate inspect fails, fall back to the pack-scoped pairwise matrix.
      // Prefer the just-exported pack object; fall back to the refreshed list entry.
      const listedPack =
        packs.find((entry) => entry.artifactSetId === pack.artifactSetId) ?? pack;
      let openedAggregate = false;
      if (packMatchIds.size >= 2) {
        try {
          openedAggregate = await inspectTournamentComparisonRef.current(listedPack);
        } catch {
          openedAggregate = false;
        }
      }
      if (openedAggregate) {
        // Inspect/pair-load status overwrote the export banner; restore export provenance.
        setActionStatus(`${exportStatusBase} · tournament comparison opened`);
      } else if (autoLoadComparisonId) {
        setActionStatus(
          `${exportStatusBase} · aggregate inspect unavailable · loading pack comparison ${shortId(autoLoadComparisonId)}`
        );
        const loadedPairwise = await loadSavedComparisonById(autoLoadComparisonId, {
          switchToCompareWorkspace: true,
          preserveInspector: true
        });
        setActionStatus(
          loadedPairwise
            ? `${exportStatusBase} · aggregate inspect unavailable · pack comparison loaded ${shortId(autoLoadComparisonId)}`
            : `${exportStatusBase} · aggregate inspect unavailable · pack comparison load failed`
        );
      } else if (packMatchIds.size >= 2) {
        setActionStatus(`${exportStatusBase} · tournament comparison inspect unavailable`);
      }
    } catch (nextError) {
      setActionStatus("锦标赛公开包导出失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [config?.defaultProfiles, loadSavedComparisonById, maxTransitions, packGames, refreshMatches, selectedModel, setActionStatus, timeoutSeconds]);

  const handleSelectTournamentPack = useCallback(
    async (pack: TournamentArtifactSetSummary) => {
      setSelectedPackId(pack.artifactSetId);
      const available = flattenTournamentPackFiles(pack.files);
      const preferred = DEFAULT_SHARE_ALLOWLIST.filter((file) => available.includes(file));
      setShareAllowlist(preferred.length ? preferred : available.slice(0, Math.min(8, available.length)));
      setBusy("pack-shares");
      try {
        const response = await apiJson<{ artifactSetId: string; shares: TournamentPublicShareSummary[] }>(
          `/api/tournament-artifacts/${encodeURIComponent(pack.artifactSetId)}/shares`
        );
        setPackShares(response.shares ?? []);
        setActionStatus(
          `已选择公开包：${shortId(pack.artifactSetId)} · publicShareSafe=${String(Boolean(pack.projection?.publicShareSafe))} · density=${formatPackCommitDensity(pack)} · promotion=${formatPackMetricPromotion(pack)} · shares=${response.shares?.length ?? 0}`
        );
      } catch (nextError) {
        setPackShares([]);
        setActionStatus("公开包分享列表加载失败", errorMessage(nextError));
      } finally {
        setBusy(null);
      }
    },
    [setActionStatus]
  );

  const handleInspectTournamentComparison = useCallback(
    async (pack: TournamentArtifactSetSummary): Promise<boolean> => {
      const files = tournamentPackAggregateFiles(pack);
      const comparisonFile = files.find((file) => file.file === "tournament_comparison.json");
      if (!comparisonFile?.href) {
        setActionStatus("无法检视 tournament comparison：当前包未注册 tournament_comparison.json。");
        return false;
      }
      setBusy("pack-comparison");
      try {
        const response = await apiJson<TournamentComparisonAggregateView>(comparisonFile.href);
        if (response.kind !== "tournament-comparison") {
          throw new Error("tournament comparison artifact kind mismatch");
        }
        if (response.artifactVersion !== "harness.tournament-comparison.v1") {
          throw new Error(`unexpected tournament comparison version: ${response.artifactVersion}`);
        }
        const renderAggregateInspector = (options: {
          activeComparisonId: string | null;
          loadingComparisonId?: string | null;
        }) => {
          const activeComparisonId = options.activeComparisonId;
          const loadingComparisonId = options.loadingComparisonId ?? null;
          const pairActions = response.pairs.slice(0, 8).map((pair) => ({
            key: pair.comparisonId,
            label:
              pair.comparisonId === loadingComparisonId
                ? `加载中 e${pair.baseline.episodeIndex}→e${pair.candidate.episodeIndex}`
                : pair.comparisonId === activeComparisonId
                  ? `当前 pair e${pair.baseline.episodeIndex}→e${pair.candidate.episodeIndex}${
                      typeof pair.committedStepsDelta === "number" && typeof pair.rejectedStepsDelta === "number"
                        ? ` cΔ${pair.committedStepsDelta}/rΔ${pair.rejectedStepsDelta}`
                        : ""
                    }`
                  : `加载 pair e${pair.baseline.episodeIndex}→e${pair.candidate.episodeIndex}${
                      typeof pair.committedStepsDelta === "number" && typeof pair.rejectedStepsDelta === "number"
                        ? ` cΔ${pair.committedStepsDelta}/rΔ${pair.rejectedStepsDelta}`
                        : ""
                    }`,
            // While a pair load is in flight, freeze all pair actions so concurrent clicks
            // cannot start overlapping loads even though the race guard would drop them.
            disabled: Boolean(loadingComparisonId) || pair.comparisonId === activeComparisonId,
            onClick: () => {
              void (async () => {
                renderAggregateInspector({
                  activeComparisonId,
                  loadingComparisonId: pair.comparisonId
                });
                const loaded = await loadSavedComparisonById(pair.comparisonId, {
                  switchToCompareWorkspace: true,
                  preserveInspector: true
                });
                // Only mark a pair current after the comparison matrix load succeeds.
                renderAggregateInspector({
                  activeComparisonId: loaded ? pair.comparisonId : activeComparisonId
                });
              })();
            }
          }));
          setInspector(
            inspectorFromTournamentComparison(response, pack, pairActions, {
              activeComparisonId
            })
          );
        };
        const firstPairId = response.pairs[0]?.comparisonId ?? "";
        // Render actions first without claiming an active pair until load succeeds.
        renderAggregateInspector({
          activeComparisonId: null,
          loadingComparisonId: firstPairId || null
        });
        setActionStatus(
          `已加载 tournament comparison：${shortId(response.comparisonSetId)} · pairs=${response.pairCount} · matches=${response.artifactMatchCount}` +
            (typeof response.summary.totalSocialStepsDelta === "number"
              ? ` · socialΔ${response.summary.totalSocialStepsDelta}`
              : "") +
            (typeof response.summary.totalCommittedStepsDelta === "number" &&
            typeof response.summary.totalRejectedStepsDelta === "number"
              ? ` · cΔ${response.summary.totalCommittedStepsDelta}/rΔ${response.summary.totalRejectedStepsDelta}`
              : "") +
            (firstPairId ? ` · loading first pair ${shortId(firstPairId)}` : "")
        );
        // Multi-episode packs expose pair comparison ids in the aggregate artifact.
        // Auto-load the first pair matrix into the compare workspace while keeping the
        // aggregate inspector (and remaining pair actions) intact.
        if (firstPairId) {
          const loaded = await loadSavedComparisonById(firstPairId, {
            switchToCompareWorkspace: true,
            preserveInspector: true
          });
          renderAggregateInspector({
            activeComparisonId: loaded ? firstPairId : null
          });
          return true;
        }
        renderAggregateInspector({ activeComparisonId: null });
        // Aggregate with zero pairs is still a successful inspect of the pack artifact.
        return true;
      } catch (nextError) {
        setActionStatus("tournament comparison 加载失败", errorMessage(nextError));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [loadSavedComparisonById, setActionStatus]
  );
  inspectTournamentComparisonRef.current = handleInspectTournamentComparison;


  const handleCreateTournamentShare = useCallback(async () => {
    if (!selectedPackId) {
      setActionStatus("无法创建分享链接：尚未选择公开包。");
      return;
    }
    setBusy("share-create");
    try {
      const hours = shareExpiresInHours.trim() === "" ? 0 : parsePositiveInteger(shareExpiresInHours, 0);
      const expiresAt =
        hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null;
      const relativeFiles = shareAllowlist.length ? [...shareAllowlist] : undefined;
      const share = await apiJson<TournamentPublicShareSummary>(
        `/api/tournament-artifacts/${encodeURIComponent(selectedPackId)}/shares`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            label: shareLabel.trim() || undefined,
            expiresAt,
            relativeFiles
          })
        }
      );
      setPackShares((current) => [share, ...current.filter((item) => item.shareId !== share.shareId)]);
      setInspector({
        kind: "tournament-public-share",
        title: `Share ${shortId(share.shareId)}`,
        subtitle: share.label ?? share.artifactSetId,
        fields: [
          ["shareId", share.shareId],
          ["artifactSetId", share.artifactSetId],
          ["expiresAt", share.expiresAt ?? "never"],
          ["relativeFiles", relativeFiles?.join(", ") ?? "all registered files"],
          ["publicShareSafe", String(Boolean(share.projection?.publicShareSafe))],
          ["detail", share.urls?.detail ?? "n/a"],
          ["filesBase", share.urls?.filesBase ?? "n/a"]
        ],
        json: share
      });
      setActionStatus(
        `公开分享链接已创建：${shortId(share.shareId)} · expires=${share.expiresAt ? formatDate(share.expiresAt) : "never"} · files=${relativeFiles?.length ?? "all"}`
      );
    } catch (nextError) {
      setActionStatus("公开分享链接创建失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [selectedPackId, setActionStatus, shareAllowlist, shareExpiresInHours, shareLabel]);

  const handleCopyShareUrl = useCallback(
    async (share: TournamentPublicShareSummary) => {
      const detailPath = share.urls?.detail ?? `/api/public/tournament-shares/${encodeURIComponent(share.shareId)}`;
      const absolute = `${window.location.origin}${detailPath}`;
      try {
        await navigator.clipboard.writeText(absolute);
        setActionStatus(`已复制分享链接：${shortId(share.shareId)}`);
      } catch (nextError) {
        setActionStatus("复制分享链接失败", errorMessage(nextError));
      }
    },
    [setActionStatus]
  );

  const handleRevokeTournamentShare = useCallback(
    async (share: TournamentPublicShareSummary) => {
      setBusy("share-revoke");
      try {
        const response = await fetch(`/api/public/tournament-shares/${encodeURIComponent(share.shareId)}`, { method: "DELETE" });
        if (!response.ok && response.status !== 204) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        setPackShares((current) => current.filter((item) => item.shareId !== share.shareId));
        setActionStatus(`已吊销分享链接：${shortId(share.shareId)}`);
      } catch (nextError) {
        setActionStatus("吊销分享链接失败", errorMessage(nextError));
      } finally {
        setBusy(null);
      }
    },
    [setActionStatus]
  );

  const handleRevokeAllActiveShares = useCallback(async () => {
    const active = packShares.filter((share) => !share.expired);
    if (!active.length) {
      setActionStatus("没有可吊销的活跃分享链接。");
      return;
    }
    setBusy("share-revoke-all");
    try {
      let revoked = 0;
      const failed: string[] = [];
      for (const share of active) {
        try {
          const response = await fetch(`/api/public/tournament-shares/${encodeURIComponent(share.shareId)}`, {
            method: "DELETE"
          });
          if (!response.ok && response.status !== 204) {
            throw new Error(`${response.status} ${response.statusText}`);
          }
          revoked += 1;
          setPackShares((current) => current.filter((item) => item.shareId !== share.shareId));
        } catch (error) {
          failed.push(`${shortId(share.shareId)}: ${errorMessage(error)}`);
        }
      }
      if (failed.length) {
        setActionStatus(`批量吊销完成：revoked=${revoked}/${active.length}`, failed.join("; "));
      } else {
        setActionStatus(`已批量吊销 ${revoked} 条活跃分享链接。`);
      }
    } finally {
      setBusy(null);
    }
  }, [packShares, setActionStatus]);

  const handleDownloadArtifact = useCallback(() => {
    if (!currentMatchId) return;
    const target = `/api/matches/${encodeURIComponent(currentMatchId)}/trajectory.jsonl?view=${artifactView}`;
    setBusy("download");
    void fetch(target)
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${shortId(currentMatchId)}-trajectory-${artifactView}.jsonl`;
        anchor.click();
        URL.revokeObjectURL(url);
        setActionStatus(`trajectory.jsonl 已验证并开始下载：${shortId(currentMatchId)} · view=${artifactView}`);
      })
      .catch((nextError: unknown) => {
        setActionStatus("trajectory.jsonl 下载失败", errorMessage(nextError));
      })
      .finally(() => setBusy(null));
  }, [artifactView, currentMatchId, setActionStatus]);

  const handleDownloadMatchArtifact = useCallback(() => {
    if (!currentMatchId) return;
    const target = `/api/matches/${encodeURIComponent(currentMatchId)}/artifact?view=${artifactView}&download=1`;
    setBusy("download-match");
    void fetch(target)
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${shortId(currentMatchId)}-match-${artifactView}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
        setActionStatus(`match artifact 已验证并开始下载：${shortId(currentMatchId)} · view=${artifactView}`);
      })
      .catch((nextError: unknown) => {
        setActionStatus("match artifact 下载失败", errorMessage(nextError));
      })
      .finally(() => setBusy(null));
  }, [artifactView, currentMatchId, setActionStatus]);

  const handleRefreshCheckpoints = useCallback(async () => {
    if (!currentMatchId) {
      setActionStatus("无法刷新 checkpoint：尚未选择 run。");
      return;
    }
    setBusy("checkpoints");
    try {
      const response = await apiJson<CheckpointsResponse>(`/api/checkpoints?matchId=${encodeURIComponent(currentMatchId)}`);
      const ordered = orderCheckpoints(response.checkpoints);
      setCheckpoints(ordered);
      setSelectedCheckpointId((current) => (current && ordered.some((checkpoint) => checkpoint.checkpointId === current) ? current : ordered[0]?.checkpointId ?? ""));
      setActionStatus(`checkpoint 摘要已刷新：${ordered.length} 条`);
    } catch (nextError) {
      setActionStatus("checkpoint 摘要刷新失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [currentMatchId, setActionStatus]);

  const handleCreateCheckpoint = useCallback(async () => {
    if (!currentMatchId) {
      setActionStatus("无法创建 checkpoint：尚未选择 run。");
      return;
    }
    setBusy("checkpoint:create");
    try {
      const created = await apiJson<CheckpointCreateResponse>(`/api/matches/${encodeURIComponent(currentMatchId)}/checkpoints`, {
        method: "POST",
        body: JSON.stringify({ reason: `ui checkpoint ${new Date().toISOString()}` })
      });
      const response = await apiJson<CheckpointsResponse>(`/api/checkpoints?matchId=${encodeURIComponent(currentMatchId)}`);
      const ordered = orderCheckpoints(response.checkpoints);
      setCheckpoints(ordered);
      setSelectedCheckpointId(created.summary.checkpointId);
      setBranchTree(null);
      setInspector(inspectorFromCheckpoint(created.summary));
      setActionStatus(`checkpoint 已创建：${shortId(created.summary.checkpointId)} · artifact=${created.artifactUrl ? "summary-only" : "n/a"}`);
    } catch (nextError) {
      setActionStatus("checkpoint 创建失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [currentMatchId, setActionStatus]);

  const handleLoadForkLineage = useCallback(async () => {
    if (!currentMatchId) {
      setActionStatus("无法加载 fork lineage：尚未选择 run。");
      return;
    }
    setBusy("fork-lineage");
    try {
      const response = await apiJson<ForkLineageResponse>(`/api/matches/${encodeURIComponent(currentMatchId)}/fork-lineage`);
      setForkLineage(response.summary);
      setInspector(inspectorFromForkLineage(response.summary));
      setActionStatus(`fork lineage 已加载：${response.summary.isFork ? "fork" : "root run"} · boundary=${response.summary.boundary?.status ?? "n/a"}`);
    } catch (nextError) {
      setActionStatus("fork lineage 加载失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [currentMatchId, setActionStatus]);

  const handleSelectCheckpoint = useCallback(
    (checkpoint: CheckpointSummary) => {
      setSelectedCheckpointId(checkpoint.checkpointId);
      setInspector(inspectorFromCheckpoint(checkpoint));
      setActionStatus(`已选择 checkpoint：${shortId(checkpoint.checkpointId)}`);
    },
    [setActionStatus]
  );

  const handleLoadBranchTree = useCallback(
    async (checkpointId = selectedCheckpointId) => {
      if (!checkpointId) {
        setActionStatus("无法加载 branch tree：尚未选择 checkpoint。");
        return;
      }
      setBusy("branch-tree");
      try {
        const response = await apiJson<BranchTreeResponse>(`/api/checkpoints/${encodeURIComponent(checkpointId)}/branch-tree`);
        setBranchTree(response.summary);
        setInspector(inspectorFromBranchTree(response.summary));
        setActionStatus(
          `branch tree 已加载：checkpoints=${response.summary.counts?.checkpoints ?? 0} · matches=${response.summary.counts?.matches ?? 0} · edges=${response.summary.counts?.edges ?? 0}`
        );
      } catch (nextError) {
        setActionStatus("branch tree 加载失败", errorMessage(nextError));
      } finally {
        setBusy(null);
      }
    },
    [selectedCheckpointId, setActionStatus]
  );

  const handleSelectStep = useCallback(
    (index: number) => {
      const step = artifact?.socialEpisode.steps[index];
      setSelectedStepIndex(index);
      if (step) {
        setInspector(inspectorFromSocialStep(step, index));
        setActionStatus(
          `已选择 native step：#${index + 1} · ${step.actorId} · ${readSocialCommitStatus(step)}`
        );
      }
    },
    [artifact?.socialEpisode.steps, setActionStatus]
  );

  const handleSelectAgent = useCallback(
    (agent: AgentHarnessState) => {
      setSelectedAgentId(agent.playerId);
      setInspector(inspectorFromAgent(agent));
      setActionStatus(`已选择 agent：${agent.playerId}`);
    },
    [setActionStatus]
  );

  const handleSelectMessage = useCallback(
    (message: SocialMessage) => {
      setInspector(inspectorFromMessage(message));
      setActionStatus(`已选择社会消息：#${message.seq} · ${message.senderId}`);
    },
    [setActionStatus]
  );

  const handleWorkspaceChange = useCallback(
    (nextWorkspace: Workspace) => {
      setWorkspace(nextWorkspace);
      const item = workspaceItems.find((entry) => entry.id === nextWorkspace);
      setActionStatus(`工作区已切换：${item?.label ?? nextWorkspace}`);
    },
    [setActionStatus]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(
      window.location.search.startsWith("?") ? window.location.search.slice(1) : window.location.search
    );
    if (workspace === "runs") params.delete("workspace");
    else params.set("workspace", workspace);
    params.delete("tab");
    const nextSearch = params.toString();
    const currentSearch = window.location.search.startsWith("?")
      ? window.location.search.slice(1)
      : window.location.search;
    if (nextSearch === currentSearch) return;
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [workspace]);

  useEffect(() => {
    if (inspector && isCompactLayout) {
      setMobileInspectorOpen(true);
    }
  }, [inspector, isCompactLayout]);

  const menuItems: MenuProps["items"] = workspaceItems.map((item) => ({
    key: item.id,
    icon: item.icon,
    label: (
      <Flex vertical>
        <Text>{item.label}</Text>
        <Text type="secondary">{item.description}</Text>
      </Flex>
    )
  }));

  const tabItems: TabsProps["items"] = [
    {
      key: "runs",
      label: "运行",
      children: (
        <RunsWorkspace
          matches={filteredMatches}
          selectedMatchId={currentMatchId}
          query={query}
          onQueryChange={setQuery}
          onLoadArtifact={(match) => void loadArtifact(match, artifactView, candidateId)}
          onInspect={(match) => setInspector(inspectorFromMatch(match))}
          busy={busy}
        />
      )
    },
    {
      key: "timeline",
      label: "时间线",
      children: (
        <TimelineWorkspace
          artifact={artifact}
          selectedStepIndex={selectedStepIndex}
          selectedStep={selectedStep}
          onSelectStep={handleSelectStep}
          onSelectReplayFrame={(index) => void handleLoadReplayFrame(index)}
          onReplay={handleReplay}
          onDownloadJsonl={handleDownloadArtifact}
          onDownloadMatch={handleDownloadMatchArtifact}
          artifactView={artifactView}
          replay={replay}
          replayFrame={replayFrame}
          replayFrameCursorIndex={replayFrameCursorIndex}
          replayFrameLoadState={replayFrameLoadState}
          busy={busy}
        />
      )
    },
    {
      key: "domain",
      label: "狼人杀复盘",
      children: (
        <WerewolfReviewBoard
          review={werewolfReview}
          source={
            replayFrame
              ? {
                  kind: "replay-frame",
                  nativeStepCount: replayFrame.cursor.nativeStepCount,
                  stateHash: replayFrame.cursor.stateHash ?? replayFrame.cursor.recordedPostStateHash
                }
              : { kind: "artifact-final" }
          }
          onSelectReplayBoundary={(nativeStepCount) => void handleLoadReplayFrame(nativeStepCount - 1)}
          loading={replayFrameLoadState === "loading"}
          error={replayFrameLoadState === "error" ? replayFrameError : null}
        />
      )
    },
    {
      key: "society",
      label: "社会",
      children: (
        <SocietyWorkspace
          artifact={artifact}
          agents={agents}
          selectedAgent={selectedAgent}
          messages={messages}
          channels={channels}
          onSelectAgent={handleSelectAgent}
          onSelectMessage={handleSelectMessage}
          onInspectExposure={(edge) => setInspector(inspectorFromSocialExposure(edge))}
        />
      )
    },
    {
      key: "lineage",
      label: "谱系",
      children: (
        <LineageWorkspace
          currentMatchId={currentMatchId}
          checkpoints={checkpoints}
          selectedCheckpointId={selectedCheckpointId}
          forkLineage={forkLineage}
          branchTree={branchTree}
          busy={busy}
          onRefreshCheckpoints={handleRefreshCheckpoints}
          onCreateCheckpoint={handleCreateCheckpoint}
          onLoadForkLineage={handleLoadForkLineage}
          onSelectCheckpoint={handleSelectCheckpoint}
          onLoadBranchTree={handleLoadBranchTree}
          onInspectCheckpoint={(checkpoint) => setInspector(inspectorFromCheckpoint(checkpoint))}
          onInspectForkLineage={() => forkLineage && setInspector(inspectorFromForkLineage(forkLineage))}
          onInspectBranchTree={() => branchTree && setInspector(inspectorFromBranchTree(branchTree))}
        />
      )
    },
    {
      key: "evaluation",
      label: "评测",
      children: (
        <EvaluationWorkspace
          artifact={artifact}
          metrics={metrics}
          warnings={warnings}
          onInspectMetric={(metric, decision) => setInspector(inspectorFromMetric(metric, decision))}
          onInspectWarning={(warning) => setInspector(inspectorFromWarning(warning))}
        />
      )
    },
    {
      key: "experiments",
      label: "实验矩阵",
      children: (
        <ExperimentsWorkspace
          result={matrixResult}
          artifactSets={matrixArtifactSets}
          games={matrixGames}
          exportArtifacts={matrixExportArtifacts}
          exportAvailable={Boolean(config?.artifactExport?.matrixConfigured)}
          selectedModel={selectedModel}
          maxTransitions={maxTransitions}
          timeoutSeconds={timeoutSeconds}
          busy={busy}
          onGamesChange={setMatrixGames}
          onExportArtifactsChange={setMatrixExportArtifacts}
          onRun={() => void handleRunMatrixExperiment()}
          onRefreshArtifacts={() => void handleRefreshMatrixArtifacts()}
        />
      )
    },
    {
      key: "compare",
      label: "对比",
      children: (
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
          onInspectRow={(row) => setInspector(inspectorFromComparisonRow(row))}
          onInspectFilteredProjection={(projection) =>
            setInspector(inspectorFromFilteredComparison(projection))
          }
        />
      )
    },
    {
      key: "packs",
      label: "公开包",
      children: (
        <PacksWorkspace
          packs={tournamentPacks}
          selectedPackId={selectedPackId}
          shares={packShares}
          shareInventory={shareInventory}
          shareLabel={shareLabel}
          packGames={packGames}
          shareExpiresInHours={shareExpiresInHours}
          shareAllowlist={shareAllowlist}
          busy={busy}
          selectedModel={selectedModel}
          maxTransitions={maxTransitions}
          timeoutSeconds={timeoutSeconds}
          onRefresh={() => void handleRefreshTournamentPacks()}
          onRefreshShareInventory={() => void handleRefreshShareInventory()}
          onDownloadShareAnalyticsSummary={(format) => void handleDownloadShareAnalyticsSummary(format)}
          onExport={() => void handleExportTournamentPack()}
          onSelectPack={(pack) => void handleSelectTournamentPack(pack)}
          onInspectTournamentComparison={(pack) => void handleInspectTournamentComparison(pack)}
          onShareLabelChange={setShareLabel}
          onPackGamesChange={setPackGames}
          onShareExpiresInHoursChange={setShareExpiresInHours}
          onShareAllowlistChange={setShareAllowlist}
          onCreateShare={() => void handleCreateTournamentShare()}
          onCopyShare={(share) => void handleCopyShareUrl(share)}
          onRevokeShare={(share) => void handleRevokeTournamentShare(share)}
          onRevokeAllActiveShares={() => void handleRevokeAllActiveShares()}
          onInspectShare={(share) =>
            setInspector({
              kind: "tournament-public-share",
              title: `Share ${shortId(share.shareId)}`,
              subtitle: share.label ?? share.artifactSetId,
              fields: [
                ["shareId", share.shareId],
                ["artifactSetId", share.artifactSetId],
                ["expiresAt", share.expiresAt ?? "never"],
                ["expired", String(Boolean(share.expired))],
                ["relativeFiles", share.relativeFiles?.join(", ") ?? "all registered files"],
                ["detailViews", String(share.analytics?.detailViewCount ?? 0)],
                ["downloads", String(share.analytics?.downloadCount ?? 0)],
                [
                  "downloadsByFile",
                  Object.entries(share.analytics?.downloadsByFile ?? {})
                    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                    .map(([file, count]) => `${file}×${count}`)
                    .join(", ") || "n/a"
                ],
                [
                  "downloadsByMinute",
                  (share.analytics?.downloadsByMinute ?? [])
                    .slice(-5)
                    .map((bucket) => `${bucket.minute.slice(11, 16)}×${bucket.count}`)
                    .join(", ") || "n/a"
                ],
                [
                  "detailViewsByMinute",
                  (share.analytics?.detailViewsByMinute ?? [])
                    .slice(-5)
                    .map((bucket) => `${bucket.minute.slice(11, 16)}×${bucket.count}`)
                    .join(", ") || "n/a"
                ],
                ["lastDownloadedFile", share.analytics?.lastDownloadedFile ?? "n/a"],
                [
                  "packDensity",
                  formatPackCommitDensity({
                    nativeSteps: share.packDensity?.nativeSteps,
                    committedSteps: share.packDensity?.committedSteps,
                    rejectedSteps: share.packDensity?.rejectedSteps
                  })
                ],
                [
                  "packMetricPromotion",
                  formatPackMetricPromotion({
                    metricCount: share.packMetricPromotion?.metricCount,
                    scorecardEligibleMetricCount: share.packMetricPromotion?.scorecardEligibleMetricCount,
                    metricPromotionClassCounts: share.packMetricPromotion?.metricPromotionClassCounts
                  })
                ],
                ["detail", share.urls?.detail ?? "n/a"],
                ["filesBase", share.urls?.filesBase ?? "n/a"]
              ],
              json: share
            })
          }
        />
      )
    }
  ];

  const busyAny = Boolean(busy);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          borderRadius: 8,
          colorPrimary: "#1455d9",
          colorInfo: "#1455d9",
          colorSuccess: "#157a58",
          colorWarning: "#b86b00",
          colorError: "#c43d4f",
          colorBgLayout: "#f4f6fa",
          colorBgContainer: "#ffffff",
          colorBorderSecondary: "#e4e8f0",
          colorText: "#182334",
          colorTextSecondary: "#667085",
          controlHeight: 34,
          fontFamily:
            "\"Noto Sans SC\", \"PingFang SC\", \"Microsoft YaHei\", \"Source Han Sans SC\", \"Geist Variable\", system-ui, sans-serif"
        },
        components: {
          Layout: {
            bodyBg: "#f4f6fa",
            headerBg: "#ffffff",
            siderBg: "#ffffff"
          },
          Card: {
            headerBg: "#ffffff",
            bodyPadding: 16,
            headerFontSize: 14
          },
          Menu: {
            itemBorderRadius: 6,
            itemMarginInline: 0,
            itemMarginBlock: 2,
            itemSelectedBg: "#eaf1ff"
          },
          Table: {
            headerBg: "#f7f9fc",
            headerColor: "#566176",
            cellPaddingBlockSM: 9,
            cellPaddingInlineSM: 10
          }
        }
      }}
    >
      <Layout style={{ minWidth: 0, minHeight: "100vh" }}>
        <Sider
          width={292}
          breakpoint="xl"
          collapsedWidth={0}
          trigger={null}
          style={{ borderInlineEnd: "1px solid #e4e8f0", height: "100vh", overflow: "auto", position: "sticky", insetBlockStart: 0 }}
        >
          <Flex vertical gap="middle" style={{ minHeight: "100%", padding: 16 }}>
            <Space align="start">
              <ExperimentOutlined style={{ fontSize: 28, color: "#1455d9" }} />
              <Flex vertical gap={4}>
                <Title level={4} style={{ margin: 0 }}>
                  多 Agent 社会 Harness Cockpit
                </Title>
                <Space size={4} wrap>
                  <Tag color="blue">server truth</Tag>
                  <Tag color={artifactView === "truth-redacted" ? "warning" : "processing"}>{artifactView}</Tag>
                  {!artifact ? (
                    <Tag>no artifact</Tag>
                  ) : artifact.projection?.postgameTruthRedacted ? (
                    <Tag color="gold">truth redacted</Tag>
                  ) : (
                    <Tag>truth visible</Tag>
                  )}
                </Space>
              </Flex>
            </Space>

            <Menu
              mode="inline"
              selectedKeys={[workspace]}
              items={menuItems}
              onClick={({ key }) => handleWorkspaceChange(key as Workspace)}
            />
            <RunContextPanel
              artifactView={artifactView}
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
            />
          </Flex>
        </Sider>

        <Layout style={{ minWidth: 0 }}>
          <Header style={{ borderBlockEnd: "1px solid #e4e8f0", height: "auto", padding: isCompactLayout ? "12px" : "14px 20px" }}>
            <Flex gap="middle" justify="space-between" align="center" wrap="wrap">
              <Flex vertical gap={4}>
                {isNarrowLayout ? (
                  <Space size={6}>
                    <ExperimentOutlined style={{ color: "#1455d9" }} />
                    <Text strong>多 Agent 社会 Harness</Text>
                  </Space>
                ) : null}
                <Breadcrumb
                  items={[
                    { title: "Harness" },
                    { title: activeWorkspace.label },
                    { title: currentMatchId ? shortId(currentMatchId) : "未选择 run" }
                  ]}
                />
                <Space size={8} wrap>
                  <Title level={isCompactLayout ? 4 : 3} style={{ margin: 0 }}>
                    {activeWorkspace.label}
                  </Title>
                  <Tag color={artifact ? "processing" : "default"}>{artifact ? "artifact loaded" : "artifact not loaded"}</Tag>
                </Space>
              </Flex>
              <Space wrap>
                {isNarrowLayout ? (
                  <Tooltip title="运行上下文">
                    <Button
                      aria-label="打开运行上下文"
                      icon={decorativeIcon(<SettingOutlined />)}
                      onClick={() => setMobileContextOpen(true)}
                    />
                  </Tooltip>
                ) : null}
                {isCompactLayout ? (
                  <Tooltip title="证据检查器">
                    <Button
                      aria-label="打开证据检查器"
                      icon={decorativeIcon(<FileSearchOutlined />)}
                      onClick={() => setMobileInspectorOpen(true)}
                    />
                  </Tooltip>
                ) : null}
                <Select
                  aria-label="模型选择"
                  value={selectedModel}
                  style={{ width: isCompactLayout ? 156 : 184 }}
                  options={(models.length ? models : selectedModel ? [selectedModel] : []).map((model) => ({ value: model, label: model }))}
                  onChange={setSelectedModel}
                  placeholder="未检测到模型"
                  disabled={busyAny || (!models.length && !selectedModel)}
                />
                <Button icon={decorativeIcon(<ReloadOutlined />)} onClick={handleRefresh} disabled={busyAny}>
                  刷新运行
                </Button>
                <Button icon={decorativeIcon(<EyeOutlined />)} onClick={handleLoadLatest} disabled={busyAny}>
                  加载最近
                </Button>
                <Button type="primary" icon={decorativeIcon(<PlayCircleOutlined />)} loading={busy === "run"} onClick={handleRunExperiment} disabled={busyAny}>
                  运行实验
                </Button>
              </Space>
            </Flex>
          </Header>

          <Layout style={{ minWidth: 0 }}>
            <Content style={{ minWidth: 0, padding: isCompactLayout ? 12 : 20 }}>
              <div role="status" aria-live="polite">
                <StatusBanner status={status} error={error} busy={busy} />
              </div>

              <KpiGrid matches={matches} artifact={artifact} comparison={comparison} replay={replay} />

              <Card style={{ marginTop: 16 }}>
                <Tabs destroyOnHidden activeKey={workspace} items={tabItems} onChange={(key) => handleWorkspaceChange(key as Workspace)} />
              </Card>
            </Content>

            <Sider
              width={384}
              breakpoint="lg"
              collapsedWidth={0}
              trigger={null}
              style={{ borderInlineStart: "1px solid #e4e8f0", background: "#ffffff", height: "100vh", overflow: "auto", position: "sticky", insetBlockStart: 0 }}
            >
              <InspectorPanel item={inspector} onOpenRaw={() => setRawOpen(true)} artifactView={artifactView} />
            </Sider>
          </Layout>
        </Layout>

        <Drawer
          title="运行上下文"
          placement="left"
          width={screens.sm ? 360 : "100vw"}
          open={mobileContextOpen}
          onClose={() => setMobileContextOpen(false)}
          destroyOnHidden
        >
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Menu
              mode="inline"
              selectedKeys={[workspace]}
              items={menuItems}
              onClick={({ key }) => {
                handleWorkspaceChange(key as Workspace);
                setMobileContextOpen(false);
              }}
            />
            <RunContextPanel
              artifactView={artifactView}
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
            />
          </Space>
        </Drawer>

        <Drawer
          title="Evidence Inspector"
          placement="right"
          width={screens.sm ? 440 : "100vw"}
          open={mobileInspectorOpen}
          onClose={() => setMobileInspectorOpen(false)}
          destroyOnHidden
          styles={{ body: { padding: 0 } }}
        >
          <InspectorPanel
            item={inspector}
            onOpenRaw={() => {
              setMobileInspectorOpen(false);
              setRawOpen(true);
            }}
            artifactView={artifactView}
          />
        </Drawer>

        <Drawer
          title={inspector?.title ?? "原始证据片段"}
          width={screens.md ? 760 : "100vw"}
          open={rawOpen}
          onClose={() => setRawOpen(false)}
          extra={<Tag color="processing">{artifactView}</Tag>}
        >
          <Paragraph type="secondary">
            只读片段来自当前服务端投影。private evidence redacted；
            {artifactView === "truth-redacted" ? " postgame truth redacted。" : " postgame truth visible。"}
          </Paragraph>
          <Input.TextArea readOnly value={JSON.stringify(inspector?.json ?? inspector ?? null, null, 2)} autoSize={{ minRows: 24, maxRows: 40 }} />
        </Drawer>
      </Layout>
    </ConfigProvider>
  );
}

function StatusBanner({ status, error, busy }: { status: string; error: string | null; busy: string | null }) {
  const isWaitingForArtifact = !error && !busy && /(没有可加载|没有匹配|未选择 run|尚未选择)/.test(status);
  return (
    <Alert
      showIcon
      type={error ? "error" : busy ? "info" : isWaitingForArtifact ? "warning" : "success"}
      icon={error || isWaitingForArtifact ? <WarningOutlined /> : <CheckCircleOutlined />}
      message={error ? `${status}: ${error}` : status}
      action={<Tag color={error ? "error" : busy ? "processing" : isWaitingForArtifact ? "warning" : "success"}>{error ? "error" : busy ? busy : isWaitingForArtifact ? "awaiting data" : "ready"}</Tag>}
    />
  );
}

function KpiGrid({
  matches,
  artifact,
  comparison,
  replay
}: {
  matches: MatchRecord[];
  artifact: ProjectedMatchArtifact | null;
  comparison: MatchComparisonArtifact | null;
  replay: ReplayResponse | null;
}) {
  const completed = matches.filter((match) => (match.harnessStatus ?? match.status) === "completed").length;
  const truncated = matches.filter((match) => (match.harnessStatus ?? match.status) === "truncated").length;
  const failed = matches.filter((match) => (match.harnessStatus ?? match.status) === "failed").length;
  const replayOk = replay?.summary?.ok;
  const stepCounts = artifact ? countSocialStepCommits(artifact.socialEpisode.steps) : null;
  return (
    <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
      <Col xs={24} sm={12} xl={6}>
        <Card>
          <Statistic
            title="runs"
            value={`${completed}/${matches.length}`}
            prefix={<DatabaseOutlined />}
            suffix={<Text type="secondary">truncated {truncated} · failed {failed}</Text>}
          />
        </Card>
      </Col>
      <Col xs={24} sm={12} xl={6}>
        <Card>
          <Statistic
            title="native execution steps"
            value={stepCounts?.nativeSteps ?? "n/a"}
            prefix={<BranchesOutlined />}
            suffix={
              <Text type="secondary">
                {artifact
                  ? `${shortId(artifact.runId)} · c${stepCounts?.committedSteps ?? 0}/r${stepCounts?.rejectedSteps ?? 0}`
                  : "未加载"}
              </Text>
            }
          />
        </Card>
      </Col>
      <Col xs={24} sm={12} xl={6}>
        <Card>
          <Statistic
            title="social evidence"
            value={artifact ? artifact.socialEpisode.messages.length : "n/a"}
            prefix={<MessageOutlined />}
            suffix={<Text type="secondary">{artifact ? `${artifact.socialEpisode.channels.length} channels` : "未加载工件"}</Text>}
          />
        </Card>
      </Col>
      <Col xs={24} sm={12} xl={6}>
        <Card>
          <Statistic
            title="compare / replay"
            value={comparison ? `${comparison.summary.changedRowCount}/${comparison.summary.rowCount}` : replayOk ? "replay ok" : "pending"}
            prefix={<SwapOutlined />}
            suffix={
              <Text type="secondary">
                {comparison
                  ? `changed · cΔ${comparison.summary.committedStepsDelta}/rΔ${comparison.summary.rejectedStepsDelta}`
                  : replay
                    ? `mismatch ${replay.summary?.mismatchCount ?? 0}`
                    : "未运行"}
              </Text>
            }
          />
        </Card>
      </Col>
    </Row>
  );
}

function RunContextPanel({
  artifactView,
  onArtifactViewChange,
  busy,
  currentMatchId,
  artifact,
  selectedMatch,
  messageCount,
  metricCount,
  maxTransitions,
  onMaxTransitionsChange,
  timeoutSeconds,
  onTimeoutSecondsChange,
  jointPhaseScheduler,
  onJointPhaseSchedulerChange
}: {
  artifactView: ArtifactView;
  onArtifactViewChange: (value: ArtifactView) => void;
  busy: boolean;
  currentMatchId: string;
  artifact: ProjectedMatchArtifact | null;
  selectedMatch: MatchRecord | null;
  messageCount: number | null;
  metricCount: number | null;
  maxTransitions: string;
  onMaxTransitionsChange: (value: string) => void;
  timeoutSeconds: string;
  onTimeoutSecondsChange: (value: string) => void;
  jointPhaseScheduler: "aec-batched-decision" | "parallel";
  onJointPhaseSchedulerChange: (value: "aec-batched-decision" | "parallel") => void;
}) {
  const stepCounts = useMemo(
    () => (artifact ? countSocialStepCommits(artifact.socialEpisode.steps) : null),
    [artifact]
  );
  const legacyProjectionCount = artifact
    ? artifact.trajectory.length
    : selectedMatch?.legacyProjectionSteps ?? selectedMatch?.trajectorySteps ?? "n/a";
  const runStatus = artifact?.status ?? selectedMatch?.status ?? "no artifact";
  const hasArtifact = Boolean(artifact);

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        size="small"
        title="运行上下文"
        extra={<Tag color={hasArtifact ? "processing" : "default"}>{runStatus}</Tag>}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
            <Form.Item label="工件投影" style={{ marginBottom: 0 }}>
              <Select
                aria-label="工件投影"
                value={artifactView}
                options={[
                  { value: "postgame-redacted", label: "研究视图 · 私有脱敏" },
                  { value: "truth-redacted", label: "公开视图 · 真相脱敏" }
                ]}
                onChange={(value) => onArtifactViewChange(value as ArtifactView)}
                disabled={busy}
              />
            </Form.Item>
          </Form>
          <Descriptions
            size="small"
            column={1}
            items={descriptionItems([
              ["当前 run", currentMatchId ? shortId(currentMatchId) : "未选择"],
              ["phase", artifact?.finalState.phase ?? selectedMatch?.state.phase ?? "n/a"],
              ["day", artifact?.finalState.day ?? selectedMatch?.state.day ?? "n/a"],
              ["native steps", stepCounts?.nativeSteps ?? "n/a"],
              ["committed steps", stepCounts?.committedSteps ?? "n/a"],
              ["rejected steps", stepCounts?.rejectedSteps ?? "n/a"],
              ["legacy projection", legacyProjectionCount],
              ["messages", messageCount ?? "n/a"],
              ["metrics", metricCount ?? "n/a"]
            ])}
          />
        </Space>
      </Card>

      <Card size="small" title="运行限制">
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
            <Form.Item label="最大 transitions">
              <Input
                aria-label="最大 transitions"
                inputMode="numeric"
                value={maxTransitions}
                onChange={(event) => onMaxTransitionsChange(event.target.value)}
                disabled={busy}
              />
            </Form.Item>
            <Form.Item label="超时秒数">
              <Input
                aria-label="超时秒数"
                inputMode="numeric"
                value={timeoutSeconds}
                onChange={(event) => onTimeoutSecondsChange(event.target.value)}
                disabled={busy}
              />
            </Form.Item>
            <Form.Item label="联合阶段调度" style={{ marginBottom: 0 }}>
              <Select
                aria-label="联合阶段调度"
                value={jointPhaseScheduler}
                options={[
                  { value: DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER, label: `${DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER}（默认）` },
                  { value: "parallel", label: "parallel（stepBatch）" }
                ]}
                onChange={(value) => onJointPhaseSchedulerChange(value as "aec-batched-decision" | "parallel")}
                disabled={busy}
              />
            </Form.Item>
          </Form>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {`parallel 仅用于狼人杀票/白天投票的联合阶段；需要 maxTransitions ≥ ${WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS}（system.advance + seer.inspect + 双狼 joint batch）。默认仍为 ${DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER}（opt-in only）。`}
          </Text>
          {jointPhaseScheduler === "parallel" &&
          parsePositiveInteger(maxTransitions, DEFAULT_MAX_TRANSITIONS) < WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS ? (
            <Alert
              type="warning"
              showIcon
              message="当前 maxTransitions 不足以完成首个 parallel joint batch，运行会被 API 拒绝。"
            />
          ) : null}
        </Space>
      </Card>
    </Space>
  );
}

function RunsWorkspace({
  matches,
  selectedMatchId,
  query,
  onQueryChange,
  onLoadArtifact,
  onInspect,
  busy
}: {
  matches: MatchRecord[];
  selectedMatchId: string;
  query: string;
  onQueryChange: (value: string) => void;
  onLoadArtifact: (match: MatchRecord) => void;
  onInspect: (match: MatchRecord) => void;
  busy: string | null;
}) {
  const columns: TableProps<MatchRecord>["columns"] = [
    {
      title: "run",
      dataIndex: "id",
      fixed: "left",
      render: (_, match) => (
        <Button type="link" size="small" onClick={() => onInspect(match)}>
          <Text code>{shortId(match.id)}</Text>
        </Button>
      )
    },
    {
      title: "status",
      dataIndex: "status",
      render: (status: MatchRecord["status"]) => <StatusTag status={status} />
    },
    { title: "phase", dataIndex: ["state", "phase"] },
    {
      title: "artifact",
      dataIndex: "hasArtifact",
      render: (hasArtifact: boolean) => <Tag color={hasArtifact ? "processing" : "default"}>{hasArtifact ? "available" : "missing"}</Tag>
    },
    {
      title: "models",
      dataIndex: "models",
      ellipsis: true,
      render: (models: string[]) => models.join(", ") || "n/a"
    },
    { title: "native steps", dataIndex: "nativeSteps", render: (value?: number) => (typeof value === "number" ? value : "n/a") },
    { title: "committed", dataIndex: "committedSteps", render: (value?: number) => (typeof value === "number" ? value : "n/a") },
    { title: "rejected", dataIndex: "rejectedSteps", render: (value?: number) => (typeof value === "number" ? value : "n/a") },
    { title: "created", dataIndex: "createdAt", render: (value: string) => formatDate(value) },
    {
      title: "action",
      fixed: "right",
      align: "right",
      render: (_, match) => (
        <Button
          size="small"
          icon={decorativeIcon(<FileSearchOutlined />)}
          disabled={!match.hasArtifact || busy === `artifact:${match.id}`}
          loading={busy === `artifact:${match.id}`}
          onClick={() => onLoadArtifact(match)}
        >
          加载工件
        </Button>
      )
    }
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Flex justify="space-between" align="center" gap="middle" wrap="wrap">
        <Flex vertical>
          <Title level={4} style={{ margin: 0 }}>
            运行注册表
          </Title>
          <Text type="secondary">真实 `/api/matches` 数据。React 只保存筛选和选择状态。</Text>
        </Flex>
        <Input.Search
          aria-label="搜索运行"
          allowClear
          placeholder="run / model / phase"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          style={{ width: 280 }}
        />
      </Flex>
      <Table
        rowKey="id"
        size="small"
        bordered
        loading={busy === "bootstrap" || busy === "matches"}
        columns={columns}
        dataSource={matches}
        rowSelection={{
          type: "radio",
          selectedRowKeys: selectedMatchId ? [selectedMatchId] : []
        }}
        locale={{ emptyText: <Empty description="没有匹配的 run。调整筛选，或用顶部“运行实验”生成真实 artifact-backed run。" /> }}
        pagination={{ pageSize: 8, showSizeChanger: true }}
        scroll={{ x: 1120 }}
      />
    </Space>
  );
}

function TimelineWorkspace({
  artifact,
  selectedStepIndex,
  selectedStep,
  onSelectStep,
  onSelectReplayFrame,
  onReplay,
  onDownloadJsonl,
  onDownloadMatch,
  artifactView,
  replay,
  replayFrame,
  replayFrameCursorIndex,
  replayFrameLoadState,
  busy
}: {
  artifact: ProjectedMatchArtifact | null;
  selectedStepIndex: number;
  selectedStep: ProjectedSocialStep | null;
  onSelectStep: (index: number) => void;
  onSelectReplayFrame: (index: number) => void;
  onReplay: () => void;
  onDownloadJsonl: () => void;
  onDownloadMatch: () => void;
  artifactView: ArtifactView;
  replay: ReplayResponse | null;
  replayFrame: PostgameReplayFrameDto | null;
  replayFrameCursorIndex: number | null;
  replayFrameLoadState: ReplayFrameLoadState;
  busy: string | null;
}) {
  const steps = artifact?.socialEpisode.steps ?? [];
  const legacySteps = artifact?.trajectory ?? [];
  const nativeStepByTraceId = useMemo(() => new Map(steps.map((step) => [step.traceId, step])), [steps]);
  const legacyStepByTraceId = useMemo(() => new Map(legacySteps.map((step) => [step.traceId, step])), [legacySteps]);
  const selectedLegacyStep = selectedStep ? legacyStepByTraceId.get(selectedStep.traceId) ?? null : null;
  const selectedDecisionJournal = useMemo(
    () =>
      selectedStep
        ? buildDecisionJournalEvidence(
            artifact?.agents.flatMap((agent) => agent.social?.journal?.entries ?? []) ?? [],
            selectedStep.actorId,
            selectedStep.traceId
          )
        : [],
    [artifact?.agents, selectedStep]
  );
  const schedulerCounts = useMemo(() => countSocialSchedulerModes(steps), [steps]);
  const { committedSteps, rejectedSteps } = useMemo(() => countSocialStepCommits(steps), [steps]);
  const replayFrameBoundaryIndexes = useMemo(
    () => steps.flatMap((_, index) => (isSafeHarnessCheckpointBoundary(steps, index) ? [index] : [])),
    [steps]
  );
  const replayFrameCursorPosition = replayFrameCursorIndex === null ? -1 : replayFrameBoundaryIndexes.indexOf(replayFrameCursorIndex);
  const canLoadSelectedReplayFrame =
    artifactView === "postgame-redacted" && selectedStepIndex >= 0 && isSafeHarnessCheckpointBoundary(steps, selectedStepIndex);
  const progress = steps.length ? ((selectedStepIndex + 1) / steps.length) * 100 : 0;
  const columns: TableProps<ProjectedSocialStep>["columns"] = [
    { title: "#", width: 64, render: (_, __, index) => index + 1 },
    { title: "turn", dataIndex: "turnIndex", width: 72 },
    { title: "actor", dataIndex: "actorId", render: (actorId: string) => <Text code>{actorId}</Text> },
    { title: "status", render: (_, step) => <CommitStatusTag status={readSocialCommitStatus(step)} /> },
    { title: "failure stage", render: (_, step) => step.failure?.stage ?? (step.error ? "legacy_error" : "none") },
    { title: "scheduler", render: (_, step) => <SchedulerTag mode={step.schedulerMode} /> },
    { title: "action", render: (_, step) => step.action.kind },
    { title: "command", render: (_, step) => readSocialCommandType(step) },
    { title: "messages", render: (_, step) => (step.messageSeqRange ? rangeLabel(step.messageSeqRange) : "none") },
    { title: "state", render: (_, step) => `${shortId(step.preStateHash)} -> ${shortId(step.postStateHash)}` },
    {
      title: "查看",
      fixed: "right",
      width: 72,
      render: (_, __, index) => (
        <Button type="link" size="small" aria-label={`查看原生步骤 ${index + 1}`} onClick={() => onSelectStep(index)}>
          查看
        </Button>
      )
    }
  ];
  const legacyColumns: TableProps<RedactedHarnessStepDto>["columns"] = [
    { title: "#", width: 64, render: (_, __, index) => index + 1 },
    { title: "trace", dataIndex: "traceId", render: (traceId: string) => <Text code>{shortId(traceId)}</Text> },
    { title: "actor", dataIndex: "actorId", render: (actorId: string) => <Text code>{actorId}</Text> },
    { title: "pending", render: (_, step) => readPendingKind(step) },
    { title: "command", render: (_, step) => readCommandType(step.command) },
    {
      title: "native link",
      render: (_, step) => (nativeStepByTraceId.has(step.traceId) ? <Tag color="success">linked</Tag> : <Tag color="error">missing</Tag>)
    },
    {
      title: "查看",
      fixed: "right",
      width: 72,
      render: (_, legacyStep) => {
        const index = steps.findIndex((step) => step.traceId === legacyStep.traceId);
        return (
          <Button type="link" size="small" aria-label={`查看旧轨迹步骤 ${shortId(legacyStep.traceId)}`} disabled={index < 0} onClick={() => onSelectStep(index)}>
            查看
          </Button>
        );
      }
    }
  ];

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={15}>
        <Card
          title="时间线"
          extra={
            <Space wrap>
              <Tag>{artifactView}</Tag>
              <Button
                icon={decorativeIcon(<CloudDownloadOutlined />)}
                onClick={onDownloadMatch}
                disabled={!artifact}
                loading={busy === "download-match"}
              >
                工件 JSON
              </Button>
              <Button
                icon={decorativeIcon(<CloudDownloadOutlined />)}
                onClick={onDownloadJsonl}
                disabled={!artifact}
                loading={busy === "download"}
              >
                JSONL
              </Button>
              <Button
                type="primary"
                icon={decorativeIcon(<PlayCircleOutlined />)}
                onClick={onReplay}
                disabled={!artifact || artifactView !== "postgame-redacted" || busy === "replay"}
                loading={busy === "replay"}
              >
                复现
              </Button>
            </Space>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Text type="secondary">
              主时间线来自原生 social episode 执行工件；system、committed 与 rejected 步骤均为可选择、可审计证据，确定性 replay 不重新调用模型。
            </Text>
            {artifactView === "postgame-redacted" ? (
              <Card size="small" title="服务端回放游标" data-testid="server-replay-cursor-controls">
                <Space direction="vertical" size="small" style={{ width: "100%" }}>
                  <Text type="secondary">
                    游标只接受完整原生 scheduler 边界。浏览器不会应用命令或推断状态；每次跳转都由服务端从 canonical artifact 无模型重放。
                  </Text>
                  <Space wrap>
                    <Button
                      size="small"
                      onClick={() => {
                        const previous = replayFrameBoundaryIndexes[replayFrameCursorPosition - 1];
                        if (previous !== undefined) onSelectReplayFrame(previous);
                      }}
                      disabled={replayFrameCursorPosition <= 0 || replayFrameLoadState === "loading"}
                    >
                      上一帧
                    </Button>
                    <Button
                      size="small"
                      onClick={() => {
                        const next = replayFrameBoundaryIndexes[replayFrameCursorPosition + 1];
                        if (next !== undefined) onSelectReplayFrame(next);
                      }}
                      disabled={
                        replayFrameCursorPosition < 0 ||
                        replayFrameCursorPosition >= replayFrameBoundaryIndexes.length - 1 ||
                        replayFrameLoadState === "loading"
                      }
                    >
                      下一帧
                    </Button>
                    <Select
                      aria-label="跳转服务端回放帧"
                      size="small"
                      style={{ minWidth: 220, maxWidth: "100%" }}
                      placeholder="跳转到完整原生边界"
                      value={replayFrameCursorIndex ?? undefined}
                      loading={replayFrameLoadState === "loading"}
                      onChange={(value) => onSelectReplayFrame(Number(value))}
                      options={replayFrameBoundaryIndexes.map((index) => {
                        const step = steps[index];
                        return {
                          value: index,
                          label: `#${index + 1} · turn ${step?.turnIndex ?? "?"} · ${readSocialCommitStatus(step ?? {})}`
                        };
                      })}
                    />
                    <Tag color={replayFrame ? "success" : "default"}>
                      {replayFrame
                        ? `frame #${replayFrame.cursor.nativeStepCount} · ${shortId(replayFrame.cursor.stateHash)}`
                        : "尚未请求服务端帧"}
                    </Tag>
                  </Space>
                </Space>
              </Card>
            ) : (
              <Alert
                type="warning"
                showIcon
                message="真相脱敏视图不暴露原生 scheduler 游标"
                description="原生步骤序列可能反推出夜间角色节奏；该视图仅显示最终公共投影。"
              />
            )}
            <Row gutter={[12, 12]}>
              <Col xs={24} sm={12} xl={6}>
                <Statistic title="native steps" value={steps.length} prefix={<ApiOutlined />} />
              </Col>
              <Col xs={24} sm={12} xl={6}>
                <Statistic title="committed" value={committedSteps} prefix={<CheckCircleOutlined />} />
              </Col>
              <Col xs={24} sm={12} xl={6}>
                <Statistic title="rejected" value={rejectedSteps} prefix={<WarningOutlined />} />
              </Col>
              <Col xs={24} sm={12} xl={6}>
                <Statistic title="messages emitted" value={artifact?.socialEpisode.messages.length ?? 0} prefix={<MessageOutlined />} />
              </Col>
            </Row>
            <Space wrap>
              <Tag>AEC {schedulerCounts.aec}</Tag>
              <Tag color="processing">batched {schedulerCounts["aec-batched-decision"]}</Tag>
              <Tag color="warning">parallel {schedulerCounts.parallel}</Tag>
              <Tag color="default">episode {artifact?.socialEpisode.schedulerMode ?? "n/a"}</Tag>
            </Space>
            <Progress percent={Math.round(progress)} />
            <Table
              rowKey="traceId"
              size="small"
              bordered
              loading={Boolean(busy?.startsWith("artifact:"))}
              columns={columns}
              dataSource={steps}
              pagination={{ pageSize: 10 }}
              rowSelection={{
                type: "radio",
                selectedRowKeys: selectedStep?.traceId ? [selectedStep.traceId] : []
              }}
              onRow={(_, index) => ({ onClick: () => onSelectStep(index ?? 0) })}
              locale={{ emptyText: <Empty description="尚未加载原生 social episode steps。先从运行注册表或顶部加载最近 artifact。" /> }}
            />
            <Card
              size="small"
              title="Legacy trajectory projection"
              extra={<Tag color="warning">migration/debug only</Tag>}
            >
              <Space direction="vertical" size="small" style={{ width: "100%" }}>
                <Text type="secondary">
                  这是旧 checkpoint/迁移兼容投影，只包含成功的 player steps；它不是 system、失败步骤或执行顺序的真相源。
                </Text>
                <Table
                  rowKey="traceId"
                  size="small"
                  bordered
                  loading={Boolean(busy?.startsWith("artifact:"))}
                  columns={legacyColumns}
                  dataSource={legacySteps}
                  pagination={{ pageSize: 6 }}
                  rowSelection={{
                    type: "radio",
                    selectedRowKeys: selectedLegacyStep?.traceId ? [selectedLegacyStep.traceId] : []
                  }}
                  onRow={(legacyStep) => ({
                    onClick: () => {
                      const index = steps.findIndex((step) => step.traceId === legacyStep.traceId);
                      if (index >= 0) onSelectStep(index);
                    }
                  })}
                  locale={{ emptyText: <Empty description="当前 artifact 没有 legacy trajectory projection。" /> }}
                />
              </Space>
            </Card>
          </Space>
        </Card>
      </Col>
      <Col xs={24} xl={9}>
        <Card title="Step 详情">
          {selectedStep ? (
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              <Descriptions
                size="small"
                bordered
                column={1}
                items={descriptionItems([
                  ["native step", selectedStepIndex + 1],
                  ["scheduler turn", selectedStep.turnIndex],
                  ["trace", shortId(selectedStep.traceId)],
                  ["actor", selectedStep.actorId],
                  ["profile", selectedStep.profileId ?? "n/a"],
                  ["commit status", readSocialCommitStatus(selectedStep)],
                  ["failure stage", selectedStep.failure?.stage ?? (selectedStep.error ? "legacy_error" : "n/a")],
                  ["scheduler", selectedStep.schedulerMode],
                  ["batch", selectedStep.batchId ? shortId(selectedStep.batchId) : "n/a"],
                  ["batch index", selectedStep.batchIndex ?? "n/a"],
                  ["batch size", selectedStep.batchSize ?? "n/a"],
                  ["atomic", selectedStep.atomic ?? "n/a"],
                  ["resolution", selectedStep.resolutionPolicy ?? "n/a"],
                  ["pending", readSocialPendingKind(selectedStep)],
                  ["action", selectedStep.action.kind],
                  ["command", readSocialCommandType(selectedStep)],
                  ["pre hash", shortId(selectedStep.preStateHash)],
                  ["post hash", shortId(selectedStep.postStateHash)],
                  ["message seq", selectedStep.messageSeqRange ? rangeLabel(selectedStep.messageSeqRange) : "none"],
                  ["event seq", selectedStep.eventSeqRange ? rangeLabel(selectedStep.eventSeqRange) : "none"]
                ])}
              />
              <AgentDecisionEvidencePanel
                nativeStep={selectedStep}
                legacyStep={selectedLegacyStep}
                view={artifactView}
                journal={selectedDecisionJournal}
                shortId={shortId}
              />
              {canLoadSelectedReplayFrame ? (
                <Button
                  type="primary"
                  onClick={() => onSelectReplayFrame(selectedStepIndex)}
                  loading={replayFrameLoadState === "loading" && replayFrameCursorIndex === selectedStepIndex}
                  disabled={artifactView !== "postgame-redacted" || replayFrameLoadState === "loading"}
                >
                  定位服务端回放帧
                </Button>
              ) : artifactView === "postgame-redacted" ? (
                <Alert
                  type="info"
                  showIcon
                  message="当前行仅供审计"
                  description="该行位于原子 scheduler 批次中间。请通过上方游标跳转到该批次的最终行，以避免伪造中间局面。"
                />
              ) : null}
              {selectedStep.failure || selectedStep.error ? (
                <Alert
                  showIcon
                  type="error"
                  message={selectedStep.failure?.stage ?? "Rejected native step"}
                  description={selectedStep.failure?.message ?? selectedStep.error}
                />
              ) : null}
              {selectedLegacyStep ? (
                <Card size="small" title="Legacy committed projection" extra={<Tag color="warning">migration/debug only</Tag>}>
                  <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                    <Descriptions
                      size="small"
                      column={1}
                      items={descriptionItems([
                        ["legacy turn", selectedLegacyStep.turnIndex],
                        ["model", selectedLegacyStep.model],
                        ["command", readCommandType(selectedLegacyStep.command)],
                        ["attempts", selectedLegacyStep.reasonerOutput.attempts ?? "n/a"]
                      ])}
                    />
                    <Card size="small" title="Policy arbitration">
                      <Space direction="vertical" size="small" style={{ width: "100%" }}>
                        <Text strong>{selectedLegacyStep.policyPlan.intent}</Text>
                        <Text type="secondary">{selectedLegacyStep.policyPlan.strategyTags.join(" · ") || "no strategy tags"}</Text>
                        <Tag color="warning">private arbitration evidence redacted</Tag>
                      </Space>
                    </Card>
                    <Card size="small" title="Reasoner telemetry">
                      <Descriptions
                        size="small"
                        column={1}
                        items={descriptionItems([
                          ["latency", `${selectedLegacyStep.reasonerOutput.latencyMs}ms`],
                          ["prompt tokens", selectedLegacyStep.reasonerOutput.promptTokens ?? "n/a"],
                          ["completion tokens", selectedLegacyStep.reasonerOutput.completionTokens ?? "n/a"],
                          ["attempts", selectedLegacyStep.reasonerOutput.attempts ?? "n/a"]
                        ])}
                      />
                    </Card>
                  </Space>
                </Card>
              ) : (
                <Alert
                  showIcon
                  type="info"
                  message="No legacy projection row"
                  description="system 与 rejected 原生步骤不会伪造 legacy committed trajectory 记录。"
                />
              )}
              {artifactView === "postgame-redacted" && replay ? (
                <Card size="small" title="Replay validation">
                  <Descriptions
                    size="small"
                    column={1}
                    items={descriptionItems([
                      ["ok", String(Boolean(replay.summary?.ok))],
                      ["authority", replay.summary?.authority ?? "n/a"],
                      ["native steps", replay.summary?.nativeSteps ?? 0],
                      ["replayed steps", replay.summary?.replayedSteps ?? 0],
                      ["replayed batches", replay.summary?.replayedBatches ?? 0],
                      ["rejected skipped", replay.summary?.rejectedSteps ?? 0],
                      ["hash matches", String(replay.summary?.finalHashMatchesArtifact ?? replay.summary?.finalHashMatchesExpected ?? false)],
                      ["message hash matches", String(replay.summary?.messagesHashMatchesExpected ?? false)],
                      ["mismatches", replay.summary?.mismatchCount ?? 0]
                    ])}
                  />
                </Card>
              ) : null}
            </Space>
          ) : (
            <Empty description="没有选中 native step。加载 artifact 后点击左侧原生执行行。" />
          )}
        </Card>
      </Col>
    </Row>
  );
}

function SocietyWorkspace({
  artifact,
  agents,
  selectedAgent,
  messages,
  channels,
  onSelectAgent,
  onSelectMessage,
  onInspectExposure
}: {
  artifact: ProjectedMatchArtifact | null;
  agents: AgentHarnessState[];
  selectedAgent: AgentHarnessState | null;
  messages: SocialMessage[];
  channels: SocialChannel[];
  onSelectAgent: (agent: AgentHarnessState) => void;
  onSelectMessage: (message: SocialMessage) => void;
  onInspectExposure: (edge: SocialGraphExposureEdge) => void;
}) {
  const socialGraph = useMemo(
    () => (artifact ? buildSocialGraph(artifact) : { nodes: [], messageEdges: [], exposureEdges: [] }),
    [artifact]
  );
  const relationshipEdges = useMemo(() => agents.flatMap(readRelationshipRows), [agents]);
  const socialJournalRows = useMemo(() => readSocialJournalRows(agents), [agents]);
  const visibilityCounts = useMemo(() => countMessagesByVisibility(messages), [messages]);
  const agentActivityRows = useMemo(
    () =>
      socialGraph.nodes.map((node) => ({
        key: node.id,
        node,
        agent: agents.find((candidate) => candidate.playerId === node.id) ?? null,
        total: node.sent + node.received + node.observed
      })),
    [agents, socialGraph.nodes]
  );
  const maxAgentActivity = Math.max(1, ...agentActivityRows.map((row) => row.total));
  const totalExposureObservations = socialGraph.exposureEdges.reduce((sum, edge) => sum + edge.observations, 0);
  const speechActCount = messages.reduce((sum, message) => sum + (message.speechActs?.length ?? 0), 0);
  const deliveryReceiptCount = messages.reduce((sum, message) => sum + (message.deliveryReceipts?.length ?? 0), 0);
  const agentColumns: TableProps<AgentHarnessState>["columns"] = [
    { title: "agent", dataIndex: "playerId", render: (playerId: string) => <Text code>{playerId}</Text> },
    { title: "profile", dataIndex: "profileId", render: (value?: string) => value ?? "n/a" },
    { title: "policy", dataIndex: "policyName" },
    { title: "turns", dataIndex: "turns" },
    { title: "beliefs", render: (_, agent) => Object.keys(agent.beliefs ?? {}).length },
    {
      title: "查看",
      fixed: "right",
      width: 72,
      render: (_, agent) => (
        <Button type="link" size="small" aria-label={`查看 agent ${agent.playerId}`} onClick={() => onSelectAgent(agent)}>
          查看
        </Button>
      )
    }
  ];
  const agentActivityColumns: TableProps<(typeof agentActivityRows)[number]>["columns"] = [
    {
      title: "agent",
      render: (_, row) => (
        <Space size={4} wrap>
          <Text code>{row.node.id}</Text>
          {row.agent ? <Tag>{row.agent.policyName}</Tag> : null}
        </Space>
      )
    },
    { title: "flow", render: (_, row) => `${row.node.sent}/${row.node.received}/${row.node.observed}`, width: 92 },
    {
      title: "activity",
      render: (_, row) => <Progress percent={Math.round((row.total / maxAgentActivity) * 100)} showInfo={false} />,
      width: 120
    },
    {
      title: "",
      align: "right",
      render: (_, row) =>
        row.agent ? (
          <Button type="link" size="small" onClick={() => onSelectAgent(row.agent!)}>
            查看
          </Button>
        ) : null
    }
  ];
  const exposureColumns: TableProps<SocialGraphExposureEdge>["columns"] = [
    { title: "source", dataIndex: "sourceId", render: (sourceId: string) => <Text code>{sourceId}</Text> },
    { title: "observer", dataIndex: "targetId", render: (targetId: string) => <Text code>{targetId}</Text> },
    { title: "channel", dataIndex: "channelId" },
    { title: "visibility", dataIndex: "visibility", render: (visibility: SocialMessage["visibility"]) => <VisibilityTag visibility={visibility} /> },
    { title: "kind", dataIndex: "kind", render: (kind?: string) => kind ?? "message" },
    { title: "observed", dataIndex: "observations", sorter: (a, b) => a.observations - b.observations },
    { title: "traces", render: (_, edge) => edge.traceIds.map(shortId).join(", ") || "n/a" }
  ];
  const channelColumns: TableProps<SocialChannel>["columns"] = [
    { title: "channel", dataIndex: "id", render: (channelId: string) => <Text code>{channelId}</Text> },
    { title: "kind", dataIndex: "kind", render: (kind: SocialChannel["kind"]) => <Tag>{kind}</Tag> },
    { title: "readable", dataIndex: "readableBy" },
    { title: "participants", render: (_, channel) => channel.participantIds.length },
    { title: "messages", render: (_, channel) => messages.filter((message) => message.channelId === channel.id).length }
  ];
  const messageColumns: TableProps<SocialMessage>["columns"] = [
    { title: "#", dataIndex: "seq", width: 72 },
    { title: "channel", dataIndex: "channelId" },
    { title: "sender", dataIndex: "senderId", render: (senderId: string) => <Text code>{senderId}</Text> },
    { title: "visibility", dataIndex: "visibility", render: (visibility: SocialMessage["visibility"]) => <VisibilityTag visibility={visibility} /> },
    { title: "acts", width: 72, render: (_, message) => message.speechActs?.length ?? 0 },
    { title: "receipts", width: 92, render: (_, message) => message.deliveryReceipts?.length ?? 0 },
    { title: "content", dataIndex: "content", ellipsis: true },
    {
      title: "查看",
      fixed: "right",
      width: 72,
      render: (_, message) => (
        <Button type="link" size="small" aria-label={`查看消息 ${message.seq}`} onClick={() => onSelectMessage(message)}>
          查看
        </Button>
      )
    }
  ];
  const relationshipColumns: TableProps<ReturnType<typeof readRelationshipRows>[number]>["columns"] = [
    { title: "owner", dataIndex: "owner", render: (owner: string) => <Text code>{owner}</Text> },
    { title: "target", dataIndex: "target", render: (target: string) => <Text code>{target}</Text> },
    { title: "trust", dataIndex: "trust" },
    { title: "suspicion", dataIndex: "suspicion" },
    { title: "evidence", dataIndex: "evidence" }
  ];
  const journalColumns: TableProps<SocialJournalRow>["columns"] = [
    { title: "#", dataIndex: "journalSeq", width: 72 },
    { title: "agent", dataIndex: "owner", render: (owner: string) => <Text code>{owner}</Text> },
    { title: "store", dataIndex: "store", render: (store: string) => <Tag>{store}</Tag> },
    { title: "mutation", dataIndex: "mutationKind" },
    { title: "subject", dataIndex: "subjectId", render: (subjectId?: string) => subjectId ?? "n/a" },
    { title: "trace", dataIndex: "traceId", render: (traceId?: string) => (traceId ? <Text code>{shortId(traceId)}</Text> : "n/a") },
    { title: "hidden truth", dataIndex: "hiddenTruthUsed", render: (value: false) => <Tag color={value ? "error" : "success"}>{String(value)}</Tag> },
    { title: "evidence", dataIndex: "evidenceCount" }
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="agents" value={agents.length} prefix={<TeamOutlined />} suffix={<Text type="secondary">social actors</Text>} />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="messages" value={messages.length} prefix={<MessageOutlined />} suffix={<Text type="secondary">{channels.length} channels</Text>} />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="observed exposure" value={totalExposureObservations} prefix={<EyeOutlined />} suffix={<Text type="secondary">{socialGraph.exposureEdges.length} edges</Text>} />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="relationship evidence" value={relationshipEdges.length} prefix={<BranchesOutlined />} suffix={<Text type="secondary">{socialJournalRows.length} journal rows</Text>} />
          </Card>
        </Col>
      </Row>

      <SocialEvidenceGraph
        graph={socialGraph}
        selectedAgentId={selectedAgent?.playerId}
        onSelectAgent={(agentId) => {
          const agent = agents.find((candidate) => candidate.playerId === agentId);
          if (agent) onSelectAgent(agent);
        }}
        onSelectExposure={onInspectExposure}
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={8}>
          <Card
            title="Agent 活动画像"
            extra={
              <Space size={4} wrap>
                <Tag color="success">public {visibilityCounts.public}</Tag>
                <Tag color="processing">team {visibilityCounts.team}</Tag>
                <Tag color="warning">private {visibilityCounts.private}</Tag>
              </Space>
            }
          >
            <Table
              rowKey="key"
              size="small"
              bordered
              columns={agentActivityColumns}
              dataSource={agentActivityRows}
              pagination={{ pageSize: 5 }}
              locale={{ emptyText: <Empty description="当前 artifact 不包含 agent 社会状态。" /> }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={16}>
          <Card title="可见性 / 影响边" extra={<Tag>server exposure projection</Tag>}>
            <Table
              rowKey={(edge) => `${edge.sourceId}-${edge.targetId}-${edge.channelId}-${edge.kind ?? "message"}`}
              size="small"
              bordered
              columns={exposureColumns}
              dataSource={socialGraph.exposureEdges}
              pagination={{ pageSize: 6 }}
              expandable={{
                expandedRowRender: (edge) => (
                  <Space direction="vertical" size={4}>
                    <Text type="secondary">这些边来自服务端投影的 scoped exposure records，而不是 recipient envelope 猜测。</Text>
                    {edge.evidenceLabels.map((label) => (
                      <Text key={label} code>
                        {label}
                      </Text>
                    ))}
                  </Space>
                )
              }}
              locale={{ emptyText: <Empty description="当前 artifact 没有可见性 exposure 记录。" /> }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xxl={10}>
          <Card title="Agent 社会状态" extra={<Tag>artifact agents</Tag>}>
            <Table
              rowKey="playerId"
              size="small"
              bordered
              columns={agentColumns}
              dataSource={agents}
              pagination={{ pageSize: 6 }}
              rowSelection={{ type: "radio", selectedRowKeys: selectedAgent?.playerId ? [selectedAgent.playerId] : [] }}
              onRow={(agent) => ({ onClick: () => onSelectAgent(agent) })}
              locale={{ emptyText: <Empty description="当前 artifact 不包含 agent 社会状态。" /> }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12} xxl={7}>
          <Card title="选中 Agent" extra={<RobotOutlined />}>
            {selectedAgent ? (
              <Descriptions
                size="small"
                bordered
                column={1}
                items={descriptionItems([
                  ["agent", selectedAgent.playerId],
                  ["model", selectedAgent.model],
                  ["policy", selectedAgent.policyName],
                  ["observations", selectedAgent.observations],
                  ["memos", selectedAgent.privateMemos.length],
                  ["relationships", Object.keys(selectedAgent.social?.relationships?.edges ?? {}).length],
                  ["journal", selectedAgent.social?.journal?.entries.length ?? 0],
                  ["last intent", selectedAgent.lastIntent ?? "n/a"],
                  ["social hash", selectedAgent.socialStateHash ? shortId(selectedAgent.socialStateHash) : "n/a"]
                ])}
              />
            ) : (
              <Empty description="点击 agent 行查看证据。" />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={12} xxl={7}>
          <Card title="通道拓扑" extra={<Tag>{artifact ? `${channels.length} channels` : "尚未加载 artifact"}</Tag>}>
            <Table
              rowKey="id"
              size="small"
              bordered
              columns={channelColumns}
              dataSource={channels}
              pagination={{ pageSize: 6 }}
              locale={{ emptyText: <Empty description="当前 artifact 没有 channel。" /> }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xxl={13}>
          <Card
            title="通信消息"
            extra={
              artifact ? (
                <Space size={4} wrap>
                  <Tag>{messages.length} messages</Tag>
                  <Tag color="processing">{speechActCount} acts</Tag>
                  <Tag color="success">{deliveryReceiptCount} receipts</Tag>
                </Space>
              ) : (
                <Tag>尚未加载 artifact</Tag>
              )
            }
          >
            <Table
              rowKey="id"
              size="small"
              bordered
              columns={messageColumns}
              dataSource={messages}
              pagination={{ pageSize: 8 }}
              onRow={(message) => ({ onClick: () => onSelectMessage(message) })}
              locale={{ emptyText: <Empty description="当前 artifact 没有记录 public/team/private message。" /> }}
            />
          </Card>
        </Col>
        <Col xs={24} xxl={11}>
          <Card title="关系 / 声誉边" extra={<Tag>evidence only</Tag>}>
            <Table
              rowKey={(edge) => `${edge.owner}-${edge.target}`}
              size="small"
              bordered
              columns={relationshipColumns}
              dataSource={relationshipEdges}
              pagination={{ pageSize: 6 }}
              locale={{ emptyText: <Empty description="artifact 中未记录 relationships.edges。" /> }}
            />
          </Card>
        </Col>
      </Row>

      <Card title="社会状态变更日志" extra={<Tag>journal</Tag>}>
        <Table
          rowKey="key"
          size="small"
          bordered
          columns={journalColumns}
          dataSource={socialJournalRows}
          pagination={{ pageSize: 8 }}
          locale={{ emptyText: <Empty description="artifact 中未记录 social-state journal entries。" /> }}
        />
      </Card>
    </Space>
  );
}

function LineageWorkspace({
  currentMatchId,
  checkpoints,
  selectedCheckpointId,
  forkLineage,
  branchTree,
  busy,
  onRefreshCheckpoints,
  onCreateCheckpoint,
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
  busy: string | null;
  onRefreshCheckpoints: () => void;
  onCreateCheckpoint: () => void;
  onLoadForkLineage: () => void;
  onSelectCheckpoint: (checkpoint: CheckpointSummary) => void;
  onLoadBranchTree: (checkpointId?: string) => void;
  onInspectCheckpoint: (checkpoint: CheckpointSummary) => void;
  onInspectForkLineage: () => void;
  onInspectBranchTree: () => void;
}) {
  const selectedCheckpoint = checkpoints.find((checkpoint) => checkpoint.checkpointId === selectedCheckpointId) ?? null;
  const checkpointColumns: TableProps<CheckpointSummary>["columns"] = [
    {
      title: "checkpoint",
      fixed: "left",
      render: (_, checkpoint) => (
        <Button type="link" size="small" onClick={() => onInspectCheckpoint(checkpoint)}>
          <Text code>{shortId(checkpoint.checkpointId)}</Text>
        </Button>
      )
    },
    { title: "created", dataIndex: "createdAt", render: (value: string) => formatDate(value) },
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
            aria-label={`选择 checkpoint ${shortId(checkpoint.checkpointId)}`}
            onClick={() => onSelectCheckpoint(checkpoint)}
          >
            选择
          </Button>
          <Button
            size="small"
            icon={decorativeIcon(<BranchesOutlined />)}
            loading={busy === "branch-tree" && selectedCheckpointId === checkpoint.checkpointId}
            aria-label={`加载 checkpoint ${shortId(checkpoint.checkpointId)} 的 branch tree`}
            onClick={() => onLoadBranchTree(checkpoint.checkpointId)}
          >
            Tree
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
          aria-label={`查看 checkpoint ${shortId(checkpoint.checkpointId)} 证据`}
          onClick={() => onInspectCheckpoint(checkpoint)}
        >
          证据
        </Button>
      )
    }
  ];

  const checkpointNodeColumns: TableProps<NonNullable<BranchTreeSummary["checkpoints"]>[number]>["columns"] = [
    { title: "depth", dataIndex: "depth", width: 72 },
    { title: "checkpoint", dataIndex: "checkpointId", render: (value?: string) => <Text code>{shortId(value)}</Text> },
    { title: "created", dataIndex: "createdAt", render: (value?: string) => (value ? formatDate(value) : "n/a") },
    { title: "child forks", dataIndex: "childForkCount", render: (value?: number) => value ?? 0 },
    { title: "native steps", render: (_, node) => node.summary?.counts.nativeSteps ?? "n/a" },
    { title: "messages", render: (_, node) => node.summary?.counts.socialMessages ?? "n/a" }
  ];
  const matchNodeColumns: TableProps<NonNullable<BranchTreeSummary["matches"]>[number]>["columns"] = [
    { title: "depth", dataIndex: "depth", width: 72 },
    { title: "run", dataIndex: "runId", render: (value?: string) => <Text code>{shortId(value)}</Text> },
    { title: "match", dataIndex: "matchId", render: (value?: string | null) => (value ? <Text code>{shortId(value)}</Text> : "n/a") },
    { title: "status", dataIndex: "status", render: (value?: string) => (value ? <StatusTag status={value} /> : "n/a") },
    { title: "native steps", dataIndex: "nativeStepCount", render: (value?: number) => value ?? 0 },
    { title: "messages", dataIndex: "socialMessages", render: (value?: number) => value ?? 0 },
    {
      title: "boundary",
      render: (_, node) => <BoundaryTag status={node.lineage?.boundary?.status} ok={node.lineage?.ok} />
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

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="checkpoints" value={checkpoints.length} prefix={<DatabaseOutlined />} suffix={<Text type="secondary">{currentMatchId ? shortId(currentMatchId) : "未选择"}</Text>} />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="selected prefix" value={selectedCheckpoint?.counts.nativeSteps ?? 0} prefix={<BranchesOutlined />} suffix={<Text type="secondary">native steps</Text>} />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="fork lineage" value={forkLineage ? (forkLineage.isFork ? "fork" : "root") : "pending"} prefix={<ApiOutlined />} suffix={<Text type="secondary">{forkLineage?.boundary?.status ?? "未加载"}</Text>} />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="branch tree" value={branchTree?.counts?.edges ?? 0} prefix={<BranchesOutlined />} suffix={<Text type="secondary">{branchTree?.counts?.matches ?? 0} matches</Text>} />
          </Card>
        </Col>
      </Row>

      <Card
        title="Checkpoint Registry"
        extra={
          <Space wrap>
            <Button icon={decorativeIcon(<ReloadOutlined />)} loading={busy === "checkpoints"} disabled={!currentMatchId || Boolean(busy)} onClick={onRefreshCheckpoints}>
              刷新 checkpoint
            </Button>
            <Button type="primary" icon={decorativeIcon(<DatabaseOutlined />)} loading={busy === "checkpoint:create"} disabled={!currentMatchId || Boolean(busy)} onClick={onCreateCheckpoint}>
              创建 checkpoint
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Text type="secondary">列表来自 `/api/checkpoints?matchId=...`，只展示 summary，不读取 full checkpoint artifact。</Text>
          <Table
            rowKey="checkpointId"
            size="small"
            bordered
            columns={checkpointColumns}
            dataSource={checkpoints}
            pagination={{ pageSize: 6 }}
            rowSelection={{
              type: "radio",
              selectedRowKeys: selectedCheckpointId ? [selectedCheckpointId] : []
            }}
            onRow={(checkpoint) => ({ onClick: () => onSelectCheckpoint(checkpoint) })}
            scroll={{ x: 1180 }}
            locale={{ emptyText: <Empty description="当前 run 没有 checkpoint。点击“创建 checkpoint”会调用真实服务端 API。" /> }}
          />
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={10}>
          <Card
            title="Fork Lineage"
            extra={
              <Space wrap>
                {forkLineage ? <BoundaryTag status={forkLineage.boundary?.status} ok={forkLineage.ok} /> : <Tag>未加载</Tag>}
                <Button icon={decorativeIcon(<ApiOutlined />)} loading={busy === "fork-lineage"} disabled={!currentMatchId || Boolean(busy)} onClick={onLoadForkLineage}>
                  加载 lineage
                </Button>
                <Button icon={decorativeIcon(<CodeOutlined />)} disabled={!forkLineage} onClick={onInspectForkLineage}>
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
        <Col xs={24} xl={14}>
          <Card
            title="Branch Tree Summary"
            extra={
              <Space wrap>
                {branchTree ? <Tag color={branchTree.truncation?.isTruncated ? "warning" : "success"}>{branchTree.truncation?.isTruncated ? "truncated" : "complete"}</Tag> : <Tag>未加载</Tag>}
                <Button
                  icon={decorativeIcon(<BranchesOutlined />)}
                  loading={busy === "branch-tree"}
                  disabled={!selectedCheckpointId || Boolean(busy)}
                  onClick={() => onLoadBranchTree(selectedCheckpointId)}
                >
                  加载 branch tree
                </Button>
                <Button icon={decorativeIcon(<CodeOutlined />)} disabled={!branchTree} onClick={onInspectBranchTree}>
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
                  pagination={{ pageSize: 6 }}
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
                  pagination={{ pageSize: 6 }}
                  locale={{ emptyText: <Empty description="branch tree 尚未返回 forked match nodes。" /> }}
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
                  pagination={{ pageSize: 6 }}
                  locale={{ emptyText: <Empty description="branch tree 尚未返回 edges。" /> }}
                />
              )
            }
          ]}
        />
      </Card>
    </Space>
  );
}

function EvaluationWorkspace({
  artifact,
  metrics,
  warnings,
  onInspectMetric,
  onInspectWarning
}: {
  artifact: ProjectedMatchArtifact | null;
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

function CompareWorkspace({
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
  const activeFilter = {
    group: groupFilter,
    changedOnly,
    promotion: promotionFilter,
    evidenceIdentity: evidenceIdentityFilter,
    numericDelta: numericDeltaFilter
  } as const;
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
  const filteredProjection = currentComparison
    ? projectFilteredMatchComparison(currentComparison, activeFilter, {
        createdAt: currentComparison.createdAt
      })
    : null;
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
  const rowColumns: TableProps<MatchComparisonRow>["columns"] = [
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
    { title: "baseline", dataIndex: "baseline", render: (value: unknown) => formatValue(value) },
    { title: "candidate", dataIndex: "candidate", render: (value: unknown) => formatValue(value) },
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
  ];
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
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
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
            message={pendingReason}
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
            message="对比已就绪"
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
            options={[
              { value: "all", label: "全部 group" },
              { value: "summary", label: "summary" },
              { value: "metric", label: "metric" },
              { value: "metric_evidence", label: "metric evidence" }
            ]}
            onChange={(value) => setGroupFilter(value as "all" | MatchComparisonRowGroup)}
          />
          <Select
            aria-label="对比 promotion 过滤"
            style={{ minWidth: 200 }}
            value={promotionFilter}
            disabled={pendingComparison || !currentComparison}
            options={[
              { value: "all", label: "全部 promotion" },
              { value: "changed", label: "promotion 变化" },
              { value: "scorecard", label: "含 scorecard" },
              { value: "diagnostic", label: "含 diagnostic" },
              { value: "benchmark_only", label: "含 benchmark_only" },
              { value: "missing", label: "含 missing" }
            ]}
            onChange={(value) => setPromotionFilter(value as MatchComparisonPromotionFilter)}
          />
          <Select
            aria-label="对比 evidence identity 过滤"
            style={{ minWidth: 220 }}
            value={evidenceIdentityFilter}
            disabled={pendingComparison || !currentComparison}
            options={[
              { value: "all", label: "全部 evidence identity" },
              { value: "changed", label: "evidence identity 变化" }
            ]}
            onChange={(value) =>
              setEvidenceIdentityFilter(value as MatchComparisonEvidenceIdentityFilter)
            }
          />
          <Select
            aria-label="对比 numeric delta 过滤"
            style={{ minWidth: 200 }}
            value={numericDeltaFilter}
            disabled={pendingComparison || !currentComparison}
            options={[
              { value: "all", label: "全部 numeric delta" },
              { value: "changed", label: "numeric delta 变化" }
            ]}
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
          pagination={{ pageSize: 10 }}
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
}

function ExperimentsWorkspace({
  result,
  artifactSets,
  games,
  exportArtifacts,
  exportAvailable,
  selectedModel,
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
  selectedModel: string;
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
    { title: "elapsed", dataIndex: "elapsedMs", render: (value: number) => `${value}ms`, responsive: ["lg"] },
    { title: "error", dataIndex: "error", render: (value?: string | null) => value ?? "—", responsive: ["lg"] }
  ];
  const statColumns: TableProps<ExperimentMatrixSubjectStat>["columns"] = [
    { title: "subject", dataIndex: "subjectId", render: (value: string) => <Text code>{value}</Text> },
    { title: "model", dataIndex: "model", render: (value?: string) => value ?? "—" },
    { title: "policy", dataIndex: "policyName", render: (value?: string) => value ?? "—", responsive: ["lg"] },
    { title: "seats", dataIndex: "seatGames", align: "right" },
    { title: "wins/losses", render: (_, row) => `${row.wins}/${row.losses}` },
    { title: "win rate", dataIndex: "winRate", render: (value: number) => `${(value * 100).toFixed(1)}%` },
    { title: "mean reward", dataIndex: "rewardMean", render: (value: number) => value.toFixed(3), responsive: ["md"] }
  ];
  const comparisonColumns: TableProps<ExperimentMatrixPairwiseComparison>["columns"] = [
    { title: "left", dataIndex: "leftModel", render: (value: string) => <Text code>{value}</Text> },
    { title: "right", dataIndex: "rightModel", render: (value: string) => <Text code>{value}</Text> },
    { title: "seat rows", render: (_, row) => `${row.leftSeatGames}/${row.rightSeatGames}` },
    { title: "Δ win rate", dataIndex: "winRateDiff", render: (value: number) => value.toFixed(4) },
    { title: "p / Holm", render: (_, row) => `${formatMatrixPValue(row.pValueTwoSided)} / ${formatMatrixPValue(row.pValueHolm)}` },
    { title: "boundary", dataIndex: "warning", render: (value: string) => <Text type="secondary">{value}</Text>, responsive: ["xl"] }
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="实验矩阵控制面"
        extra={
          <Space wrap>
            <Select
              aria-label="矩阵游戏局数"
              style={{ width: 120 }}
              value={games}
              disabled={Boolean(busy)}
              options={["1", "2", "3", "5"].map((value) => ({ value, label: `${value} games` }))}
              onChange={onGamesChange}
            />
            <Select
              aria-label="导出矩阵研究工件"
              style={{ width: 190 }}
              value={exportArtifacts ? "export" : "summary"}
              disabled={Boolean(busy) || !exportAvailable}
              options={[
                { value: "summary", label: "仅返回服务端摘要" },
                { value: "export", label: "导出本地研究工件" }
              ]}
              onChange={(value) => onExportArtifactsChange(value === "export")}
            />
            <Button icon={decorativeIcon(<ReloadOutlined />)} loading={busy === "matrix-artifacts"} disabled={Boolean(busy)} onClick={onRefreshArtifacts}>
              刷新研究工件
            </Button>
            <Button
              type="primary"
              icon={decorativeIcon(<ExperimentOutlined />)}
              loading={busy === "matrix-run"}
              disabled={!selectedModel || Boolean(busy)}
              onClick={onRun}
            >
              运行矩阵
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          <Text type="secondary">
            该工作区提交 `POST /api/experiments/matrix/run`，由 harness 调度 cell 与 tournament；当前选择 model={selectedModel || "n/a"}
            、games={games}、maxTransitions={maxTransitions || "n/a"}、timeout={timeoutSeconds || "n/a"}s。
          </Text>
          <Text type="secondary">
            completed、truncated、failed 是不同的生命周期。截断仍保留在状态分母中，但不进入胜率、奖励或 scorecard 分母。
            {exportAvailable ? " 导出的内容为仅本地可读的 research artifact，不会进入公开分享路径。" : " 当前未配置研究工件目录，因此只能运行并查看服务端摘要。"}
          </Text>
          <Alert
            type="info"
            showIcon
            message="模型比较只作描述性筛选"
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
          ["failed", summary?.gamesFailed ?? statistics?.status?.gamesFailed ?? 0]
        ].map(([label, value]) => (
          <Col xs={12} md={6} key={String(label)}>
            <Card size="small">
              <Statistic title={String(label)} value={Number(value)} valueStyle={{ color: label === "failed" ? "#cf1322" : label === "truncated" ? "#d48806" : undefined }} />
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
          pagination={{ pageSize: 6 }}
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
              pagination={{ pageSize: 6 }}
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
              pagination={{ pageSize: 6 }}
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
          pagination={{ pageSize: 6 }}
          locale={{ emptyText: <Empty description="需要至少两个有 completed outcome rows 的模型。" /> }}
        />
      </Card>

      <Card title="本地研究工件注册表" extra={<Tag>{artifactSets.length} sets</Tag>}>
        <Table
          rowKey="artifactSetId"
          size="small"
          bordered
          columns={[
            { title: "set", dataIndex: "artifactSetId", render: (value: string) => <Text code>{shortId(value)}</Text> },
            { title: "matrix", dataIndex: "matrixId", ellipsis: true },
            { title: "created", dataIndex: "createdAt", render: (value: string) => formatDate(value) },
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
          ]}
          dataSource={artifactSets}
          pagination={{ pageSize: 6 }}
          locale={{ emptyText: <Empty description="未注册矩阵研究工件。工件只能由服务端注册并提供下载 URL。" /> }}
        />
      </Card>
    </Space>
  );
}

function PacksWorkspace({
  packs,
  selectedPackId,
  shares,
  shareInventory,
  shareLabel,
  packGames,
  shareExpiresInHours,
  shareAllowlist,
  busy,
  selectedModel,
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
  selectedPackId: string;
  shares: TournamentPublicShareSummary[];
  shareInventory: TournamentPublicShareInventory | null;
  shareLabel: string;
  packGames: string;
  shareExpiresInHours: string;
  shareAllowlist: string[];
  busy: string | null;
  selectedModel: string;
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
  const availableFiles = flattenTournamentPackFiles(selectedPack?.files);
  const packColumns: TableProps<TournamentArtifactSetSummary>["columns"] = [
    {
      title: "artifact set",
      render: (_, pack) => (
        <Button type="link" size="small" onClick={() => onSelectPack(pack)}>
          <Text code>{shortId(pack.artifactSetId)}</Text>
        </Button>
      )
    },
    { title: "created", dataIndex: "createdAt", render: (value: string) => formatDate(value) },
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
  ];
  const shareColumns: TableProps<TournamentPublicShareSummary>["columns"] = [
    {
      title: "share",
      render: (_, share) => (
        <Button type="link" size="small" onClick={() => onInspectShare(share)}>
          <Text code>{shortId(share.shareId)}</Text>
        </Button>
      )
    },
    { title: "label", dataIndex: "label", render: (value?: string | null) => value ?? "n/a" },
    { title: "created", dataIndex: "createdAt", render: (value: string) => formatDate(value) },
    { title: "expires", dataIndex: "expiresAt", render: (value: string | null) => (value ? formatDate(value) : "never") },
    {
      title: "files",
      render: (_, share) => (share.relativeFiles?.length ? `${share.relativeFiles.length} files` : "all")
    },
    {
      title: "usage",
      render: (_, share) => (
        <Space direction="vertical" size={0}>
          <Text type="secondary">views {share.analytics?.detailViewCount ?? 0}</Text>
          <Text type="secondary">downloads {share.analytics?.downloadCount ?? 0}</Text>
        </Space>
      )
    },
    {
      title: "promotion",
      render: (_, share) => (
        <Text type="secondary">
          {formatPackMetricPromotion({
            metricCount: share.packMetricPromotion?.metricCount,
            scorecardEligibleMetricCount: share.packMetricPromotion?.scorecardEligibleMetricCount,
            metricPromotionClassCounts: share.packMetricPromotion?.metricPromotionClassCounts
          })}
        </Text>
      )
    },
    {
      title: "density",
      render: (_, share) => (
        <Text type="secondary">
          {formatPackCommitDensity({
            nativeSteps: share.packDensity?.nativeSteps,
            committedSteps: share.packDensity?.committedSteps,
            rejectedSteps: share.packDensity?.rejectedSteps
          })}
        </Text>
      )
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
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="锦标赛公开包"
        extra={
          <Space wrap>
            <Select
              style={{ width: 120 }}
              value={packGames}
              options={[
                { value: "1", label: "1 game" },
                { value: "2", label: "2 games" },
                { value: "3", label: "3 games" },
                { value: "5", label: "5 games" }
              ]}
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
              disabled={!selectedModel || Boolean(busy)}
              onClick={onExport}
            >
              导出公开包
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          <Text type="secondary">
            导出调用 `POST /api/tournaments/run` 且 `exportArtifacts=true`，服务端写入 truth-redacted 公开包。当前控件：model=
            {selectedModel || "n/a"} · games={packGames || "2"} · maxTransitions={maxTransitions || "n/a"} · timeout=
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
          pagination={{ pageSize: 6 }}
          rowSelection={{
            type: "radio",
            selectedRowKeys: selectedPackId ? [selectedPackId] : []
          }}
          onRow={(pack) => ({ onClick: () => onSelectPack(pack) })}
          locale={{ emptyText: <Empty description="暂无锦标赛公开包。点击“导出公开包”运行真实锦标赛导出。" /> }}
        />
      </Card>

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
          <Space direction="vertical" size="small" style={{ width: "100%" }}>
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
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
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
              options={[
                { value: "0", label: "永不过期" },
                { value: "1", label: "1 小时后" },
                { value: "24", label: "24 小时后" },
                { value: "168", label: "7 天后" }
              ]}
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
            options={availableFiles.map((file) => ({ value: file, label: file }))}
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
            pagination={{ pageSize: 6 }}
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
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
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
            pagination={{ pageSize: 6 }}
            columns={[
              {
                title: "share",
                render: (_: unknown, share: TournamentPublicShareSummary) => (
                  <Button type="link" size="small" onClick={() => onInspectShare(share)}>
                    <Text code>{shortId(share.shareId)}</Text>
                  </Button>
                )
              },
              { title: "label", dataIndex: "label", render: (value?: string | null) => value ?? "n/a" },
              {
                title: "pack",
                render: (_: unknown, share: TournamentPublicShareSummary) => (
                  <Space direction="vertical" size={0}>
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
                    <Space direction="vertical" size={0}>
                      <Text type="secondary">views {share.analytics?.detailViewCount ?? 0}</Text>
                      <Text type="secondary">downloads {share.analytics?.downloadCount ?? 0}</Text>
                      <Text type="secondary">{topFiles.length ? topFiles.join(", ") : share.analytics?.lastDownloadedFile ?? "no downloads"}</Text>
                      <Text type="secondary">{recentMinutes.length ? `min ${recentMinutes.join(", ")}` : "no minute series"}</Text>
                    </Space>
                  );
                }
              },
              {
                title: "promotion",
                render: (_: unknown, share: TournamentPublicShareSummary) => (
                  <Text type="secondary">
                    {formatPackMetricPromotion({
                      metricCount: share.packMetricPromotion?.metricCount,
                      scorecardEligibleMetricCount: share.packMetricPromotion?.scorecardEligibleMetricCount,
                      metricPromotionClassCounts: share.packMetricPromotion?.metricPromotionClassCounts
                    })}
                  </Text>
                )
              },
              {
                title: "density",
                render: (_: unknown, share: TournamentPublicShareSummary) => (
                  <Text type="secondary">
                    {formatPackCommitDensity({
                      nativeSteps: share.packDensity?.nativeSteps,
                      committedSteps: share.packDensity?.committedSteps,
                      rejectedSteps: share.packDensity?.rejectedSteps
                    })}
                  </Text>
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
}

function ArtifactSummary({ title, artifact }: { title: string; artifact: ProjectedMatchArtifact | null }) {
  const screens = Grid.useBreakpoint();
  const truthRedacted = artifact?.projection?.postgameTruthRedacted === true;
  const projectionDetail = artifact?.projection
    ? `private ${artifact.projection.privateEvidenceRedacted ? "redacted" : "visible"} · truth ${truthRedacted ? "redacted" : "visible"}`
    : null;
  return (
    <Card
      size="small"
      title={title}
      extra={
        artifact?.projection ? (
          <Tooltip title={projectionDetail}>
            <Tag color={truthRedacted ? "warning" : "processing"}>
              {screens.sm ? `${artifact.projection.view} · ${projectionDetail}` : artifact.projection.view}
            </Tag>
          </Tooltip>
        ) : (
          <Tag>empty</Tag>
        )
      }
    >
      {artifact ? (
        <Descriptions
          size="small"
          column={1}
          items={descriptionItems([
            ["run", shortId(artifact.runId)],
            ["status", artifact.status],
            ["projection", projectionDetail ?? "n/a"],
            ["seed", artifact.seed],
            ["models", artifact.models.join(", ") || "n/a"],
            ["native steps", countSocialStepCommits(artifact.socialEpisode.steps).nativeSteps],
            ["committed steps", countSocialStepCommits(artifact.socialEpisode.steps).committedSteps],
            ["rejected steps", countSocialStepCommits(artifact.socialEpisode.steps).rejectedSteps],
            ["legacy projection", artifact.trajectory.length],
            ["messages", artifact.socialEpisode.messages.length],
            ["metrics", artifact.evaluationReport.metricCount ?? 0],
            ["winner", truthRedacted ? "[redacted]" : artifact.finalState.winner ?? "n/a"]
          ])}
        />
      ) : (
        <Empty description="对比前需要一个真实 match artifact。" />
      )}
    </Card>
  );
}

function InspectorPanel({
  item,
  onOpenRaw,
  artifactView
}: {
  item: InspectorItem | null;
  onOpenRaw: () => void;
  artifactView: ArtifactView;
}) {
  return (
    <Flex vertical gap="middle" style={{ padding: 16 }}>
      <Flex justify="space-between" align="center">
        <Space>
          <CodeOutlined />
          <Text strong>Evidence Inspector</Text>
        </Space>
        <Tag>{artifactView}</Tag>
      </Flex>
      <Text type="secondary">点击 run、step、agent、message、metric 或 compare row 查看证据。</Text>
      {item ? (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Card size="small">
            <Space direction="vertical" size={4}>
              <Text strong>{item.title}</Text>
              <Text type="secondary">{item.subtitle ?? item.kind}</Text>
            </Space>
          </Card>
          <Descriptions
            size="small"
            bordered
            column={1}
            labelStyle={{ width: 96 }}
            contentStyle={{ maxWidth: 240, minWidth: 0 }}
            items={descriptionItems(item.fields)}
          />
          {item.actions?.length ? (
            <Space direction="vertical" size="small" style={{ width: "100%" }}>
              <Text type="secondary">服务端证据动作</Text>
              {item.actions.map((action) => (
                <Button
                  key={action.key}
                  block
                  size="small"
                  disabled={action.disabled}
                  onClick={action.onClick}
                >
                  {action.label}
                </Button>
              ))}
            </Space>
          ) : null}
          <Button block icon={decorativeIcon(<CodeOutlined />)} onClick={onOpenRaw}>
            查看原始片段
          </Button>
        </Space>
      ) : (
        <Empty description="左侧表格和时间线中的每次点击都会更新这里。" />
      )}
    </Flex>
  );
}

function StatusTag({ status }: { status: string }) {
  if (status === "failed") return <Tag color="error">failed</Tag>;
  if (status === "completed") return <Tag color="success">completed</Tag>;
  if (status === "running") return <Badge status="processing" text="running" />;
  return <Tag>{status}</Tag>;
}

function CommitStatusTag({ status }: { status: "committed" | "rejected" }) {
  return <Tag color={status === "committed" ? "success" : "error"}>{status}</Tag>;
}

function VisibilityTag({ visibility }: { visibility: SocialMessage["visibility"] }) {
  const color = visibility === "public" ? "success" : visibility === "team" ? "processing" : visibility === "private" ? "warning" : "default";
  return <Tag color={color}>{visibility}</Tag>;
}

function SchedulerTag({ mode }: { mode?: ProjectedSocialStep["schedulerMode"] }) {
  if (mode === "aec-batched-decision") return <Tag color="processing">batched</Tag>;
  if (mode === "parallel") return <Tag color="warning">parallel</Tag>;
  if (mode === "aec") return <Tag color="success">aec</Tag>;
  return <Tag>n/a</Tag>;
}

function BoundaryTag({ status, ok }: { status?: string; ok?: boolean }) {
  if (!status) return <Tag>n/a</Tag>;
  const color = ok === false || status === "mismatch" ? "error" : status === "not_fork" ? "default" : "success";
  return <Tag color={color}>{status}</Tag>;
}

function SeverityTag({ severity }: { severity: HarnessEvaluationWarning["severity"] }) {
  return <Tag color={severity === "warning" ? "warning" : "default"}>{severity}</Tag>;
}

function decorativeIcon(icon: ReactNode): ReactNode {
  return <span aria-hidden="true">{icon}</span>;
}

function descriptionItems(rows: Array<[string, unknown]>): DescriptionsProps["items"] {
  return rows.map(([key, value]) => ({
    key,
    label: key,
    children: <InspectorValue value={value} />
  }));
}

function InspectorValue({ value }: { value: unknown }) {
  const text = formatValue(value);
  const isLong = text.length > 28;
  return (
    <Text
      copyable={isLong ? { text } : false}
      ellipsis={{ tooltip: text }}
      style={{ display: "inline-block", maxWidth: "100%" }}
    >
      {text}
    </Text>
  );
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === "string" ? body.error : typeof body === "string" ? body : response.statusText;
    throw new Error(`${response.status} ${message}`);
  }
  return body as T;
}

function assertServerProjectedArtifact(artifact: ProjectedMatchArtifact, label: string): void {
  if (
    (artifact.projection?.view !== "postgame-redacted" && artifact.projection?.view !== "truth-redacted") ||
    artifact.projection.privateEvidenceRedacted !== true
  ) {
    throw new Error(`${label} must be a postgame-redacted or truth-redacted projection.`);
  }
  if (artifact.projection.view === "truth-redacted" && artifact.projection.postgameTruthRedacted !== true) {
    throw new Error(`${label} truth-redacted projection must set postgameTruthRedacted=true.`);
  }
  if (artifact.projection.view === "postgame-redacted" && artifact.projection.postgameTruthRedacted === true) {
    throw new Error(`${label} postgame-redacted projection must keep postgame truth.`);
  }
  if (
    artifact.socialEpisode.exposureSummary?.schemaVersion !== "server.social-exposure-summary.v1" ||
    artifact.socialEpisode.exposureSummary.privateEvidenceRedacted !== true ||
    artifact.socialEpisode.exposureSummary.source !== "scoped_observation"
  ) {
    throw new Error(`${label} must include a redacted server social exposure summary.`);
  }
}

function assertArtifactMatchesId(artifact: ProjectedMatchArtifact, id: string, label: string): void {
  // This public DTO intentionally omits seed-derived run identity. The request
  // URL, not an echoed canonical id, correlates a truth-redacted response.
  if (artifact.projection.view === "truth-redacted") {
    if (artifact.runId || artifact.matchId || artifact.seed) {
      throw new Error(`${label} truth-redacted projection must not expose canonical identity.`);
    }
    return;
  }
  if (artifact.runId !== id && artifact.matchId !== id) {
    throw new Error(`${label} identity mismatch: expected ${shortId(id)}, got ${shortId(artifact.matchId ?? artifact.runId)}.`);
  }
}

/**
 * This verifies only server response shape and its binding to the already
 * recorded native boundary. The browser deliberately does not apply commands
 * or recompute a hash from a redacted state projection.
 */
function assertServerReplayFrame(frame: PostgameReplayFrameDto, step: ProjectedSocialStep, nativeStepCount: number): void {
  if (
    frame.artifactVersion !== "server.match-replay-frame.v1" ||
    frame.kind !== "match-replay-frame" ||
    frame.authority !== "native-social-episode" ||
    frame.source !== "server-owned-match-artifact"
  ) {
    throw new Error("Replay frame is not a server-owned native replay projection.");
  }
  if (
    frame.projection?.view !== "postgame-redacted" ||
    frame.projection.privateEvidenceRedacted !== true ||
    frame.projection.postgameTruthRedacted !== false
  ) {
    throw new Error("Replay frame must be a postgame-redacted projection.");
  }
  if (frame.cursor.nativeStepCount !== nativeStepCount) {
    throw new Error("Replay frame cursor does not match the requested native step.");
  }
  if (!isRecord(frame.state)) {
    throw new Error("Replay frame is missing a server-projected state.");
  }
  if (step.postStateHash && frame.cursor.recordedPostStateHash !== step.postStateHash) {
    throw new Error("Replay frame recorded state hash does not match the selected native step.");
  }
  if (step.postStateHash && frame.cursor.stateHash !== undefined && frame.cursor.stateHash !== step.postStateHash) {
    throw new Error("Replay frame deterministic state hash does not match the selected native step.");
  }
}

function assertServerProjectedComparison(comparison: MatchComparisonArtifact): void {
  if (
    (comparison.projection.view !== "postgame-redacted" && comparison.projection.view !== "truth-redacted") ||
    comparison.projection.privateEvidenceRedacted !== true
  ) {
    throw new Error("comparison artifact must be a postgame-redacted or truth-redacted projection.");
  }
  if (comparison.projection.view === "truth-redacted" && comparison.projection.postgameTruthRedacted !== true) {
    throw new Error("truth-redacted comparison must set postgameTruthRedacted=true.");
  }
}

function assertComparisonMatchesIds(comparison: MatchComparisonArtifact, baselineId: string, candidateId: string): void {
  // Truth-redacted comparison sources also omit both canonical ids. Their pair
  // identity is owned by the server route that produced this response.
  if (comparison.projection.view === "truth-redacted") {
    const sources = [comparison.baseline, comparison.candidate];
    if (sources.some((source) => source.runId || source.matchId || source.seed)) {
      throw new Error("truth-redacted comparison must not expose canonical source identity.");
    }
    return;
  }
  const baselineMatches = comparison.baseline.runId === baselineId || comparison.baseline.matchId === baselineId;
  const candidateMatches = comparison.candidate.runId === candidateId || comparison.candidate.matchId === candidateId;
  if (!baselineMatches || !candidateMatches) {
    throw new Error(`comparison identity mismatch: expected ${shortId(baselineId)} vs ${shortId(candidateId)}.`);
  }
}

function isComparisonCurrentForRoute(options: {
  comparison: MatchComparisonArtifact | null | undefined;
  context: ComparisonRequestContext | null | undefined;
  baselineId?: string | null;
  candidateId?: string | null;
  view?: ArtifactView | null;
}): boolean {
  const baselineId = options.baselineId?.trim() ?? "";
  const candidateId = options.candidateId?.trim() ?? "";
  const comparison = options.comparison;
  if (!comparison || !baselineId || !candidateId || !options.view) return false;
  if (comparison.view !== options.view) return false;
  if (comparison.view !== "truth-redacted") {
    return isMatchComparisonSelectionCurrent({
      comparison,
      baselineId,
      candidateId,
      view: options.view
    });
  }
  const context = options.context;
  return Boolean(
    context &&
      context.comparisonId === comparison.comparisonId &&
      context.baselineId === baselineId &&
      context.candidateId === candidateId &&
      context.view === options.view
  );
}




function flattenTournamentPackFiles(files: Record<string, unknown> | null | undefined): string[] {
  if (!files || typeof files !== "object") return [];
  const values: string[] = [];
  for (const value of Object.values(files)) {
    if (typeof value === "string" && value.length > 0) values.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.length > 0) values.push(item);
      }
    }
  }
  return [...new Set(values)].sort();
}

function tournamentPackAggregateFiles(pack: TournamentArtifactSetSummary): Array<{
  key: string;
  file: string;
  available: boolean;
  href: string | null;
}> {
  const preferred = [
    "manifest.json",
    "leaderboard.json",
    "benchmark_statistics.json",
    "tournament_comparison.json",
    "tournament_comparison.md",
    "summary.md",
    "cost_latency.json",
    "assignment.json"
  ];
  const registered = new Set(flattenTournamentPackFiles(pack.files));
  const downloads = pack.downloads ?? {};
  return preferred.map((file) => {
    const key = fileKeyForTournamentFile(file);
    const downloadCandidate = downloads[key] ?? downloads[file];
    const href = typeof downloadCandidate === "string" && downloadCandidate.length > 0 ? downloadCandidate : null;
    return {
      key: file,
      file,
      available: registered.has(file) || Boolean(href),
      href
    };
  });
}

function fileKeyForTournamentFile(file: string): string {
  switch (file) {
    case "manifest.json":
      return "manifest";
    case "leaderboard.json":
      return "leaderboard";
    case "benchmark_statistics.json":
      return "benchmarkStatistics";
    case "tournament_comparison.json":
      return "tournamentComparison";
    case "tournament_comparison.md":
      return "tournamentComparisonMarkdown";
    case "summary.md":
      return "summaryMarkdown";
    case "cost_latency.json":
      return "costLatency";
    case "assignment.json":
      return "assignment";
    default:
      return file;
  }
}

const DEFAULT_SHARE_ALLOWLIST = [
  "manifest.json",
  "assignment.json",
  "leaderboard.json",
  "benchmark_statistics.json",
  "tournament_comparison.json",
  "tournament_comparison.md",
  "summary.md",
  "episodes.csv",
  "agents.csv",
  "metrics.csv",
  "leaderboard.csv"
];

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

function orderCheckpoints(checkpoints: CheckpointSummary[]): CheckpointSummary[] {
  return [...checkpoints].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function shortId(value: unknown): string {
  if (typeof value !== "string" || !value) return "n/a";
  if (value.length <= 12) return value;
  return value.slice(0, 8);
}

function formatPackCommitDensity(pack: {
  nativeSteps?: number | null;
  committedSteps?: number | null;
  rejectedSteps?: number | null;
}): string {
  if (
    typeof pack.nativeSteps === "number" &&
    typeof pack.committedSteps === "number" &&
    typeof pack.rejectedSteps === "number"
  ) {
    return `n${pack.nativeSteps}/c${pack.committedSteps}/r${pack.rejectedSteps}`;
  }
  return "n/a";
}

function formatPackMetricPromotion(pack: {
  metricCount?: number | null;
  scorecardEligibleMetricCount?: number | null;
  metricPromotionClassCounts?: {
    scorecard?: number;
    diagnostic?: number;
    benchmark_only?: number;
  } | null;
}): string {
  const counts = pack.metricPromotionClassCounts;
  if (
    typeof pack.metricCount !== "number" ||
    typeof pack.scorecardEligibleMetricCount !== "number" ||
    !counts ||
    typeof counts.scorecard !== "number" ||
    typeof counts.diagnostic !== "number" ||
    typeof counts.benchmark_only !== "number"
  ) {
    return "n/a";
  }
  return `rows=${pack.metricCount} eligible=${pack.scorecardEligibleMetricCount} scorecard=${counts.scorecard} diagnostic=${counts.diagnostic} benchmark=${counts.benchmark_only}`;
}

function formatModelRewardDensity(
  modelRewards:
    | Record<
        string,
        {
          agentGames?: number;
          wins?: number;
          winRate?: number;
          averageReward?: number;
          nativeSteps?: number;
          committedSteps?: number;
          rejectedSteps?: number;
        }
      >
    | undefined
): string {
  if (!modelRewards || typeof modelRewards !== "object") return "n/a";
  const entries = Object.entries(modelRewards);
  if (!entries.length) return "n/a";
  return entries
    .map(([model, stats]) => {
      const density = formatPackCommitDensity({
        nativeSteps: stats?.nativeSteps,
        committedSteps: stats?.committedSteps,
        rejectedSteps: stats?.rejectedSteps
      });
      return `${shortId(model)}:${density}`;
    })
    .join(" · ");
}

function formatMatrixPValue(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(4) : "n/a";
}

function matrixArtifactDownloadEntries(downloads: Record<string, unknown>): Array<{ key: string; label: string; href: string }> {
  const entries: Array<{ key: string; label: string; href: string }> = [];
  for (const [key, value] of Object.entries(downloads)) {
    if (typeof value === "string") {
      entries.push({ key, label: key, href: value });
      continue;
    }
    if (key === "tournaments" && Array.isArray(value)) {
      for (const item of value) {
        if (!isRecord(item) || typeof item.cellId !== "string" || typeof item.manifest !== "string") continue;
        entries.push({ key: `tournament:${item.cellId}`, label: `tournament ${item.cellId}`, href: item.manifest });
      }
    }
  }
  return entries;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatNumber(value: number, digits: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "n/a";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  if (isRecord(value)) return JSON.stringify(value);
  return String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPendingKind(step: RedactedHarnessStepDto): string {
  const pending = step.pendingAction as unknown;
  return isRecord(pending) && typeof pending.kind === "string" ? pending.kind : "unknown";
}

function readCommandType(command: { type: string }): string {
  return isRecord(command) && typeof command.type === "string" ? command.type : "unknown";
}

function readSocialCommandType(step: ProjectedSocialStep): string {
  const action = step.action as unknown;
  const command = isRecord(action) ? action.command : undefined;
  return isRecord(command) && typeof command.type === "string" ? command.type : "unknown";
}

function readSocialPendingKind(step: ProjectedSocialStep): string {
  const pending = step.pendingAction as unknown;
  return isRecord(pending) && typeof pending.kind === "string" ? pending.kind : "unknown";
}

function readSocialCommitStatus(step: ProjectedSocialStep): "committed" | "rejected" {
  return isSocialStepCommitted(step) ? "committed" : "rejected";
}

function rangeLabel(range: [number, number]): string {
  return `${range[0]}-${range[1]}`;
}

function inspectorFromArtifact(artifact: ProjectedMatchArtifact): InspectorItem {
  const stepCounts = countSocialStepCommits(artifact.socialEpisode.steps);
  return {
    kind: "artifact",
    title: `Match Artifact ${shortId(artifact.runId)}`,
    subtitle: `${artifact.artifactVersion} · ${artifact.status}`,
    fields: [
      ["run", artifact.runId],
      ["seed", artifact.seed],
      ["status", artifact.status],
      ["native steps", stepCounts.nativeSteps],
      ["committed steps", stepCounts.committedSteps],
      ["rejected steps", stepCounts.rejectedSteps],
      ["legacy projection", artifact.trajectory.length],
      ["messages", artifact.socialEpisode.messages.length],
    ],
    json: {
      artifactVersion: artifact.artifactVersion,
      runId: artifact.runId,
      projection: artifact.projection,
      status: artifact.status,
      nativeSteps: stepCounts.nativeSteps,
      committedSteps: stepCounts.committedSteps,
      rejectedSteps: stepCounts.rejectedSteps,
      legacyTrajectoryProjection: artifact.trajectory.length,
      socialMessages: artifact.socialEpisode.messages.length,
      evaluationReport: artifact.evaluationReport
    }
  };
}

function inspectorFromMatch(match: MatchRecord): InspectorItem {
  return {
    kind: "match-record",
    title: `Run ${shortId(match.id)}`,
    subtitle: `${match.status} · ${formatDate(match.createdAt)}`,
    fields: [
      ["id", match.id],
      ["status", match.status],
      ["harness", match.harnessStatus ?? "n/a"],
      ["artifact", String(Boolean(match.hasArtifact))],
      ["native steps", typeof match.nativeSteps === "number" ? match.nativeSteps : "n/a"],
      ["committed steps", typeof match.committedSteps === "number" ? match.committedSteps : "n/a"],
      ["rejected steps", typeof match.rejectedSteps === "number" ? match.rejectedSteps : "n/a"],
      ["legacy projection", typeof match.legacyProjectionSteps === "number" ? match.legacyProjectionSteps : typeof match.trajectorySteps === "number" ? match.trajectorySteps : "n/a"]
    ],
    json: match
  };
}

function inspectorFromSocialStep(step: ProjectedSocialStep, index: number): InspectorItem {
  return {
    kind: "native-social-step",
    title: `Native Step #${index + 1}`,
    subtitle: `${step.actorId} · ${readSocialCommitStatus(step)} · ${readSocialCommandType(step)}`,
    fields: [
      ["trace", step.traceId],
      ["scheduler turn", step.turnIndex],
      ["actor", step.actorId],
      ["profile", step.profileId ?? "n/a"],
      ["commit status", readSocialCommitStatus(step)],
      ["failure stage", step.failure?.stage ?? (step.error ? "legacy_error" : "n/a")],
      ["scheduler", step.schedulerMode],
      ["action", step.action.kind],
      ["command", readSocialCommandType(step)],
      ["pre hash", step.preStateHash ?? "n/a"],
      ["post hash", step.postStateHash ?? "n/a"]
    ],
    json: safeSocialStepInspectorJson(step, index)
  };
}

function inspectorFromAgent(agent: AgentHarnessState): InspectorItem {
  return {
    kind: "agent",
    title: `Agent ${agent.playerId}`,
    subtitle: `${agent.policyName} · ${agent.model}`,
    fields: [
      ["profile", agent.profileId ?? "n/a"],
      ["turns", agent.turns],
      ["observations", agent.observations],
      ["beliefs", Object.keys(agent.beliefs ?? {}).length],
      ["private memos", agent.privateMemos.length],
      ["last intent", agent.lastIntent ?? "n/a"],
      ["social hash", agent.socialStateHash ?? "n/a"]
    ],
    json: safeAgentInspectorJson(agent)
  };
}

function inspectorFromMessage(message: SocialMessage): InspectorItem {
  return {
    kind: "social-message",
    title: `Message #${message.seq}`,
    subtitle: `${message.channelId} · ${message.visibility}`,
    fields: [
      ["id", message.id],
      ["sender", message.senderId],
      ["recipients", message.recipientIds.join(", ") || "n/a"],
      ["channel", message.channelId],
      ["visibility", message.visibility],
      ["speech acts", message.speechActs?.length ?? 0],
      ["act kinds", summarizeSpeechActKinds(message)],
      ["receipts", message.deliveryReceipts?.length ?? 0],
      ["created", message.createdAt],
      ["content", message.content]
    ],
    json: safeMessageInspectorJson(message)
  };
}

function inspectorFromSocialExposure(edge: SocialGraphExposureEdge): InspectorItem {
  return {
    kind: "social-exposure",
    title: `Exposure ${edge.sourceId} → ${edge.targetId}`,
    subtitle: `${edge.visibility} · ${edge.channelId}`,
    fields: [
      ["source", edge.sourceId],
      ["observer", edge.targetId],
      ["channel", edge.channelId],
      ["visibility", edge.visibility],
      ["kind", edge.kind ?? "message"],
      ["messages", edge.messages],
      ["observations", edge.observations],
      ["evidence", edge.evidenceCount],
      ["action kinds", edge.actionKinds.join(", ") || "n/a"],
      ["traces", edge.traceIds.map(shortId).join(", ") || "n/a"],
      ["turns", edge.turnIndexes.join(", ") || "n/a"]
    ],
    json: edge
  };
}

function inspectorFromMetric(metric: HarnessMetricRecord, decision: HarnessMetricPromotionDecision): InspectorItem {
  return {
    kind: "metric",
    title: metric.label,
    subtitle: `${metric.id} · ${metric.scope}`,
    fields: [
      ["value", metric.value],
      ["scope", metric.scope],
      ["subject", metric.subjectId ?? "episode"],
      ["source", metric.evaluatorId ?? metric.source],
      ["weight", metric.weight ?? "n/a"],
      ["promotionClass", decision.promotionClass],
      ["scorecardEligible", decision.eligibleForScorecard],
      ["promotionReasons", decision.reasons.join(", ") || "n/a"],
      ["confidence", metric.confidence ?? "n/a"],
      ["evidence", metric.evidenceRefs?.length ?? 0]
    ],
    json: metric
  };
}

function inspectorFromTournamentComparison(
  comparison: TournamentComparisonAggregateView,
  pack: TournamentArtifactSetSummary,
  actions: NonNullable<InspectorItem["actions"]> = [],
  options?: { activeComparisonId?: string | null }
): InspectorItem {
  const activeComparisonId = options?.activeComparisonId ?? null;
  const topMetrics = comparison.metricChangeFrequency
    .slice(0, 5)
    .map((metric) => `${metric.metricKey}×${metric.changedPairCount}/${metric.pairCount}`)
    .join(", ");
  const pairSummary = comparison.pairs
    .slice(0, 5)
    .map((pair) => {
      const density =
        typeof pair.committedStepsDelta === "number" && typeof pair.rejectedStepsDelta === "number"
          ? ` cΔ${pair.committedStepsDelta}/rΔ${pair.rejectedStepsDelta}`
          : "";
      const label = `e${pair.baseline.episodeIndex}→e${pair.candidate.episodeIndex}:${shortId(pair.comparisonId)}${density}`;
      return pair.comparisonId === activeComparisonId ? `${label}*` : label;
    })
    .join(", ");
  return {
    kind: "tournament-comparison",
    title: `Tournament comparison ${shortId(comparison.comparisonSetId)}`,
    subtitle: `${comparison.artifactVersion} · ${comparison.view}`,
    fields: [
      ["artifactSetId", pack.artifactSetId],
      ["comparisonSetId", comparison.comparisonSetId],
      ["tournamentSeed", comparison.tournamentSeed],
      ["experimentId", comparison.experimentId ?? "n/a"],
      ["gamesRequested", comparison.gamesRequested],
      ["artifactMatchCount", comparison.artifactMatchCount],
      ["pairCount", comparison.pairCount],
      ["active pair", activeComparisonId ? shortId(activeComparisonId) : "n/a"],
      ["changed pairs", comparison.summary.changedPairCount],
      ["total changed rows", comparison.summary.totalChangedRows],
      ["average changed rows", comparison.summary.averageChangedRows],
      ["scorecard metric delta total", comparison.summary.totalScorecardMetricDelta],
      ["diagnostic metric delta total", comparison.summary.totalDiagnosticMetricDelta],
      ["benchmark_only metric delta total", comparison.summary.totalBenchmarkOnlyMetricDelta],
      ["promotion provenance changed metrics", comparison.summary.totalPromotionProvenanceChangedMetrics],
      ["evidence identity changed metrics", comparison.summary.totalEvidenceIdentityChangedMetrics],
      [
        "social steps delta total",
        typeof comparison.summary.totalSocialStepsDelta === "number" ? comparison.summary.totalSocialStepsDelta : "n/a"
      ],
      [
        "committed steps delta total",
        typeof comparison.summary.totalCommittedStepsDelta === "number"
          ? comparison.summary.totalCommittedStepsDelta
          : "n/a"
      ],
      [
        "rejected steps delta total",
        typeof comparison.summary.totalRejectedStepsDelta === "number"
          ? comparison.summary.totalRejectedStepsDelta
          : "n/a"
      ],
      ["pair identity hash", comparison.summary.pairIdentityHash],
      ["top changed metrics", topMetrics || "n/a"],
      ["pairs", pairSummary || "n/a"],
      ["projection", comparison.projection?.view ?? comparison.view]
    ],
    json: comparison,
    actions
  };
}

function inspectorFromWarning(warning: HarnessEvaluationWarning): InspectorItem {
  return {
    kind: "evaluation-warning",
    title: warning.code,
    subtitle: warning.severity,
    fields: [
      ["metric", warning.metricId ?? "n/a"],
      ["subject", warning.subjectId ?? "n/a"],
      ["message", warning.message],
      ["evidence", warning.evidenceRefs?.length ?? 0]
    ],
    json: warning
  };
}

function inspectorFromComparison(comparison: MatchComparisonArtifact): InspectorItem {
  return {
    kind: "match-comparison",
    title: `Match comparison ${shortId(comparison.comparisonId)}`,
    subtitle: `${comparison.artifactVersion} · ${comparison.view}`,
    fields: [
      ["comparisonId", comparison.comparisonId],
      ["view", comparison.view],
      ["createdAt", comparison.createdAt],
      ["baseline", comparison.baseline.matchId ?? comparison.baseline.runId],
      ["candidate", comparison.candidate.matchId ?? comparison.candidate.runId],
      ["rows", comparison.summary.rowCount],
      ["changed rows", comparison.summary.changedRowCount],
      ["numeric deltas", comparison.summary.numericDeltaCount],
      ["promotion changed metrics", comparison.summary.promotionChangedMetricCount],
      ["promotion provenance changed metrics", comparison.summary.promotionProvenanceChangedMetricCount ?? 0],
      ["scorecard metric delta", comparison.summary.scorecardMetricDelta],
      ["diagnostic metric delta", comparison.summary.diagnosticMetricDelta],
      ["benchmark_only metric delta", comparison.summary.benchmarkOnlyMetricDelta],
      ["social steps delta", comparison.summary.socialStepsDelta],
      ["committed steps delta", comparison.summary.committedStepsDelta],
      ["rejected steps delta", comparison.summary.rejectedStepsDelta],
      [
        "baseline steps",
        `s${comparison.summary.baselineSocialSteps}/c${comparison.summary.baselineCommittedSteps}/r${comparison.summary.baselineRejectedSteps}`
      ],
      [
        "candidate steps",
        `s${comparison.summary.candidateSocialSteps}/c${comparison.summary.candidateCommittedSteps}/r${comparison.summary.candidateRejectedSteps}`
      ],
      ["evidence identity changed metrics", comparison.summary.evidenceIdentityChangedMetricCount],
      ["metric keys", `${comparison.summary.metricKeysEmitted}/${comparison.summary.metricKeysCompared}`],
      ["baselineHash", comparison.summary.baselineHash],
      ["candidateHash", comparison.summary.candidateHash]
    ],
    json: comparison
  };
}

function inspectorFromFilteredComparison(
  projection: MatchComparisonFilteredProjection
): InspectorItem {
  return {
    kind: "match-comparison-filtered",
    title: `Filtered Comparison ${shortId(projection.sourceComparisonId)}`,
    subtitle: `${projection.artifactVersion} · ${projection.view}`,
    fields: [
      ["source comparison", projection.sourceComparisonId],
      ["baseline", projection.source.baseline.matchId ?? projection.source.baseline.runId],
      ["candidate", projection.source.candidate.matchId ?? projection.source.candidate.runId],
      [
        "filter",
        `${projection.filter.group}/${projection.filter.promotion}/${projection.filter.evidenceIdentity}/${projection.filter.numericDelta}${
          projection.filter.changedOnly ? "/changedOnly" : ""
        }`
      ],
      ["rows", `${projection.summary.rowCount}/${projection.summary.sourceRowCount}`],
      ["changed", `${projection.summary.changedRowCount}/${projection.summary.sourceChangedRowCount}`],
      [
        "groups",
        `summary=${projection.summary.summaryRowCount}, metric=${projection.summary.metricRowCount}, metric_evidence=${projection.summary.metricEvidenceRowCount}`
      ],
      ["numeric delta", projection.summary.numericDeltaCount],
      ["promotion changed metrics", projection.summary.promotionChangedMetricCount],
      ["promotion provenance changed metrics", projection.summary.promotionProvenanceChangedMetricCount],
      ["evidence identity changed metrics", projection.summary.evidenceIdentityChangedMetricCount],
      ["evidence identity only-baseline refs", projection.summary.evidenceIdentityOnlyBaselineRefCount],
      ["evidence identity only-candidate refs", projection.summary.evidenceIdentityOnlyCandidateRefCount],
      ["source social steps delta", projection.source.summary.socialStepsDelta],
      ["source committed steps delta", projection.source.summary.committedStepsDelta],
      ["source rejected steps delta", projection.source.summary.rejectedStepsDelta],
      ["projection", projection.view]
    ],
    json: projection
  };
}


function inspectorFromComparisonRow(row: MatchComparisonRow): InspectorItem {
  return {
    kind: "comparison-row",
    title: row.label,
    subtitle: row.id,
    fields: [
      ["baseline", row.baseline],
      ["candidate", row.candidate],
      ["delta", row.delta ?? "n/a"],
      ["changed", String(row.changed)],
      ["group", row.group ?? "summary"],
      ["metricId", row.metricId ?? "n/a"],
      ["subjectId", row.subjectId ?? "n/a"],
      [
        "promotion",
        row.promotion ? `${row.promotion.baseline}→${row.promotion.candidate}` : "n/a"
      ],
      [
        "promotion changed fields",
        row.promotion?.details?.changedFields.length ? row.promotion.details.changedFields.join(", ") : "n/a"
      ],
      [
        "promotion decision ids",
        row.promotion?.details
          ? `${row.promotion.details.baseline?.catalogDecisionId ?? "n/a"}→${row.promotion.details.candidate?.catalogDecisionId ?? "n/a"}`
          : "n/a"
      ],
      [
        "promotion scorecard eligibility",
        row.promotion?.details
          ? `${row.promotion.details.baseline?.eligibleForScorecard ? "eligible" : "ineligible"}→${row.promotion.details.candidate?.eligibleForScorecard ? "eligible" : "ineligible"}`
          : "n/a"
      ],
      [
        "evidence refs",
        row.evidence ? `${row.evidence.baselineRefs}→${row.evidence.candidateRefs}` : "n/a"
      ],
      [
        "evidence kinds",
        row.evidence
          ? `${row.evidence.baselineKinds.join(",") || "无"}→${row.evidence.candidateKinds.join(",") || "无"}`
          : "n/a"
      ],
      [
        "evidence ids",
        row.evidence
          ? `${row.evidence.baselineIds.length}→${row.evidence.candidateIds.length}`
          : "n/a"
      ],
      [
        "only baseline evidence ids",
        row.evidence?.onlyBaselineIds.length ? row.evidence.onlyBaselineIds.join("; ") : "n/a"
      ],
      [
        "only candidate evidence ids",
        row.evidence?.onlyCandidateIds.length ? row.evidence.onlyCandidateIds.join("; ") : "n/a"
      ]
    ],
    json: row
  };
}

function inspectorFromReplay(replay: ReplayResponse): InspectorItem {
  return {
    kind: "replay",
    title: replay.summary?.ok ? "Replay passed" : "Replay failed",
    subtitle: replay.summary?.kind ?? "replay",
    fields: [
      ["ok", String(Boolean(replay.summary?.ok))],
      ["authority", replay.summary?.authority ?? "n/a"],
      ["native steps", replay.summary?.nativeSteps ?? 0],
      ["replayed steps", replay.summary?.replayedSteps ?? 0],
      ["replayed batches", replay.summary?.replayedBatches ?? 0],
      ["rejected skipped", replay.summary?.rejectedSteps ?? 0],
      ["hash matches", String(replay.summary?.finalHashMatchesArtifact ?? replay.summary?.finalHashMatchesExpected ?? false)],
      ["message hash matches", String(replay.summary?.messagesHashMatchesExpected ?? false)],
      ["mismatches", replay.summary?.mismatchCount ?? 0],
      ["final hash", replay.summary?.finalHash ?? "n/a"]
    ],
    json: replay
  };
}

function inspectorFromCheckpoint(checkpoint: CheckpointSummary): InspectorItem {
  return {
    kind: "checkpoint-summary",
    title: `Checkpoint ${shortId(checkpoint.checkpointId)}`,
    subtitle: `${formatDate(checkpoint.createdAt)} · ${checkpoint.reason ?? "no reason"}`,
    fields: [
      ["checkpoint", checkpoint.checkpointId],
      ["source run", checkpoint.source.runId],
      ["source match", checkpoint.source.matchId ?? "n/a"],
      ["trace", checkpoint.source.boundaryTraceRef ?? "initial"],
      ["native turn", checkpoint.source.boundaryTurnIndex ?? "n/a"],
      ["native steps", checkpoint.counts.nativeSteps],
      [
        "committed steps",
        typeof checkpoint.counts.committedSteps === "number" ? checkpoint.counts.committedSteps : "n/a"
      ],
      [
        "rejected steps",
        typeof checkpoint.counts.rejectedSteps === "number" ? checkpoint.counts.rejectedSteps : "n/a"
      ],
      ["messages", checkpoint.counts.socialMessages],
      ["state hash", checkpoint.source.stateHash]
    ],
    json: {
      kind: checkpoint.kind,
      ok: checkpoint.ok,
      checkpointId: checkpoint.checkpointId,
      createdAt: checkpoint.createdAt,
      reason: checkpoint.reason ?? null,
      source: checkpoint.source,
      counts: checkpoint.counts
    }
  };
}

function inspectorFromForkLineage(lineage: ForkLineageSummary): InspectorItem {
  return {
    kind: "fork-lineage",
    title: `Fork Lineage ${shortId(lineage.runId)}`,
    subtitle: `${lineage.isFork ? "fork" : "root"} · ${lineage.boundary?.status ?? "n/a"}`,
    fields: [
      ["run", lineage.runId ?? "n/a"],
      ["match", lineage.matchId ?? "n/a"],
      ["is fork", String(Boolean(lineage.isFork))],
      ["ok", String(Boolean(lineage.ok))],
      ["boundary", lineage.boundary?.status ?? "n/a"],
      ["checkpoint found", String(lineage.boundary?.checkpointFound ?? false)],
      ["state hash match", String(lineage.boundary?.stateHashMatches ?? "n/a")],
      ["message prefix", String(lineage.boundary?.messagePrefixMatchesCheckpoint ?? "n/a")]
    ],
    json: lineage
  };
}

function inspectorFromBranchTree(tree: BranchTreeSummary): InspectorItem {
  return {
    kind: "checkpoint-branch-tree",
    title: `Branch Tree ${shortId(tree.rootCheckpointId)}`,
    subtitle: `${tree.counts?.checkpoints ?? 0} checkpoints · ${tree.counts?.matches ?? 0} matches`,
    fields: [
      ["root", tree.rootCheckpointId ?? "n/a"],
      ["ok", String(Boolean(tree.ok))],
      ["ok scope", tree.okScope ?? "n/a"],
      ["checkpoints", tree.counts?.checkpoints ?? 0],
      ["matches", tree.counts?.matches ?? 0],
      ["edges", tree.counts?.edges ?? 0],
      ["max depth", tree.counts?.maxDepth ?? 0],
      ["truncated", String(Boolean(tree.truncation?.isTruncated))]
    ],
    json: {
      kind: tree.kind,
      schemaVersion: tree.schemaVersion,
      ok: tree.ok,
      okScope: tree.okScope,
      rootCheckpointId: tree.rootCheckpointId,
      counts: tree.counts,
      truncation: tree.truncation,
      checkpointNodes: tree.checkpoints?.length ?? 0,
      matchNodes: tree.matches?.length ?? 0,
      edges: tree.edges
    }
  };
}

function readRelationshipRows(agent: AgentHarnessState): Array<{
  owner: string;
  target: string;
  trust: string;
  suspicion: string;
  evidence: number;
}> {
  const edges = agent.social?.relationships?.edges;
  if (!edges || typeof edges !== "object") return [];
  return Object.entries(edges as Record<string, unknown>).map(([target, raw]) => {
    const edge = isRecord(raw) ? raw : {};
    return {
      owner: agent.playerId,
      target,
      trust: edge.trust !== undefined ? String(edge.trust) : "n/a",
      suspicion: edge.suspicion !== undefined ? String(edge.suspicion) : "n/a",
      evidence: Array.isArray(edge.evidenceRefs) ? edge.evidenceRefs.length : 0
    };
  });
}

function readSocialJournalRows(agents: AgentHarnessState[]): SocialJournalRow[] {
  return agents.flatMap((agent) =>
    (agent.social?.journal?.entries ?? []).map((entry) => ({
      ...entry,
      key: `${agent.playerId}-${entry.journalSeq}`,
      owner: agent.playerId,
      evidenceCount: entry.evidenceRefs.length
    }))
  );
}

function countMessagesByVisibility(messages: SocialMessage[]): Record<SocialMessage["visibility"], number> {
  return messages.reduce<Record<SocialMessage["visibility"], number>>(
    (counts, message) => {
      counts[message.visibility] += 1;
      return counts;
    },
    { private: 0, team: 0, public: 0, postgame: 0 }
  );
}

function countSocialSchedulerModes(steps: ProjectedSocialStep[]): Record<ProjectedSocialStep["schedulerMode"], number> {
  return steps.reduce<Record<ProjectedSocialStep["schedulerMode"], number>>(
    (counts, step) => {
      counts[step.schedulerMode] += 1;
      return counts;
    },
    { aec: 0, "aec-batched-decision": 0, parallel: 0 }
  );
}

function safeSocialStepInspectorJson(step: ProjectedSocialStep, index: number): Record<string, unknown> {
  return {
    kind: "native-social-step",
    index,
    traceId: step.traceId,
    turnIndex: step.turnIndex,
    actorId: step.actorId,
    profileId: step.profileId,
    commitStatus: readSocialCommitStatus(step),
    failure: step.failure
      ? {
          stage: step.failure.stage,
          message: step.failure.message,
          causeName: step.failure.causeName
        }
      : step.error
        ? { stage: "legacy_error", message: step.error }
        : null,
    scheduler: {
      mode: step.schedulerMode,
      batchId: step.batchId ?? null,
      batchIndex: step.batchIndex ?? null,
      batchSize: step.batchSize ?? null,
      atomic: step.atomic ?? null,
      resolutionPolicy: step.resolutionPolicy ?? null
    },
    pendingActionKind: readSocialPendingKind(step),
    actionKind: step.action.kind,
    commandType: readSocialCommandType(step),
    hashes: {
      decisionStateHash: step.decisionStateHash,
      preStateHash: step.preStateHash,
      postStateHash: step.postStateHash,
      actorSnapshotsHashAfterStep: step.actorSnapshotsHashAfterStep
    },
    ranges: {
      eventSeqRange: step.eventSeqRange,
      messageSeqRange: step.messageSeqRange
    }
  };
}

function safeAgentInspectorJson(agent: AgentHarnessState): Record<string, unknown> {
  return {
    kind: "agent",
    playerId: agent.playerId,
    profileId: agent.profileId,
    model: agent.model,
    temperature: agent.temperature,
    policyName: agent.policyName,
    turns: agent.turns,
    observations: agent.observations,
    beliefCount: Object.keys(agent.beliefs ?? {}).length,
    privateMemoCount: agent.privateMemos.length,
    lastIntent: agent.lastIntent,
    socialStateHash: agent.socialStateHash,
    social: {
      relationshipCount: Object.keys(agent.social?.relationships?.edges ?? {}).length,
      journalEntryCount: agent.social?.journal?.entries.length ?? 0,
      memoryCount: countRecordValues(agent.social?.memory),
      reputationCount: countRecordValues(agent.social?.reputation),
      normCount: countRecordValues(agent.social?.norms),
      goalCount: countRecordValues(agent.social?.goals)
    }
  };
}

function safeMessageInspectorJson(message: SocialMessage): Record<string, unknown> {
  return {
    kind: "social-message",
    id: message.id,
    seq: message.seq,
    channelId: message.channelId,
    senderId: message.senderId,
    recipientIds: message.recipientIds,
    visibility: message.visibility,
    content: message.content,
    createdAt: message.createdAt,
    speechActCount: message.speechActs?.length ?? 0,
    speechActKinds: uniqueStrings((message.speechActs ?? []).map((act) => act.kind)),
    deliveryReceiptCount: message.deliveryReceipts?.length ?? 0,
    receiptRedactionPolicies: uniqueStrings((message.deliveryReceipts ?? []).map((receipt) => receipt.redactionPolicy)),
    metadata: message.metadata
  };
}

function countRecordValues(value: unknown): number {
  if (!isRecord(value)) return 0;
  return Object.keys(value).length;
}

function summarizeSpeechActKinds(message: SocialMessage): string {
  const kinds = uniqueStrings((message.speechActs ?? []).map((act) => act.kind));
  return kinds.length ? kinds.slice(0, 5).join(", ") : "n/a";
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))).sort();
}

export function buildSocialGraph(artifact: SocialGraphArtifact): SocialGraph {
  const nodes = new Map<string, SocialGraphNode>();
  const ensureNode = (id: string): SocialGraphNode => {
    const existing = nodes.get(id);
    if (existing) return existing;
    const node: SocialGraphNode = { id, sent: 0, received: 0, observed: 0 };
    nodes.set(id, node);
    return node;
  };

  for (const agent of artifact.agents) ensureNode(agent.playerId);

  const messageEdges = new Map<string, SocialGraphMessageEdge>();
  for (const message of artifact.socialEpisode.messages) {
    ensureNode(message.senderId);
    for (const recipientId of message.recipientIds) {
      ensureNode(recipientId);
      if (recipientId === message.senderId) continue;
      ensureNode(message.senderId).sent += 1;
      ensureNode(recipientId).received += 1;
      const key = `${message.senderId}->${recipientId}`;
      const edge = messageEdges.get(key) ?? {
        sourceId: message.senderId,
        targetId: recipientId,
        messages: 0
      };
      edge.messages += 1;
      messageEdges.set(key, edge);
    }
  }

  const exposureEdges = new Map<
    string,
    SocialGraphExposureEdge & {
      messageIds: Set<string>;
      actionKindSet: Set<string>;
      traceIdSet: Set<string>;
      turnIndexSet: Set<number>;
    }
  >();
  for (const exposure of readSocialGraphExposureRecords(artifact)) {
    ensureNode(exposure.sourceId);
    ensureNode(exposure.observerId).observed += 1;
    const key = [
      exposure.sourceId,
      exposure.observerId,
      exposure.channelId,
      exposure.visibility,
      exposure.kind ?? ""
    ].join("::");
    const edge = exposureEdges.get(key) ?? {
      sourceId: exposure.sourceId,
      targetId: exposure.observerId,
      channelId: exposure.channelId,
      visibility: exposure.visibility,
      kind: exposure.kind,
      messages: 0,
      observations: 0,
      actionKinds: [],
      traceIds: [],
      turnIndexes: [],
      evidenceCount: 0,
      evidenceLabels: [],
      messageIds: new Set<string>(),
      actionKindSet: new Set<string>(),
      traceIdSet: new Set<string>(),
      turnIndexSet: new Set<number>()
    };
    edge.messageIds.add(exposure.messageId);
    edge.actionKindSet.add(exposure.observedAtActionKind);
    edge.traceIdSet.add(exposure.observedAtTraceId);
    edge.turnIndexSet.add(exposure.observedAtTurnIndex);
    edge.observations += 1;
    edge.evidenceCount += 1;
    edge.evidenceLabels.push(
      `msg#${exposure.messageSeq} observed@turn${exposure.observedAtTurnIndex} ${exposure.observedAtActionKind} ${exposure.observedAtTraceId}`
    );
    exposureEdges.set(key, edge);
  }

  const materializedExposureEdges = [...exposureEdges.values()].map((edge) => ({
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    channelId: edge.channelId,
    visibility: edge.visibility,
    kind: edge.kind,
    messages: edge.messageIds.size,
    observations: edge.observations,
    actionKinds: [...edge.actionKindSet],
    traceIds: [...edge.traceIdSet],
    turnIndexes: [...edge.turnIndexSet],
    evidenceCount: edge.evidenceCount,
    evidenceLabels: edge.evidenceLabels
  }));

  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    messageEdges: [...messageEdges.values()],
    exposureEdges: materializedExposureEdges
  };
}

function readSocialGraphExposureRecords(artifact: SocialGraphArtifact): SocialExposureRecord[] {
  if (Array.isArray(artifact.socialEpisode.exposureRecords)) {
    return artifact.socialEpisode.exposureRecords;
  }
  // Message recipient envelopes are not evidence that an actor received an
  // observation. Absence of server-projected exposure records must remain an
  // absence of graph exposure edges rather than a browser-side reconstruction.
  return [];
}
