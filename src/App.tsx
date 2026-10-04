import { lazy, Suspense, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PartnersApp } from "@/components/partners";

const GeneralApp = lazy(() => import("./GeneralApp").then(module => ({ default: module.App })));

/** Shared psychology across environments is the main application; all existing URLs remain readable. */
export function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { const changed = () => setHash(location.hash); window.addEventListener("hashchange", changed); return () => window.removeEventListener("hashchange", changed); }, []);
  const page = hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  if (["partners", "partners-study", "partners-intervention", "partners-settings", "partners-compare"].includes(page))
    return <PartnersApp onLegacy={() => { location.hash = "#/"; }} />;
  return <Suspense fallback={<Skeleton className="m-8 h-72" />}><GeneralApp /></Suspense>;
}
