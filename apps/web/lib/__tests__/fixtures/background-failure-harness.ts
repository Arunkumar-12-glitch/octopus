import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { ErrorEvent } from "@sentry/nextjs";
import { scrubEvent } from "../../sentry-scrub";

mock.module("server-only", () => ({}));
const events: ErrorEvent[] = [];
let telemetryThrows = false;
mock.module("@sentry/nextjs", () => ({ captureEvent: (event: ErrorEvent) => {
  if (telemetryThrows) throw new Error("telemetry unavailable");
  events.push(scrubEvent({ ...event, request: { headers: { authorization: "secret" } }, user: { email: "private@example.test" },
    extra: { source: "customer source" }, breadcrumbs: [{ message: "secret prompt" }], transaction: "private route" }));
  return "e".repeat(32);
} }));
let byok = false;
let failure: unknown = new Error("terminated", { cause: Object.assign(new Error("private body"), { code: "UND_ERR_SOCKET", headers: { authorization: "secret" } }) });
mock.module("@octopus/db", () => ({ prisma: {
  availableModel: { findMany: async () => [] },
  organization: { findUnique: async () => ({ anthropicApiKey: byok ? "secret" : null }) },
} }));
mock.module("@/lib/crypto", () => ({ decryptStringMaybeLegacy: (value: string) => value }));
mock.module("@/lib/providers", () => ({ getProvider: () => ({ create: async () => { if (failure) throw failure; return { text: "complete" }; } }) }));
const { createAiMessage } = await import("../../ai-router");
const { reportBackgroundFailure } = await import("../../background-failure");
const { AiProviderFailure, providerKeyOwner, safeErrorDetails } = await import("../../provider-failure");
const originalError = console.error;
console.error = () => {};
const request = { model: "claude-fixture", maxTokens: 10, messages: [{ role: "user" as const, content: "secret prompt" }] };
const context = { stage: "generation" as const, attemptId: "attempt-1", pullRequestId: "pr-1", headSha: "a".repeat(40) };
async function caught() {
  try { await createAiMessage(request, "org"); assert.fail("expected provider failure"); }
  catch (error) { assert.ok(error instanceof AiProviderFailure); return error; }
}
let error = await caught();
reportBackgroundFailure(error, context);
assert.equal(events.length, 1);
assert.equal(events[0].tags?.failure_code, "STREAM_TERMINATED");
assert.equal(events[0].contexts?.background_failure?.attemptId, "attempt-1");
assert.equal(events[0].contexts?.background_failure?.model, "claude-fixture");
assert.equal(events[0].tags?.failure_owner, "unknown", "interruption is not a proven provider outage");
reportBackgroundFailure(error, context);
assert.equal(events.length, 1, "outer handler cannot duplicate the same failure");
for (const status of [401, 402, 403, 429, 503]) {
  for (byok of [false, true]) {
    failure = Object.assign(new Error("private payload"), { status, request_id: "req_123456789", secret: "secret" });
    const before = events.length;
    reportBackgroundFailure(await caught(), context);
    assert.equal(events.length - before, byok && status !== 503 ? 0 : 1);
    if (!byok) assert.equal(events.at(-1)?.tags?.failure_owner, "platform");
  }
}
for (const message of ["Out of credits", "Monthly spend limit reached", "Indexing cancelled", "Indexing attempt is no longer current"]) {
  const before = events.length;
  reportBackgroundFailure(new Error(message), context);
  assert.equal(events.length, before);
}
error = new AiProviderFailure(new Error("terminated"), "anthropic", request.model, "platform");
const before = events.length;
reportBackgroundFailure(error, { ...context, retry: { retryCount: 0, retryLimit: 2 } });
reportBackgroundFailure(error, { ...context, retry: { retryCount: 1, retryLimit: 2 } });
assert.equal(events.length, before, "retryable work does not create terminal incidents");
reportBackgroundFailure(error, { ...context, retry: { retryCount: 2, retryLimit: 2 } });
assert.equal(events.length, before + 1);
failure = null;
assert.equal((await createAiMessage(request, "org")).text, "complete");
assert.equal(events.length, before + 1, "success does not emit a failure");
assert.equal(providerKeyOwner("ollama", false), "unknown");
const circular = { cause: null as unknown, code: "customer-secret", name: "private@example.test" }; circular.cause = circular;
assert.deepEqual(safeErrorDetails(circular), { name: "Error" });
const serialized = JSON.stringify(events);
for (const forbidden of ["secret", "private", "customer source", "authorization", "breadcrumbs", "exception"]) assert.ok(!serialized.includes(forbidden), forbidden);
telemetryThrows = true;
const warn = console.warn; console.warn = () => {};
assert.doesNotThrow(() => reportBackgroundFailure(new Error("unknown"), context));
console.warn = warn; console.error = originalError;
console.log("PASS provider routing, ownership, retry exhaustion, redaction and failure isolation");
