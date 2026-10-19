import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import type { ErrorEvent } from "@sentry/nextjs";

it("delivers the bundled checker event under Node with the real SDK and preserves opt-in", async () => {
  const directory = await mkdtemp(`${import.meta.dir}/sentry-smoke-`);
  const cwd = `${import.meta.dir}/../..`;
  const events: { path: string; event: ErrorEvent }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = Buffer.from(await request.arrayBuffer());
      const lines = (request.headers.get("content-encoding") === "gzip" ? gunzipSync(body) : body).toString().trim().split("\n");
      for (let index = 1; index < lines.length; index += 2) {
        if (JSON.parse(lines[index]).type === "event") {
          events.push({ path: new URL(request.url).pathname, event: JSON.parse(lines[index + 1]) });
        }
      }
      return Response.json({});
    },
  });
  const env = { ...process.env, SENTRY_DSN: "", SENTRY_ENVIRONMENT: "", NEXT_PUBLIC_APP_VERSION: "",
    NEXT_PUBLIC_SENTRY_DSN: "", NEXT_PUBLIC_OCTOPUS_SELF_HOSTED: "", SENTRY_TRACES_SAMPLE_RATE: "0" };
  delete env.SENTRY_ENVIRONMENT;
  const run = async (command: string[], variables: Record<string, string | undefined>) => {
    const child = Bun.spawn(command, { cwd, env: variables, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit, stdout, stderr };
  };
  try {
    for (const hosted of [true, false]) {
      const artifact = `${directory}/${hosted ? "hosted" : "selfhost"}.mjs`;
      const buildDsn = hosted ? `http://public@127.0.0.1:${server.port}/1` : "";
      const build = await run([process.execPath, "scripts/build-sentry-smoke.ts", artifact], { ...env, NEXT_PUBLIC_APP_VERSION: "1.3.2",
        NEXT_PUBLIC_SENTRY_DSN: buildDsn, NEXT_PUBLIC_OCTOPUS_SELF_HOSTED: String(!hosted) });
      expect(build.exit, `${build.stdout}\n${build.stderr}`).toBe(0);
      for (const runtimeDsn of ["", `http://runtime@127.0.0.1:${server.port}/2`]) {
        for (const send of [false, true]) {
          events.length = 0;
          const result = await run(["node", artifact, ...(send ? ["--send-synthetic"] : [])], { ...env, SENTRY_DSN: runtimeDsn });
          if (!send || !(buildDsn || runtimeDsn)) {
            expect(result.exit).toBe(1);
            expect(result.stderr).toContain("Requires --send-synthetic and an existing Sentry DSN");
            expect(events).toHaveLength(0);
            continue;
          }
          expect(result.exit, `${result.stdout}\n${result.stderr}`).toBe(0);
          const receipt = JSON.parse(result.stdout.trim());
          expect(receipt).toEqual({ eventId: expect.stringMatching(/^[a-f0-9]{32}$/), synthetic: true, release: "1.3.2" });
          expect(events).toHaveLength(1);
          const { path, event } = events[0];
          expect(path).toBe(runtimeDsn ? "/api/2/envelope/" : "/api/1/envelope/");
          expect(event.event_id).toBe(receipt.eventId);
          expect(event.release).toBe("1.3.2");
          expect(event.environment).toBe(hosted ? "production" : "self-hosted");
          expect(event.fingerprint).toEqual(["background-failure-synthetic", "generation", "anthropic", "STREAM_TERMINATED"]);
          expect(event.tags?.synthetic).toBe("true");
          expect(event.contexts?.background_failure?.attemptId).toMatch(/^synthetic-/);
          expect(event.breadcrumbs).toBeUndefined();
          expect(event.exception).toBeUndefined();
        }
      }
    }
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
