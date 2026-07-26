import { useCallback, useEffect, useState } from "react";

import { parseWorkspaceFromSearch, workspaceItems, type Workspace } from "../appShared";
import type { SetActionStatus } from "./useCockpitStatus";

/**
 * Owns the active workspace selection and keeps it mirrored into the
 * `?workspace=` search param (legacy `?tab=` is consumed then dropped).
 */
export function useWorkspaceRouting({ setActionStatus }: { setActionStatus: SetActionStatus }) {
  const [workspace, setWorkspace] = useState<Workspace>(() => parseWorkspaceFromSearch(window.location.search) ?? "runs");

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

  const activeWorkspace = workspaceItems.find((item) => item.id === workspace) ?? workspaceItems[0];

  return { workspace, setWorkspace, handleWorkspaceChange, activeWorkspace };
}
