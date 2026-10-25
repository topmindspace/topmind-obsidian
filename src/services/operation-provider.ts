import type { AiProvider } from "../bridge/ai-provider.ts";
import { isRecord } from "../utils.ts";
function aborted() { const error = new Error("Operation cancelled"); error.name = "AbortError"; return error; }
/** requestUrl cannot cancel its socket; abandon the result before Kernel consumes it. */
export function cancellableOperationProvider(provider: AiProvider, shouldAbort: () => boolean): AiProvider {
  return {
    async generate(prompt, context) {
      if (shouldAbort()) throw aborted();
      const original = isRecord(context) ? context : {};
      const result = await provider.generate(prompt, { ...original, shouldAbort });
      if (shouldAbort()) throw aborted();
      return result;
    },
  };
}
