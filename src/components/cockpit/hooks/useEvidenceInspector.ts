import { useCallback, useRef, useState } from "react";

import type { InspectorItem } from "../appShared";

/**
 * Owns the evidence inspector selection plus the raw-JSON drawer and the two
 * compact-layout drawers (run context / inspector) with their focus-return
 * trigger refs.
 */
export function useEvidenceInspector({ isCompactLayout }: { isCompactLayout: boolean }) {
  const [inspector, setInspector] = useState<InspectorItem | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const mobileContextTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileInspectorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const rawReturnFocusRef = useRef<HTMLElement | null>(null);

  const revealInspector = useCallback(
    (nextInspector: InspectorItem) => {
      setInspector(nextInspector);
      if (isCompactLayout) setMobileInspectorOpen(true);
    },
    [isCompactLayout]
  );

  return {
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
  };
}
