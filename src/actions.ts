import type { Store } from "./storage.js";
import { evaluatePolicy } from "./policy.js";
import type { ActionContext, AuditResult, ProviderId } from "./types.js";

/**
 * The single choke point through which every provider action must pass.
 *
 * Guarantees (from the V0 spec):
 *   - project + environment + policy are resolved BEFORE any provider call;
 *   - blocked / approval_required actions never execute;
 *   - every attempt is written to the audit log exactly once.
 *
 * Tools build an ActionContext, then call `runGuarded` with an `exec` thunk
 * that performs the real provider API call. If policy doesn't allow it, `exec`
 * is never invoked.
 */

export interface ApprovalRequiredResponse {
  status: "approval_required";
  policy_decision: "approval_required";
  executed: false;
  reason: string;
  project: string;
  environment: string;
  provider: ProviderId;
  action: string;
  suggested_next_step: string;
}

export interface BlockedResponse {
  status: "blocked";
  policy_decision: "block";
  executed: false;
  reason: string;
  project: string;
  environment: string;
  provider: ProviderId;
  action: string;
  suggested_next_step: string;
}

export interface OkResponse {
  status: "ok";
  policy_decision: "allow";
  executed: true;
  project: string;
  environment: string;
  provider: ProviderId;
  action: string;
  mode?: string;
  reason: string;
  data: unknown;
}

export interface ErrorResponse {
  status: "error";
  policy_decision: "allow";
  executed: true;
  project: string;
  environment: string;
  provider: ProviderId;
  action: string;
  error: string;
}

export type GuardedResponse =
  | ApprovalRequiredResponse
  | BlockedResponse
  | OkResponse
  | ErrorResponse;

export async function runGuarded(
  store: Store,
  ctx: ActionContext,
  exec: () => Promise<unknown>,
): Promise<GuardedResponse> {
  const decision = evaluatePolicy(store.data.policyRules, ctx);
  const base = {
    project: ctx.project.slug,
    environment: ctx.environment.name,
    provider: ctx.provider,
    action: ctx.tool,
  };

  function audit(result: AuditResult, errorMessage?: string): void {
    store.appendAudit({
      timestamp: new Date().toISOString(),
      projectSlug: ctx.project.slug,
      environment: ctx.environment.name,
      provider: ctx.provider,
      tool: ctx.tool,
      actionSummary: ctx.summary,
      policyDecision: decision.effect,
      result,
      errorMessage,
      providerResource: ctx.resourceLabel,
    });
  }

  const mode = ctx.provider === "stripe" ? ctx.resourceLabel : undefined;

  if (decision.effect === "block") {
    audit("not_executed");
    return {
      ...base,
      status: "blocked",
      policy_decision: "block",
      executed: false,
      reason: decision.reason,
      suggested_next_step:
        "This action is blocked by policy. If it is genuinely safe, add an explicit " +
        "allow rule with set_policy_rule, then retry.",
    };
  }

  if (decision.effect === "approval_required") {
    audit("not_executed");
    return {
      ...base,
      status: "approval_required",
      policy_decision: "approval_required",
      executed: false,
      reason: decision.reason,
      suggested_next_step:
        "Approve manually by adding an allow PolicyRule (set_policy_rule) for this " +
        "project/environment/provider/capability, then rerun. A first-class approval " +
        "flow will replace this in a later version.",
    };
  }

  // effect === "allow": execute the real provider call.
  try {
    const data = await exec();
    audit("success");
    return { ...base, status: "ok", policy_decision: "allow", executed: true, mode, reason: decision.reason, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    audit("error", message);
    return { ...base, status: "error", policy_decision: "allow", executed: true, error: message };
  }
}
