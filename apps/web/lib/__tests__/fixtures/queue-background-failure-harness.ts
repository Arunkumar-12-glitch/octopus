import { mock } from "bun:test";
import assert from "node:assert/strict";

const events: Array<{ contexts?: Record<string, Record<string, unknown>> }> = [];
mock.module("@sentry/nextjs", () => ({ captureEvent: (event: typeof events[number]) => { events.push(event); return "e".repeat(32); } }));
for (const [path, names] of Object.entries({
  "forgejo-connector": ["cleanupForgejoConnectorRequests"], "emails/welcome": ["sendWelcomeEmail"],
  "large-review-result": ["handleLargeReviewResult"], "community-review": ["processCommunityReview"],
  audit: ["enforceAuditLogRetention", "enforceActivityEventRetention"], "webhook-tenant": ["enforceWebhookDeliveryRetention"],
  releases: ["refreshReleaseCache"], subscription: ["renewDueSubscriptions"], credits: ["reconcileAutoReloadAttempts"],
  "marketing-outbox": ["syncMarketingConversions"], "ollama-admin": ["runOllamaPull"],
  "reap-stuck-reviews": ["reapStuckReviews"], "discover-repositories": ["discoverRepositories"],
})) mock.module(`../../${path}`, () => Object.fromEntries(names.map(name => [name, () => { throw new Error("Unexpected unrelated job"); }])));
const reviewCalls: unknown[][] = [];
let reviewError: Error | undefined;
mock.module("../../reviewer", () => ({ processReview: async (...args: unknown[]) => {
  reviewCalls.push(args); if (reviewError) throw reviewError;
} }));
mock.module("../../repository-index-job", () => ({ processRepositoryIndex: async () => { throw new DOMException("Deadline", "TimeoutError"); } }));
const { registerWorkers } = await import("../../queue-workers");
const callbacks = new Map<string, (jobs: unknown[]) => Promise<void>>();
await registerWorkers({ work: async (name: string, ...args: unknown[]) => { callbacks.set(name, args.at(-1) as never); } } as never,
  { reviewConcurrency: 1 } as never);
const job = { id: "job", data: { pullRequestId: "pr", repositoryId: "repo" }, retryCount: 1, retryLimit: 2,
  startedOn: new Date(), expireInSeconds: 900, signal: new AbortController().signal };
await callbacks.get("process-review")!([job]);
assert.equal(reviewCalls[0][2], 1);
assert.equal((reviewCalls[0][1] as { signal: AbortSignal }).signal, job.signal);
assert.equal(events.length, 0);
await assert.rejects(() => callbacks.get("index-repository")!([job]), { name: "TimeoutError" });
assert.equal(events.length, 0);
job.retryCount = 2;
await assert.rejects(() => callbacks.get("index-repository")!([job]), { name: "TimeoutError" });
assert.equal(events.length, 1);
assert.equal(events[0].contexts?.background_failure?.retryCount, 2);
reviewError = new Error("Review failed before handled boundary");
const controller = new AbortController(); controller.abort(); job.signal = controller.signal;
const log = console.error; console.error = () => {};
try {
  await assert.rejects(() => callbacks.get("process-review")!([job]));
  assert.equal(events.length, 1);
  job.signal = new AbortController().signal;
  await assert.rejects(() => callbacks.get("process-review")!([job]));
  assert.equal(events.length, 2);
} finally { console.error = log; }
