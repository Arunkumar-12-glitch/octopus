/** Explicit operator check; no database, customer review or paid model call. */
import * as Sentry from "@sentry/nextjs";
import { reportBackgroundFailure } from "../lib/background-failure";
import { AiProviderFailure } from "../lib/provider-failure";

if (process.argv[2] !== "--send-synthetic" || !(process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN)) {
  throw new Error("Requires --send-synthetic and an existing Sentry DSN");
}
await import("../sentry.server.config");
const eventId = reportBackgroundFailure(new AiProviderFailure(new Error("terminated"), "anthropic", "synthetic-sentry-check", "platform"),
  { stage: "generation", attemptId: `synthetic-${crypto.randomUUID()}`, synthetic: true });
if (!eventId || !await Sentry.flush(10_000)) throw new Error("Synthetic event was not flushed; verify Sentry before claiming delivery");
console.log(JSON.stringify({ eventId, synthetic: true, release: process.env.NEXT_PUBLIC_APP_VERSION }));
