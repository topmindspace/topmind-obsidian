// Only modules without upstream .d.ts need ambient types.
// Prefer topmind/lib/*.d.mts (model-catalog, text-note, memory-feed, ai-content-sanitize).

declare module "#kernel/kernel-api.mjs" {
  import type { KernelApi } from "../bridge/kernel-loader.ts";
  // Flat named-export module; hosts bind the namespace as one KernelApi object.
  const kernelApi: KernelApi;
  export = kernelApi;
}
