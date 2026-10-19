import * as Sentry from "@sentry/nextjs";
import { AiProviderFailure, safeErrorDetails } from "./provider-failure";

export type FailureStage = "review" | "indexing" | "preparation" | "generation" | "publication";
export type RetryState = { retryCount: number; retryLimit: number };
export type FailureContext = {
  stage: FailureStage;
  attemptId?: string;
  repositoryId?: string;
  pullRequestId?: string;
  headSha?: string | null;
  requestVersion?: number;
  retry?: RetryState;
};
const reported = new WeakSet<object>();
const identifier = (value: string | null | undefined) => value && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : undefined;

/** Report once at the terminal handler, never at every provider/SDK attempt. */
export function reportBackgroundFailure(error: unknown, context: FailureContext): string | undefined {
  try {
    if (context.retry && context.retry.retryCount < context.retry.retryLimit) return;
    if (error && typeof error === "object" && reported.has(error)) return;
    const providerFailure = error instanceof AiProviderFailure ? error : undefined;
    const details = providerFailure?.details ?? safeErrorDetails(error);
    const status = details.status;
    const orgKeyFailure = providerFailure?.keyOwner === "organization" && [401, 402, 403, 429].includes(status ?? 0);
    // These are known application control-flow messages, not substring matches on provider payloads.
    const expected = !providerFailure && error instanceof Error && [
      "Out of credits", "Monthly spend limit reached", "Indexing cancelled",
      "Indexing attempt is no longer current",
    ].includes(error.message);
    if (orgKeyFailure || expected) return;
    const permissionFailure = !providerFailure && context.stage === "indexing" && error instanceof Error &&
      error.message.startsWith("GitHub App does not have access to ");
    if (permissionFailure) return;
    const ownership = providerFailure?.keyOwner === "platform" && status && ([401, 402, 403, 429].includes(status) || status >= 500)
      ? "platform" : "unknown";
    const code = details.code ?? (status ? `http_${status}` : "unclassified");
    const provider = providerFailure?.provider ?? "unknown";
    const stage = providerFailure && context.stage === "review" ? "generation" : context.stage;
    const eventId = Sentry.captureEvent({
      level: "error",
      message: `Background ${stage} failed: ${provider} / ${code}`,
      fingerprint: ["background-failure", stage, provider, code],
      tags: { error_boundary: "background", failure_stage: stage, failure_owner: ownership, failure_code: code, provider, outcome: "failed" },
      contexts: { background_failure: {
        ...details,
        stage, ownership, keyOwner: providerFailure?.keyOwner ?? "unknown",
        model: providerFailure && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(providerFailure.model) ? providerFailure.model : undefined,
        attemptId: identifier(context.attemptId), repositoryId: identifier(context.repositoryId),
        pullRequestId: identifier(context.pullRequestId), headSha: identifier(context.headSha),
        requestVersion: context.requestVersion, retryCount: context.retry?.retryCount ?? 0,
      } },
    });
    if (error && typeof error === "object") reported.add(error);
    return eventId;
  } catch {
    // Telemetry must never replace the original failure or change a review result.
    console.warn("[monitoring] Background failure reporting unavailable");
    return;
  }
}
