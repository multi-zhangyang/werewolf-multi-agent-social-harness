import { describe, expect, it } from "vitest";
import { layoutSocialEvidenceGraph } from "../src/components/cockpit/SocialEvidenceGraph";
import type { SocialGraph } from "../src/App";

describe("social evidence graph layout", () => {
  it("uses a stable roster-sorted ring layout derived only from recorded graph counts", () => {
    const graph: SocialGraph = {
      nodes: [
        { id: "p3", sent: 1, received: 2, observed: 3 },
        { id: "p1", sent: 4, received: 0, observed: 1 },
        { id: "p2", sent: 0, received: 5, observed: 0 }
      ],
      messageEdges: [],
      exposureEdges: []
    };

    const first = layoutSocialEvidenceGraph(graph);
    const second = layoutSocialEvidenceGraph({ ...graph, nodes: [...graph.nodes].reverse() });

    expect(first).toEqual(second);
    expect(first.map((node) => node.id)).toEqual(["p1", "p2", "p3"]);
    expect(first.map((node) => node.activity)).toEqual([5, 5, 6]);
    expect(first.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    expect(new Set(first.map((node) => `${node.x}:${node.y}`)).size).toBe(first.length);
  });

  it("has no client-side graph positions when the recorded projection has no agents", () => {
    expect(layoutSocialEvidenceGraph({ nodes: [], messageEdges: [], exposureEdges: [] })).toEqual([]);
  });
});
