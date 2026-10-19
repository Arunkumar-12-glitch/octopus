import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { ErrorEvent } from "@sentry/nextjs";

const [artifact, buildDsn, environment] = process.argv.slice(2);
const expectedDsn = process.env.SENTRY_DSN || buildDsn;
let options: { dsn?: string; release?: string; environment?: string; beforeSend?: (event: ErrorEvent) => ErrorEvent } | undefined;
const events: ErrorEvent[] = [];
let flushed = false;
globalThis.fetch = (() => { throw new Error("Unexpected network access in checker harness"); }) as typeof fetch;
mock.module("@sentry/nextjs", () => ({
  init: (value: typeof options) => { options = value; },
  captureEvent: (event: ErrorEvent) => { events.push(options!.beforeSend!(event)); return "e".repeat(32); },
  flush: async () => { flushed = true; return true; },
}));
process.argv[2] = "--send-synthetic";
if (!expectedDsn) {
  await assert.rejects(() => import(artifact), /existing Sentry DSN/);
  assert.equal(options, undefined);
  assert.equal(events.length, 0);
  assert.equal(flushed, false);
} else {
  await import(artifact);
  assert.equal(options?.dsn, expectedDsn);
  assert.equal(options?.release, "1.3.2");
  assert.equal(options?.environment, environment);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].fingerprint, ["background-failure-synthetic", "generation", "anthropic", "STREAM_TERMINATED"]);
  assert.equal(events[0].tags?.synthetic, "true");
  assert.equal(flushed, true);
}
