import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
  Input,
  Layout,
  Menu,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Timeline,
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
  SwapOutlined,
  TeamOutlined,
  WarningOutlined
} from "@ant-design/icons";

import type { GameCommand, PublicGameState } from "./core/types";
import type { MatchArtifact } from "./harness/artifacts";
import type { MatchComparisonArtifact, MatchComparisonRow } from "./harness/matchComparison";
import type {
  AgentHarnessState,
  HarnessEvaluationWarning,
  HarnessMetricRecord,
  HarnessRunStatus,
  HarnessStepRecord
} from "./harness/types";
import { deriveSocialExposureRecords, type SocialChannel, type SocialExposureRecord, type SocialMessage } from "./harness/social";
import type { SocialStateMutationJournalEntry } from "./harness/socialState";

type Workspace = "runs" | "timeline" | "society" | "lineage" | "evaluation" | "compare";
type ArtifactView = "postgame-redacted";

interface ArtifactProjection {
  view: ArtifactView;
  privateEvidenceRedacted: boolean;
  postgameTruthRedacted: boolean;
  generatedAt: string;
}

type ProjectedMatchArtifact = MatchArtifact & {
  projection?: ArtifactProjection;
};
type SocialGraphArtifact = Pick<MatchArtifact, "agents" | "socialEpisode"> & {
  projection?: ArtifactProjection;
};
type ProjectedSocialStep = ProjectedMatchArtifact["socialEpisode"]["steps"][number];

interface SocialGraphNode {
  id: string;
  sent: number;
  received: number;
  observed: number;
}

interface SocialGraphMessageEdge {
  sourceId: string;
  targetId: string;
  messages: number;
}

interface SocialGraphExposureEdge {
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
    endpoint?: string;
    models?: string[];
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
  trajectorySteps?: number;
  checkpointCount?: number;
  summary?: unknown;
}

interface ReplayResponse {
  summary?: {
    kind?: "replay";
    ok?: boolean;
    replayedCommands?: number;
    finalHash?: string;
    expectedFinalHash?: string;
    finalHashMatchesArtifact?: boolean;
    finalHashMatchesExpected?: boolean;
    mismatchCount?: number;
  };
  replay?: unknown;
  error?: string;
}

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
    traceRef?: string | null;
    turnIndex?: number | null;
    trajectoryLength: number;
    messageSeq?: number | null;
    stateHash: string;
    trajectoryHash?: string | null;
    agentsHash?: string | null;
    socialMessagesHash?: string | null;
    failureReason?: string | null;
    truncationReason?: string | null;
  };
  counts: {
    agents: number;
    trajectorySteps: number;
    socialMessages: number;
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
    trajectoryLength?: number;
    socialSteps?: number;
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
    newTrajectorySteps?: number;
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
    trajectoryLength?: number;
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
  { id: "society", label: "社会", description: "agent、消息、关系证据", icon: <TeamOutlined /> },
  { id: "lineage", label: "谱系", description: "checkpoint、fork、branch tree", icon: <ApiOutlined /> },
  { id: "evaluation", label: "评测", description: "指标、证据、告警", icon: <SafetyCertificateOutlined /> },
  { id: "compare", label: "对比", description: "基准与候选工件矩阵", icon: <SwapOutlined /> }
];

