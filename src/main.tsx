import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import { App } from "./App";
import { TooltipProvider } from "./components/ui/tooltip";
import { Toaster } from "./components/ui/sonner";
import "./styles.css";

// Screenshot mode: hide provider/model identifiers so published screenshots
// never disclose the operator's configured models or endpoint.
if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot")) {
  document.documentElement.classList.add("shot-mode");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={250}>
      <App />
      <Toaster theme="dark" position="bottom-right" />
    </TooltipProvider>
  </StrictMode>
);
