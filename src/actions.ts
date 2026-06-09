import type { Store } from "./storage.js";
import { evaluatePolicy } from "./policy.js";
import type { ActionContext, AuditResult, PendingApproval, PolicyEffect, ProviderId } from "./types.js";
import { newId, nowIso } from "./util.js";

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
  approval_id: string;
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

export interface PreExecutionErrorResponse {
  status: "error";
  policy_decision: PolicyEffect;
  executed: false;
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
  | ErrorResponse
  | PreExecutionErrorResponse;

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

  const mode = ctx.provider === "stripe" ? ctx.resourceLabel : undefined;

  try {
    return await store.withAuditLock(async (appendAudit) => {
      function audit(result: AuditResult, errorMessage?: string): void {
        auditWithDecision(result, decision.effect, errorMessage);
      }

      function auditWithDecision(result: AuditResult, policyDecision: PolicyEffect, errorMessage?: string): void {
        appendAudit({
          timestamp: new Date().toISOString(),
          projectSlug: ctx.project.slug,
          environment: ctx.environment.name,
          provider: ctx.provider,
          tool: ctx.tool,
          actionSummary: ctx.summary,
          policyDecision,
          result,
          errorMessage,
          providerResource: ctx.resourceLabel,
        });
      }

      const approvalMatches = (approval: PendingApproval): boolean =>
        approval.projectId === ctx.project.id &&
        approval.environmentId === ctx.environment.id &&
        approval.provider === ctx.provider &&
        approval.capability === ctx.capability &&
        approval.tool === ctx.tool &&
        approval.providerResource === ctx.resourceLabel;

      async function executeAllowed(reason: string): Promise<OkResponse | ErrorResponse> {
        try {
          const data = await exec();
          auditWithDecision("success", "allow");
          return { ...base, status: "ok", policy_decision: "allow", executed: true, mode, reason, data };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          auditWithDecision("error", "allow", message);
          return { ...base, status: "error", policy_decision: "allow", executed: true, error: message };
        }
      }

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
        const approved = store.data.pendingApprovals.find((p) => p.status === "approved" && approvalMatches(p));
        if (approved) {
          store.update((s) => {
            const current = s.pendingApprovals.find((p) => p.id === approved.id);
            if (!current || current.status !== "approved") {
              throw new Error(`Approval request "${approved.id}" is no longer approved.`);
            }
            current.status = "used";
            current.usedAt = nowIso();
          });
          return executeAllowed(`Approved by approval request ${approved.id}.`);
        }

        let approval: PendingApproval | undefined;
        store.update((s) => {
          approval = s.pendingApprovals.find((p) => p.status === "pending" && approvalMatches(p));
          if (!approval) {
            approval = {
              id: newId("approval"),
              projectId: ctx.project.id,
              environmentId: ctx.environment.id,
              provider: ctx.provider,
              capability: ctx.capability,
              tool: ctx.tool,
              actionSummary: ctx.summary,
              reason: decision.reason,
              providerResource: ctx.resourceLabel,
              status: "pending",
              createdAt: nowIso(),
            };
            s.pendingApprovals.push(approval);
          }
        });
        audit("not_executed");
        return {
          ...base,
          status: "approval_required",
          policy_decision: "approval_required",
          executed: false,
          approval_id: approval!.id,
          reason: decision.reason,
          suggested_next_step:
            `Review this request, then call approve_action with approval_id "${approval!.id}" ` +
            "or reject_action. Approved actions must be rerun; approval never executes a provider call by itself.",
        };
      }

      return executeAllowed(decision.reason);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      status: "error",
      policy_decision: decision.effect,
      executed: false,
      error: `Audit log unavailable; refusing to execute provider action. ${message}`,
    };
  }
}
