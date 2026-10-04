import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "dark" | "light" | "system";
const key = "society:theme";
const ThemeContext = createContext<{ theme: Theme; resolved: "light" | "dark"; setTheme(theme: Theme): void } | undefined>(undefined);
const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<Theme>(() => {
    try { const value = localStorage.getItem(key); if (value === "light" || value === "dark" || value === "system") return value; } catch { /* Private browsing can disable storage. */ }
    return "dark";
  });
  const [prefersDark, setPrefersDark] = useState(systemDark);
  const resolved = theme === "system" ? prefersDark ? "dark" : "light" : theme;
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setPrefersDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => { document.documentElement.classList.toggle("dark", resolved === "dark"); }, [resolved]);
  function setTheme(next: Theme) { try { localStorage.setItem(key, next); } catch { /* Theme remains usable without persistence. */ } updateTheme(next); }
  return <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("ThemeProvider is missing");
  return context;
}
