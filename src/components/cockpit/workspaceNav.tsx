import type { ReactNode } from "react";
import type { MenuProps } from "antd";
import {
  ApiOutlined,
  BranchesOutlined,
  DatabaseOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  ShareAltOutlined,
  SwapOutlined,
  TeamOutlined
} from "@ant-design/icons";

import type { Workspace } from "./cockpitTypes";

export function parseWorkspaceFromSearch(search: string): Workspace | null {
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

export const workspaceItems: Array<{
  id: Workspace;
  label: string;
  description: string;
  icon: ReactNode;
}> = [
  { id: "runs", label: "运行", description: "实验注册表与真实执行", icon: <DatabaseOutlined /> },
  { id: "timeline", label: "时间线", description: "step / trace / action debugger", icon: <BranchesOutlined /> },
  { id: "domain", label: "领域适配器", description: "首个证明域（Werewolf）公开局面与赛后复盘", icon: <RobotOutlined /> },
  { id: "society", label: "社会", description: "agent、消息、关系证据", icon: <TeamOutlined /> },
  { id: "lineage", label: "谱系", description: "checkpoint、fork、branch tree", icon: <ApiOutlined /> },
  { id: "evaluation", label: "评测", description: "指标、证据、告警", icon: <SafetyCertificateOutlined /> },
  { id: "experiments", label: "实验矩阵", description: "矩阵控制面、统计与研究工件", icon: <DatabaseOutlined /> },
  { id: "compare", label: "对比", description: "基准与候选工件矩阵", icon: <SwapOutlined /> },
  { id: "packs", label: "公开包", description: "锦标赛工件与分享链接", icon: <ShareAltOutlined /> }
];

const menuItem = (item: (typeof workspaceItems)[number]) => ({
  key: item.id,
  icon: item.icon,
  label: item.label,
  title: item.description
});

export const workspaceMenuItems: MenuProps["items"] = [
  {
    type: "group",
    label: "执行",
    children: workspaceItems.filter((item) => item.id === "runs").map(menuItem)
  },
  {
    type: "group",
    label: "单局分析",
    children: workspaceItems
      .filter((item) => ["domain", "timeline", "society", "evaluation", "lineage"].includes(item.id))
      .map(menuItem)
  },
  {
    type: "group",
    label: "研究",
    children: workspaceItems
      .filter((item) => ["experiments", "compare", "packs"].includes(item.id))
      .map(menuItem)
  }
];