export function App() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<MatchRecord | null>(null);
  const [artifact, setArtifact] = useState<ProjectedMatchArtifact | null>(null);
  const [artifactView, setArtifactView] = useState<ArtifactView>("postgame-redacted");
  const [candidateId, setCandidateId] = useState<string>("");
  const [candidateArtifact, setCandidateArtifact] = useState<ProjectedMatchArtifact | null>(null);
  const [comparison, setComparison] = useState<MatchComparisonArtifact | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState("");
  const [forkLineage, setForkLineage] = useState<ForkLineageSummary | null>(null);
  const [branchTree, setBranchTree] = useState<BranchTreeSummary | null>(null);
  const [workspace, setWorkspace] = useState<Workspace>("runs");
  const [selectedStepIndex, setSelectedStepIndex] = useState(0);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [maxTransitions, setMaxTransitions] = useState(String(DEFAULT_MAX_TRANSITIONS));
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(DEFAULT_TIMEOUT_SECONDS));
  const [status, setStatus] = useState("正在连接 harness API...");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [replay, setReplay] = useState<ReplayResponse | null>(null);
  const [inspector, setInspector] = useState<InspectorItem | null>(null);
  const [rawOpen, setRawOpen] = useState(false);

  const models = useMemo(() => config?.models ?? config?.provider?.models ?? [], [config]);
  const artifactBackedMatches = useMemo(() => matches.filter((match) => match.hasArtifact), [matches]);
  const currentMatchId = selectedMatch?.id ?? artifact?.matchId ?? artifact?.runId ?? "";
  const selectedStep = artifact?.trajectory?.[selectedStepIndex] ?? null;
  const agents = artifact?.agents ?? [];
  const selectedAgent = selectedAgentId ? agents.find((agent) => agent.playerId === selectedAgentId) ?? null : agents[0] ?? null;
  const messages = artifact?.socialEpisode?.messages ?? [];
  const channels = artifact?.socialEpisode?.channels ?? [];
  const metrics = artifact?.evaluationReport?.metrics ?? [];
  const warnings = artifact?.evaluationReport?.warnings ?? [];

  const filteredMatches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return matches;
    return matches.filter((match) => {
      const haystack = [
        match.id,
        match.status,
        match.harnessStatus ?? "",
        match.state.phase,
        match.state.seed,
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

  const loadArtifact = useCallback(
    async (match: MatchRecord, view: ArtifactView = artifactView) => {
      setBusy(`artifact:${match.id}`);
      try {
        const nextArtifact = await apiJson<ProjectedMatchArtifact>(`/api/matches/${encodeURIComponent(match.id)}/artifact?view=${view}`);
        assertPostgameRedactedArtifact(nextArtifact, "match artifact");
        assertArtifactMatchesId(nextArtifact, match.id, "match artifact");
        setSelectedMatch(match);
        setArtifact(nextArtifact);
        setArtifactView(view);
        setReplay(null);
        setComparison(null);
        setCandidateArtifact(null);
        setCheckpoints([]);
        setSelectedCheckpointId("");
        setForkLineage(null);
        setBranchTree(null);
        setSelectedStepIndex(clampIndex(nextArtifact.trajectory.length - 1, nextArtifact.trajectory.length));
        setSelectedAgentId(nextArtifact.agents[0]?.playerId ?? "");
        setInspector(inspectorFromArtifact(nextArtifact));
        setActionStatus(`已加载脱敏工件：${shortId(match.id)} · trajectory=${nextArtifact.trajectory.length}`);
      } catch (nextError) {
        setActionStatus("工件加载失败", errorMessage(nextError));
      } finally {
        setBusy(null);
      }
    },
    [artifactView, setActionStatus]
  );

  const bootstrap = useCallback(async () => {
    setBusy("bootstrap");
    try {
      await loadConfig();
      const records = await refreshMatches();
      const latest = records.find((match) => match.hasArtifact);
      if (latest) {
        await loadArtifact(latest, "postgame-redacted");
      } else {
        setActionStatus("API 已连接，但当前没有可加载的 harness 工件。");
      }
    } catch (nextError) {
      setActionStatus("初始化失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [loadArtifact, loadConfig, refreshMatches, setActionStatus]);

  useEffect(() => {
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
      await loadArtifact(latest, "postgame-redacted");
      setWorkspace("timeline");
    } catch (nextError) {
      setActionStatus("加载最近工件失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [loadArtifact, refreshMatches, setActionStatus]);

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
          timeoutMs
        })
      });
      await refreshMatches();
      if (record.hasArtifact) {
        await loadArtifact(record, "postgame-redacted");
        setWorkspace("timeline");
      }
      setActionStatus(`真实 harness run 完成：${shortId(record.id)} · artifact=${record.hasArtifact ? "yes" : "no"}`);
    } catch (nextError) {
      setActionStatus("真实 harness run 失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [config?.defaultProfiles, loadArtifact, maxTransitions, refreshMatches, selectedModel, setActionStatus, timeoutSeconds]);

  const handleReplay = useCallback(async () => {
    if (!currentMatchId) {
      setActionStatus("无法复现：尚未选择 run。");
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
          ? `复现通过：${nextReplay.summary?.replayedCommands ?? 0} 条命令，hash 匹配=${String(nextReplay.summary?.finalHashMatchesArtifact ?? nextReplay.summary?.finalHashMatchesExpected ?? false)}`
          : `复现失败：mismatch=${nextReplay.summary?.mismatchCount ?? "unknown"}`,
        ok ? null : nextReplay.error ?? "replay validator reported mismatch"
      );
    } catch (nextError) {
      setActionStatus("复现请求失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [currentMatchId, setActionStatus]);

  const handleCandidateChange = useCallback(
    (value: string) => {
      setCandidateId(value);
      setCandidateArtifact(null);
      setComparison(null);
      setActionStatus(`候选运行已选择：${shortId(value)}`);
    },
    [setActionStatus]
  );

  const handleLoadComparison = useCallback(async () => {
    const baselineId = selectedMatch?.id ?? artifact?.matchId ?? artifact?.runId;
    if (!baselineId || !candidateId) {
      setActionStatus("无法对比：需要基准 run 和候选 run。");
      return;
    }
    setBusy("compare");
    try {
      const [candidate, nextComparison] = await Promise.all([
        apiJson<ProjectedMatchArtifact>(`/api/matches/${encodeURIComponent(candidateId)}/artifact?view=postgame-redacted`),
        apiJson<MatchComparisonArtifact>(
          `/api/matches/${encodeURIComponent(baselineId)}/compare/${encodeURIComponent(candidateId)}?view=postgame-redacted`
        )
      ]);
      assertPostgameRedactedArtifact(candidate, "candidate artifact");
      assertArtifactMatchesId(candidate, candidateId, "candidate artifact");
      assertPostgameRedactedComparison(nextComparison);
      assertComparisonMatchesIds(nextComparison, baselineId, candidateId);
      setCandidateArtifact(candidate);
      setComparison(nextComparison);
      setInspector(inspectorFromComparison(nextComparison));
      setActionStatus(`对比工件已加载：${shortId(baselineId)} vs ${shortId(candidateId)} · rows=${nextComparison.rows.length}`);
    } catch (nextError) {
      setActionStatus("对比工件加载失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [artifact?.matchId, artifact?.runId, candidateId, selectedMatch?.id, setActionStatus]);

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
        anchor.download = `${shortId(currentMatchId)}-trajectory.jsonl`;
        anchor.click();
        URL.revokeObjectURL(url);
        setActionStatus(`trajectory.jsonl 已验证并开始下载：${shortId(currentMatchId)}`);
      })
      .catch((nextError: unknown) => {
        setActionStatus("trajectory.jsonl 下载失败", errorMessage(nextError));
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
      const step = artifact?.trajectory[index];
      setSelectedStepIndex(index);
      if (step) {
        setInspector(inspectorFromStep(step, index));
        setActionStatus(`已选择 trace step：#${index + 1} · ${step.actorId}`);
      }
    },
    [artifact?.trajectory, setActionStatus]
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
          onLoadArtifact={(match) => void loadArtifact(match, "postgame-redacted")}
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
          onReplay={handleReplay}
          onDownload={handleDownloadArtifact}
          artifactView={artifactView}
          replay={replay}
          busy={busy}
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
          onInspectMetric={(metric) => setInspector(inspectorFromMetric(metric))}
          onInspectWarning={(warning) => setInspector(inspectorFromWarning(warning))}
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
          candidates={compareCandidates}
          candidateId={candidateId}
          onCandidateChange={handleCandidateChange}
          onLoadComparison={handleLoadComparison}
          busy={busy}
          onInspectRow={(row) => setInspector(inspectorFromComparisonRow(row))}
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
          colorPrimary: "#165dff",
          fontFamily:
            "\"Noto Sans SC\", \"PingFang SC\", \"Microsoft YaHei\", \"Source Han Sans SC\", \"Geist Variable\", system-ui, sans-serif"
        },
        components: {
          Layout: {
            bodyBg: "#f5f7fb",
            headerBg: "#ffffff",
            siderBg: "#ffffff"
          },
          Card: {
            headerBg: "#ffffff"
          }
        }
      }}
    >
      <Layout style={{ minHeight: "100vh" }}>
        <Sider width={292} breakpoint="xl" collapsedWidth={0} style={{ borderInlineEnd: "1px solid #f0f0f0" }}>
          <Flex vertical gap="middle" style={{ height: "100%", padding: 16 }}>
            <Space align="start">
              <ExperimentOutlined style={{ fontSize: 28, color: "#165dff" }} />
              <Flex vertical gap={4}>
                <Title level={4} style={{ margin: 0 }}>
                  多 Agent 社会 Harness Cockpit
                </Title>
                <Space size={4} wrap>
                  <Tag color="blue">server truth</Tag>
                  <Tag color="processing">postgame-redacted</Tag>
                </Space>
              </Flex>
            </Space>

            <Menu
              mode="inline"
              selectedKeys={[workspace]}
              items={menuItems}
              onClick={({ key }) => handleWorkspaceChange(key as Workspace)}
            />

            <Card size="small" title="Run Context">
              <Descriptions
                size="small"
                column={1}
                items={descriptionItems([
                  ["当前 run", currentMatchId ? shortId(currentMatchId) : "未选择"],
                  ["phase", artifact?.finalState.phase ?? selectedMatch?.state.phase ?? "n/a"],
                  ["day", artifact?.finalState.day ?? selectedMatch?.state.day ?? "n/a"],
                  ["trajectory", artifact?.trajectory.length ?? selectedMatch?.trajectorySteps ?? 0],
                  ["messages", messages.length],
                  ["metrics", metrics.length]
                ])}
              />
            </Card>

            <Card size="small" title="Run Limits">
              <Form layout="vertical" size="small">
                <Form.Item label="最大 transitions">
                  <Input
                    aria-label="最大 transitions"
                    inputMode="numeric"
                    value={maxTransitions}
                    onChange={(event) => setMaxTransitions(event.target.value)}
                  />
                </Form.Item>
                <Form.Item label="超时秒数">
                  <Input
                    aria-label="超时秒数"
                    inputMode="numeric"
                    value={timeoutSeconds}
                    onChange={(event) => setTimeoutSeconds(event.target.value)}
                  />
                </Form.Item>
              </Form>
            </Card>
          </Flex>
        </Sider>

        <Layout>
          <Header style={{ borderBlockEnd: "1px solid #f0f0f0", height: "auto", padding: "12px 20px" }}>
            <Flex gap="middle" justify="space-between" align="center" wrap="wrap">
              <Flex vertical gap={4}>
                <Breadcrumb
                  items={[
                    { title: "Harness" },
                    { title: workspaceItems.find((item) => item.id === workspace)?.label ?? workspace },
                    { title: currentMatchId ? shortId(currentMatchId) : "未选择 run" }
                  ]}
                />
                <Text type="secondary">研究运行、轨迹复现、社会交互、评测指标和工件对比都从 API / artifact 读取。</Text>
              </Flex>
              <Space wrap>
                <Select
                  aria-label="模型选择"
                  value={selectedModel}
                  style={{ width: 184 }}
                  options={(models.length ? models : [selectedModel]).map((model) => ({ value: model, label: model }))}
                  onChange={setSelectedModel}
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

          <Layout>
            <Content style={{ minWidth: 0, padding: 20 }}>
              <div role="status" aria-live="polite">
                <StatusBanner status={status} error={error} busy={busy} />
              </div>

              <KpiGrid matches={matches} artifact={artifact} comparison={comparison} replay={replay} />

              <Card style={{ marginTop: 16 }}>
                <Tabs destroyOnHidden activeKey={workspace} items={tabItems} onChange={(key) => handleWorkspaceChange(key as Workspace)} />
              </Card>
            </Content>

            <Sider width={384} breakpoint="lg" collapsedWidth={0} style={{ borderInlineStart: "1px solid #f0f0f0", background: "#ffffff" }}>
              <InspectorPanel item={inspector} onOpenRaw={() => setRawOpen(true)} artifactView={artifactView} />
            </Sider>
          </Layout>
        </Layout>

        <Drawer
          title={inspector?.title ?? "原始证据片段"}
          width={760}
          open={rawOpen}
          onClose={() => setRawOpen(false)}
          extra={<Tag color="processing">{artifactView}</Tag>}
        >
          <Paragraph type="secondary">只读片段来自当前服务端投影。private evidence redacted，postgame truth visible。</Paragraph>
          <Input.TextArea readOnly value={JSON.stringify(inspector?.json ?? inspector ?? null, null, 2)} autoSize={{ minRows: 24, maxRows: 40 }} />
        </Drawer>
      </Layout>
    </ConfigProvider>
  );
}

function StatusBanner({ status, error, busy }: { status: string; error: string | null; busy: string | null }) {
  return (
    <Alert
      showIcon
      type={error ? "error" : busy ? "info" : "success"}
      icon={error ? <WarningOutlined /> : <CheckCircleOutlined />}
      message={error ? `${status}: ${error}` : status}
      action={<Tag color={error ? "error" : busy ? "processing" : "success"}>{error ? "error" : busy ? busy : "ready"}</Tag>}
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
  const completed = matches.filter((match) => match.status === "completed").length;
  const failed = matches.filter((match) => match.status === "failed").length;
  const replayOk = replay?.summary?.ok;
  return (
    <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
      <Col xs={24} sm={12} xl={6}>
        <Card>
          <Statistic title="runs" value={`${completed}/${matches.length}`} prefix={<DatabaseOutlined />} suffix={<Text type="secondary">failed {failed}</Text>} />
        </Card>
      </Col>
      <Col xs={24} sm={12} xl={6}>
        <Card>
          <Statistic
            title="trajectory"
            value={artifact ? artifact.trajectory.length : 0}
            prefix={<BranchesOutlined />}
            suffix={<Text type="secondary">{artifact ? shortId(artifact.runId) : "未加载"}</Text>}
          />
        </Card>
      </Col>
      <Col xs={24} sm={12} xl={6}>
        <Card>
          <Statistic
            title="social evidence"
            value={artifact ? artifact.socialEpisode.messages.length : 0}
            prefix={<MessageOutlined />}
            suffix={<Text type="secondary">{artifact ? `${artifact.socialEpisode.channels.length} channels` : "无证据"}</Text>}
          />
        </Card>
      </Col>
      <Col xs={24} sm={12} xl={6}>
        <Card>
          <Statistic
            title="compare / replay"
            value={comparison ? `${comparison.summary.changedRowCount}/${comparison.summary.rowCount}` : replayOk ? "replay ok" : "pending"}
            prefix={<SwapOutlined />}
            suffix={<Text type="secondary">{comparison ? "changed rows" : replay ? `mismatch ${replay.summary?.mismatchCount ?? 0}` : "未运行"}</Text>}
          />
        </Card>
      </Col>
    </Row>
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
    { title: "steps", dataIndex: "trajectorySteps", render: (value?: number) => value ?? 0 },
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
  onReplay,
  onDownload,
  artifactView,
  replay,
  busy
}: {
  artifact: ProjectedMatchArtifact | null;
  selectedStepIndex: number;
  selectedStep: HarnessStepRecord | null;
  onSelectStep: (index: number) => void;
  onReplay: () => void;
  onDownload: () => void;
  artifactView: ArtifactView;
  replay: ReplayResponse | null;
  busy: string | null;
}) {
  const steps = artifact?.trajectory ?? [];
  const socialSteps = artifact?.socialEpisode.steps ?? [];
  const socialStepByTraceId = useMemo(() => new Map(socialSteps.map((step) => [step.traceId, step])), [socialSteps]);
  const selectedSocialStep = selectedStep ? socialStepByTraceId.get(selectedStep.traceId) ?? null : null;
  const schedulerCounts = useMemo(() => countSocialSchedulerModes(socialSteps), [socialSteps]);
  const completedStreams = steps.filter((step) => step.reasonerOutput.stream?.completed).length;
  const progress = steps.length ? ((selectedStepIndex + 1) / steps.length) * 100 : 0;
  const columns: TableProps<HarnessStepRecord>["columns"] = [
    { title: "#", width: 64, render: (_, __, index) => index + 1 },
    { title: "actor", dataIndex: "actorId", render: (actorId: string) => <Text code>{actorId}</Text> },
    { title: "scheduler", render: (_, step) => <SchedulerTag mode={socialStepByTraceId.get(step.traceId)?.schedulerMode} /> },
    { title: "action", render: (_, step) => readPendingKind(step) },
    { title: "command", render: (_, step) => readCommandType(step.command) },
    { title: "confidence", render: (_, step) => formatNumber(step.policyPlan.confidence, 2) },
    { title: "messages", render: (_, step) => (step.messageSeqRange ? rangeLabel(step.messageSeqRange) : "none") },
    { title: "events", render: (_, step) => rangeLabel(step.eventSeqRange) }
  ];
  const schedulerColumns: TableProps<ProjectedSocialStep>["columns"] = [
    { title: "#", width: 64, render: (_, __, index) => index + 1 },
    { title: "trace", dataIndex: "traceId", render: (traceId: string) => <Text code>{shortId(traceId)}</Text> },
    { title: "actor", dataIndex: "actorId", render: (actorId: string) => <Text code>{actorId}</Text> },
    { title: "scheduler", dataIndex: "schedulerMode", render: (mode: ProjectedSocialStep["schedulerMode"]) => <SchedulerTag mode={mode} /> },
    { title: "batch", dataIndex: "batchId", render: (batchId?: string) => (batchId ? <Text code>{shortId(batchId)}</Text> : "n/a") },
    { title: "command", render: (_, step) => readSocialCommandType(step) },
    { title: "message seq", render: (_, step) => (step.messageSeqRange ? rangeLabel(step.messageSeqRange) : "none") },
    { title: "state", render: (_, step) => `${shortId(step.preStateHash)} -> ${shortId(step.postStateHash)}` }
  ];

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={15}>
        <Card
          title="时间线"
          extra={
            <Space wrap>
              <Tag>{artifactView}</Tag>
              <Button icon={decorativeIcon(<CloudDownloadOutlined />)} onClick={onDownload} disabled={!artifact}>
                JSONL
              </Button>
              <Button type="primary" icon={decorativeIcon(<PlayCircleOutlined />)} onClick={onReplay} disabled={!artifact || busy === "replay"} loading={busy === "replay"}>
                复现
              </Button>
            </Space>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Text type="secondary">每一行对应 harness committed step，不重新调用模型。</Text>
            <Row gutter={[12, 12]}>
              <Col xs={24} sm={12} xl={6}>
                <Statistic title="committed steps" value={steps.length} prefix={<BranchesOutlined />} />
              </Col>
              <Col xs={24} sm={12} xl={6}>
                <Statistic title="scheduler steps" value={socialSteps.length} prefix={<ApiOutlined />} />
              </Col>
              <Col xs={24} sm={12} xl={6}>
                <Statistic title="streams completed" value={`${completedStreams}/${steps.length || 0}`} prefix={<CheckCircleOutlined />} />
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
              columns={columns}
              dataSource={steps}
              pagination={{ pageSize: 10 }}
              rowSelection={{
                type: "radio",
                selectedRowKeys: selectedStep?.traceId ? [selectedStep.traceId] : []
              }}
              onRow={(_, index) => ({ onClick: () => onSelectStep(index ?? 0) })}
              locale={{ emptyText: <Empty description="尚未加载 trajectory。先从运行注册表或顶部加载最近 artifact。" /> }}
            />
            <Flex justify="space-between" align="center" wrap="wrap" gap="small">
              <Title level={5} style={{ margin: 0 }}>
                Scheduler Waterfall
              </Title>
              <Tag>socialEpisode.steps</Tag>
            </Flex>
            <Table
              rowKey="traceId"
              size="small"
              bordered
              columns={schedulerColumns}
              dataSource={socialSteps}
              pagination={{ pageSize: 6 }}
              rowSelection={{
                type: "radio",
                selectedRowKeys: selectedStep?.traceId ? [selectedStep.traceId] : []
              }}
              onRow={(socialStep) => ({
                onClick: () => {
                  const index = steps.findIndex((step) => step.traceId === socialStep.traceId);
                  if (index >= 0) onSelectStep(index);
                }
              })}
              locale={{ emptyText: <Empty description="当前 artifact 没有 socialEpisode.steps。" /> }}
            />
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
                  ["trace", shortId(selectedStep.traceId)],
                  ["actor", selectedStep.actorId],
                  ["profile", selectedStep.profileId ?? "n/a"],
                  ["model", selectedStep.model],
                  ["scheduler", selectedSocialStep?.schedulerMode ?? "n/a"],
                  ["batch", selectedSocialStep?.batchId ? shortId(selectedSocialStep.batchId) : "n/a"],
                  ["resolution", selectedSocialStep?.resolutionPolicy ?? "n/a"],
                  ["pending", readPendingKind(selectedStep)],
                  ["command", readCommandType(selectedStep.command)],
                  ["pre hash", shortId(selectedStep.preStateHash)],
                  ["post hash", shortId(selectedStep.postStateHash)],
                  ["message seq", selectedStep.messageSeqRange ? rangeLabel(selectedStep.messageSeqRange) : "none"],
                  ["event seq", rangeLabel(selectedStep.eventSeqRange)]
                ])}
              />
              <Card size="small" title="Policy arbitration">
                <Space direction="vertical" size="small" style={{ width: "100%" }}>
                  <Text strong>{selectedStep.policyPlan.intent}</Text>
                  <Text type="secondary">{selectedStep.policyPlan.strategyTags.join(" · ") || "no strategy tags"}</Text>
                  {selectedStep.policyPlan.arbitration?.candidates?.length ? (
                    <Timeline
                      items={selectedStep.policyPlan.arbitration.candidates.slice(0, 4).map((candidate) => ({
                        children: (
                          <Flex justify="space-between" gap="middle">
                            <Text code>{candidate.targetId}</Text>
                            <Text>{formatNumber(candidate.finalScore, 2)}</Text>
                          </Flex>
                        )
                      }))}
                    />
                  ) : null}
                </Space>
              </Card>
              <Card size="small" title="Reasoner telemetry">
                <Descriptions
                  size="small"
                  column={1}
                  items={descriptionItems([
                    ["latency", `${selectedStep.reasonerOutput.latencyMs}ms`],
                    ["prompt tokens", selectedStep.reasonerOutput.promptTokens ?? "n/a"],
                    ["completion tokens", selectedStep.reasonerOutput.completionTokens ?? "n/a"],
                    ["stream", selectedStep.reasonerOutput.stream?.completed ? "completed" : selectedStep.reasonerOutput.stream ? "recorded" : "n/a"]
                  ])}
                />
              </Card>
              {replay ? (
                <Card size="small" title="Replay validation">
                  <Descriptions
                    size="small"
                    column={1}
                    items={descriptionItems([
                      ["ok", String(Boolean(replay.summary?.ok))],
                      ["commands", replay.summary?.replayedCommands ?? 0],
                      ["hash matches", String(replay.summary?.finalHashMatchesArtifact ?? replay.summary?.finalHashMatchesExpected ?? false)],
                      ["mismatches", replay.summary?.mismatchCount ?? 0]
                    ])}
                  />
                </Card>
              ) : null}
            </Space>
          ) : (
            <Empty description="没有选中 step。加载 artifact 后点击左侧 trace 行。" />
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
  onSelectMessage
}: {
  artifact: ProjectedMatchArtifact | null;
  agents: AgentHarnessState[];
  selectedAgent: AgentHarnessState | null;
  messages: SocialMessage[];
  channels: SocialChannel[];
  onSelectAgent: (agent: AgentHarnessState) => void;
  onSelectMessage: (message: SocialMessage) => void;
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
    { title: "beliefs", render: (_, agent) => Object.keys(agent.beliefs ?? {}).length }
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
    { title: "content", dataIndex: "content", ellipsis: true }
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
    { title: "trace", render: (_, checkpoint) => (checkpoint.source.traceRef ? <Text code>{checkpoint.source.traceRef}</Text> : "final") },
    { title: "turn", render: (_, checkpoint) => checkpoint.source.turnIndex ?? "n/a" },
    { title: "trajectory", render: (_, checkpoint) => checkpoint.counts.trajectorySteps },
    { title: "messages", render: (_, checkpoint) => checkpoint.counts.socialMessages },
    { title: "state hash", render: (_, checkpoint) => <Text code>{shortId(checkpoint.source.stateHash)}</Text> },
    {
      title: "action",
      fixed: "right",
      align: "right",
      render: (_, checkpoint) => (
        <Button
          size="small"
          icon={decorativeIcon(<BranchesOutlined />)}
          loading={busy === "branch-tree" && selectedCheckpointId === checkpoint.checkpointId}
          onClick={() => onLoadBranchTree(checkpoint.checkpointId)}
        >
          Branch Tree
        </Button>
      )
    }
  ];

  const checkpointNodeColumns: TableProps<NonNullable<BranchTreeSummary["checkpoints"]>[number]>["columns"] = [
    { title: "depth", dataIndex: "depth", width: 72 },
    { title: "checkpoint", dataIndex: "checkpointId", render: (value?: string) => <Text code>{shortId(value)}</Text> },
    { title: "created", dataIndex: "createdAt", render: (value?: string) => (value ? formatDate(value) : "n/a") },
    { title: "child forks", dataIndex: "childForkCount", render: (value?: number) => value ?? 0 },
    { title: "trajectory", render: (_, node) => node.summary?.counts.trajectorySteps ?? "n/a" },
    { title: "messages", render: (_, node) => node.summary?.counts.socialMessages ?? "n/a" }
  ];
  const matchNodeColumns: TableProps<NonNullable<BranchTreeSummary["matches"]>[number]>["columns"] = [
    { title: "depth", dataIndex: "depth", width: 72 },
    { title: "run", dataIndex: "runId", render: (value?: string) => <Text code>{shortId(value)}</Text> },
    { title: "match", dataIndex: "matchId", render: (value?: string | null) => (value ? <Text code>{shortId(value)}</Text> : "n/a") },
    { title: "status", dataIndex: "status", render: (value?: string) => (value ? <StatusTag status={value} /> : "n/a") },
    { title: "trajectory", dataIndex: "trajectoryLength", render: (value?: number) => value ?? 0 },
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
            <Statistic title="selected prefix" value={selectedCheckpoint?.counts.trajectorySteps ?? 0} prefix={<BranchesOutlined />} suffix={<Text type="secondary">trajectory</Text>} />
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
                  ["new steps", forkLineage.boundary?.newTrajectorySteps ?? "n/a"],
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
  onInspectMetric: (metric: HarnessMetricRecord) => void;
  onInspectWarning: (warning: HarnessEvaluationWarning) => void;
}) {
  const summary = artifact?.evaluationReport.summary;
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
    { title: "source", render: (_, metric) => metric.evaluatorId ?? metric.source },
    { title: "evidence", render: (_, metric) => metric.evidenceRefs?.length ?? 0 }
  ];
  const warningColumns: TableProps<HarnessEvaluationWarning>["columns"] = [
    { title: "severity", dataIndex: "severity", render: (severity: HarnessEvaluationWarning["severity"]) => <SeverityTag severity={severity} /> },
    { title: "code", dataIndex: "code" },
    { title: "evaluator", dataIndex: "evaluatorId", render: (value?: string) => value ?? "n/a" },
    { title: "message", dataIndex: "message", ellipsis: true },
    { title: "evidence", render: (_, warning) => warning.evidenceRefs?.length ?? 0 }
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
            <Statistic title="metrics" value={metrics.length} prefix={<DatabaseOutlined />} />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="warnings" value={warnings.length} prefix={<WarningOutlined />} />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="agent rewards" value={artifact?.evaluation.agentRewards.length ?? 0} prefix={<TeamOutlined />} suffix={<Text type="secondary">{artifact?.evaluation.winner ?? "winner n/a"}</Text>} />
          </Card>
        </Col>
      </Row>

      <Card title="指标表">
        <Text type="secondary">每条 metric 保留 evaluator、scope、subject、evidence refs。</Text>
        <Table
          rowKey={(metric) => `${metric.id}-${metric.subjectId ?? "episode"}`}
          size="small"
          bordered
          columns={metricColumns}
          dataSource={metrics}
          pagination={{ pageSize: 8 }}
          onRow={(metric) => ({ onClick: () => onInspectMetric(metric) })}
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
  candidates,
  candidateId,
  onCandidateChange,
  onLoadComparison,
  busy,
  onInspectRow
}: {
  artifact: ProjectedMatchArtifact | null;
  candidateArtifact: ProjectedMatchArtifact | null;
  comparison: MatchComparisonArtifact | null;
  candidates: MatchRecord[];
  candidateId: string;
  onCandidateChange: (value: string) => void;
  onLoadComparison: () => void;
  busy: string | null;
  onInspectRow: (row: MatchComparisonRow) => void;
}) {
  const rowColumns: TableProps<MatchComparisonRow>["columns"] = [
    {
      title: "row",
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Text strong>{row.label}</Text>
          <Text code>{row.id}</Text>
        </Space>
      )
    },
    { title: "baseline", dataIndex: "baseline", render: (value: unknown) => String(value) },
    { title: "candidate", dataIndex: "candidate", render: (value: unknown) => String(value) },
    { title: "delta", dataIndex: "delta", render: (value?: number) => (value === undefined ? "n/a" : formatNumber(value, 2)) },
    { title: "changed", dataIndex: "changed", render: (changed: boolean) => <Tag color={changed ? "processing" : "default"}>{changed ? "changed" : "same"}</Tag> }
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="Baseline / Candidate"
        extra={
          <Space wrap>
            <Select
              aria-label="候选运行"
              value={candidateId || undefined}
              placeholder="选择候选运行"
              style={{ width: 300 }}
              virtual={false}
              options={candidates.map((match) => ({
                value: match.id,
                label: `${shortId(match.id)} · ${match.state.phase} · ${formatDate(match.createdAt)}`
              }))}
              onChange={onCandidateChange}
            />
            <Button type="primary" icon={decorativeIcon(<SwapOutlined />)} loading={busy === "compare"} disabled={!artifact || !candidateId || busy === "compare"} onClick={onLoadComparison}>
              加载对比工件
            </Button>
          </Space>
        }
      >
        <Text type="secondary">对比来自 `/api/matches/:id/compare/:candidateId?view=postgame-redacted`。</Text>
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
        extra={comparison ? <Tag color="processing">changed {comparison.summary.changedRowCount}/{comparison.summary.rowCount}</Tag> : <Tag>未加载</Tag>}
      >
        <Table
          rowKey="id"
          size="small"
          bordered
          columns={rowColumns}
          dataSource={comparison?.rows ?? []}
          pagination={{ pageSize: 10 }}
          onRow={(row) => ({ onClick: () => onInspectRow(row) })}
          locale={{ emptyText: <Empty description="选择候选运行后点击加载，UI 会等待真实 comparison API。" /> }}
        />
      </Card>
    </Space>
  );
}

function ArtifactSummary({ title, artifact }: { title: string; artifact: ProjectedMatchArtifact | null }) {
  return (
    <Card
      size="small"
      title={title}
      extra={
        artifact?.projection ? (
          <Tag color="processing">
            {artifact.projection.view} · private={artifact.projection.privateEvidenceRedacted ? "redacted" : "visible"}
          </Tag>
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
            ["seed", artifact.seed],
            ["models", artifact.models.join(", ") || "n/a"],
            ["trajectory", artifact.trajectory.length],
            ["messages", artifact.socialEpisode.messages.length],
            ["metrics", artifact.evaluationReport.metricCount],
            ["winner", artifact.finalState.winner ?? "n/a"]
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

function assertPostgameRedactedArtifact(artifact: ProjectedMatchArtifact, label: string): void {
  if (artifact.projection?.view !== "postgame-redacted" || artifact.projection.privateEvidenceRedacted !== true) {
    throw new Error(`${label} must be a postgame-redacted projection.`);
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
  if (artifact.runId !== id && artifact.matchId !== id) {
    throw new Error(`${label} identity mismatch: expected ${shortId(id)}, got ${shortId(artifact.matchId ?? artifact.runId)}.`);
  }
}

function assertPostgameRedactedComparison(comparison: MatchComparisonArtifact): void {
  if (comparison.projection.view !== "postgame-redacted" || comparison.projection.privateEvidenceRedacted !== true) {
    throw new Error("comparison artifact must be a postgame-redacted projection.");
  }
}

function assertComparisonMatchesIds(comparison: MatchComparisonArtifact, baselineId: string, candidateId: string): void {
  const baselineMatches = comparison.baseline.runId === baselineId || comparison.baseline.matchId === baselineId;
  const candidateMatches = comparison.candidate.runId === candidateId || comparison.candidate.matchId === candidateId;
  if (!baselineMatches || !candidateMatches) {
    throw new Error(`comparison identity mismatch: expected ${shortId(baselineId)} vs ${shortId(candidateId)}.`);
  }
}

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

function readPendingKind(step: HarnessStepRecord): string {
  const pending = step.pendingAction as unknown;
  return isRecord(pending) && typeof pending.kind === "string" ? pending.kind : "unknown";
}

function readCommandType(command: GameCommand): string {
  return isRecord(command) && typeof command.type === "string" ? command.type : "unknown";
}

function readSocialCommandType(step: ProjectedSocialStep): string {
  const action = step.action as unknown;
  const command = isRecord(action) ? action.command : undefined;
  return isRecord(command) && typeof command.type === "string" ? command.type : "unknown";
}

function rangeLabel(range: [number, number]): string {
  return `${range[0]}-${range[1]}`;
}

function inspectorFromArtifact(artifact: ProjectedMatchArtifact): InspectorItem {
  return {
    kind: "artifact",
    title: `Match Artifact ${shortId(artifact.runId)}`,
    subtitle: `${artifact.artifactVersion} · ${artifact.status}`,
    fields: [
      ["run", artifact.runId],
      ["seed", artifact.seed],
      ["status", artifact.status],
      ["trajectory", artifact.trajectory.length],
      ["messages", artifact.socialEpisode.messages.length],
      ["metrics", artifact.evaluationReport.metricCount],
      ["winner", artifact.finalState.winner ?? "n/a"]
    ],
    json: {
      artifactVersion: artifact.artifactVersion,
      runId: artifact.runId,
      projection: artifact.projection,
      status: artifact.status,
      trajectorySteps: artifact.trajectory.length,
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
      ["phase", match.state.phase],
      ["seed", match.state.seed],
      ["models", match.models.join(", ")],
      ["artifact", String(Boolean(match.hasArtifact))],
      ["steps", match.trajectorySteps ?? 0]
    ],
    json: match
  };
}

function inspectorFromStep(step: HarnessStepRecord, index: number): InspectorItem {
  return {
    kind: "trace-step",
    title: `Trace Step #${index + 1}`,
    subtitle: `${step.actorId} · ${readCommandType(step.command)}`,
    fields: [
      ["trace", step.traceId],
      ["actor", step.actorId],
      ["profile", step.profileId ?? "n/a"],
      ["model", step.model],
      ["pending", readPendingKind(step)],
      ["command", readCommandType(step.command)],
      ["confidence", step.policyPlan.confidence],
      ["pre hash", step.preStateHash],
      ["post hash", step.postStateHash]
    ],
    json: safeStepInspectorJson(step, index)
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

function inspectorFromMetric(metric: HarnessMetricRecord): InspectorItem {
  return {
    kind: "metric",
    title: metric.label,
    subtitle: `${metric.id} · ${metric.scope}`,
    fields: [
      ["value", metric.value],
      ["scope", metric.scope],
      ["subject", metric.subjectId ?? "episode"],
      ["source", metric.evaluatorId ?? metric.source],
      ["confidence", metric.confidence ?? "n/a"],
      ["evidence", metric.evidenceRefs?.length ?? 0]
    ],
    json: metric
  };
}

function inspectorFromWarning(warning: HarnessEvaluationWarning): InspectorItem {
  return {
    kind: "evaluation-warning",
    title: warning.code,
    subtitle: warning.severity,
    fields: [
      ["severity", warning.severity],
      ["evaluator", warning.evaluatorId ?? "n/a"],
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
    title: `Comparison ${shortId(comparison.comparisonId)}`,
    subtitle: `${comparison.artifactVersion} · ${comparison.view}`,
    fields: [
      ["baseline", comparison.baseline.matchId ?? comparison.baseline.runId],
      ["candidate", comparison.candidate.matchId ?? comparison.candidate.runId],
      ["rows", comparison.summary.rowCount],
      ["changed", comparison.summary.changedRowCount],
      ["numeric delta", comparison.summary.numericDeltaCount],
      ["projection", comparison.projection.view]
    ],
    json: comparison
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
      ["changed", String(row.changed)]
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
      ["commands", replay.summary?.replayedCommands ?? 0],
      ["hash matches", String(replay.summary?.finalHashMatchesArtifact ?? replay.summary?.finalHashMatchesExpected ?? false)],
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
      ["trace", checkpoint.source.traceRef ?? "final"],
      ["turn", checkpoint.source.turnIndex ?? "n/a"],
      ["trajectory", checkpoint.counts.trajectorySteps],
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

function safeStepInspectorJson(step: HarnessStepRecord, index: number): Record<string, unknown> {
  return {
    kind: "trace-step",
    index,
    traceId: step.traceId,
    turnIndex: step.turnIndex,
    actorId: step.actorId,
    profileId: step.profileId,
    model: step.model,
    pendingActionKind: readPendingKind(step),
    commandType: readCommandType(step.command),
    policy: {
      name: step.policyPlan.policyName,
      intent: step.policyPlan.intent,
      confidence: step.policyPlan.confidence,
      strategyTags: step.policyPlan.strategyTags,
      targetId: step.policyPlan.targetId,
      arbitrationCandidateCount: step.policyPlan.arbitration?.candidates.length ?? 0
    },
    telemetry: {
      latencyMs: step.reasonerOutput.latencyMs,
      promptTokens: step.reasonerOutput.promptTokens,
      completionTokens: step.reasonerOutput.completionTokens,
      streamCompleted: step.reasonerOutput.stream?.completed ?? null,
      providerRequestId: step.reasonerOutput.providerRequestId ?? null,
      attempts: step.reasonerOutput.attempts ?? null
    },
    hashes: {
      decisionStateHash: step.decisionStateHash,
      preStateHash: step.preStateHash,
      postStateHash: step.postStateHash,
      agentStateHash: step.agentStateHash
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
  if (artifact.projection?.view === "postgame-redacted") {
    return [];
  }
  return deriveSocialExposureRecords(artifact.socialEpisode);
}
