import { useCallback, useState } from "react";

export type SetActionStatus = (message: string, nextError?: string | null) => void;

/**
 * Owns the cockpit-wide status banner text, error line and the single `busy`
 * mutex label. Every workspace action reports through `setActionStatus`.
 */
export function useCockpitStatus() {
  const [status, setStatus] = useState("正在连接 harness API...");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const setActionStatus = useCallback((message: string, nextError: string | null = null) => {
    setStatus(message);
    setError(nextError);
  }, []);

  return { status, error, busy, setBusy, setActionStatus };
}
