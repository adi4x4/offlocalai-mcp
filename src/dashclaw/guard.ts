import { OfflocalError } from "../util.js";
import type { DashclawDecision } from "./types.js";

export function normalizeDashclawDecision(value: unknown): DashclawDecision {
  if (value === "allow") return "allow";
  if (value === "block") return "block";
  if (value === "require_approval" || value === "approval_required") return "require_approval";
  throw new OfflocalError(`Unknown DashClaw decision "${String(value)}".`);
}
