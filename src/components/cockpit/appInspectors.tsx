/**
 * Barrel for the cockpit's evidence/inspector utilities. The implementation
 * now lives in focused modules; existing import sites keep working unchanged:
 * - ./apiClient         — JSON fetch wrapper for the harness API
 * - ./formatters        — pure value formatting / parsing / step readers
 * - ./artifactGuards    — server projection contract assertions
 * - ./packFiles         — tournament pack / matrix download file helpers
 * - ./InspectorPanel    — inspector UI components and tag primitives
 * - ./inspectorBuilders — InspectorItem builders for every evidence kind
 */
export * from "./apiClient";
export * from "./formatters";
export * from "./artifactGuards";
export * from "./packFiles";
export * from "./InspectorPanel";
export * from "./inspectorBuilders";
