/**
 * Barrel for the cockpit shell's shared building blocks. The implementation
 * now lives in focused modules; existing import sites keep working unchanged:
 * - ./cockpitTypes    — server DTO / projection contract types
 * - ./cockpitDefaults — run-limit defaults shared across the shell
 * - ./lazyBoards      — lazy() board declarations (code-split chunks)
 * - ./uiPrimitives    — Table wrapper + antd Layout/Typography shorthands
 * - ./workspaceNav    — workspace routing helpers and nav items
 */
export * from "./cockpitTypes";
export * from "./cockpitDefaults";
export * from "./lazyBoards";
export * from "./uiPrimitives";
export * from "./workspaceNav";
