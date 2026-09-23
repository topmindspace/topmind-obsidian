// Only modules without upstream .d.ts need ambient types.
// Prefer topmind/lib/*.d.mts (model-catalog, text-note, memory-feed, ai-content-sanitize).

declare module "#kernel/kernel-api.mjs" {
  // Bundled at build time; call sites cast to KernelApi (src/bridge/kernel-loader.ts).
  const kernelApi: Record<string, unknown>;
  export = kernelApi;
}
