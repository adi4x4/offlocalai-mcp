import { dashclawFetch } from "./client.js";
import type { DashclawOutcomeInput } from "./types.js";

export async function recordDashclawOutcome(input: DashclawOutcomeInput): Promise<boolean> {
  await dashclawFetch(`/api/actions/${encodeURIComponent(input.actionId)}/outcome`, {
    method: "POST",
    body: {
      status: input.status,
      duration_ms: input.durationMs,
      summary: input.summary,
      metadata: input.metadata,
      error_message: input.errorMessage,
    },
  });
  return true;
}
