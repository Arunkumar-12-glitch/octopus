import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";

it("bundles public Sentry metadata while retaining runtime opt-in and DSN precedence", async () => {
  const directory = await mkdtemp(`${import.meta.dir}/sentry-smoke-`);
  const cwd = `${import.meta.dir}/../..`;
  const env = { ...process.env, SENTRY_DSN: "", SENTRY_ENVIRONMENT: "", NEXT_PUBLIC_APP_VERSION: "",
    NEXT_PUBLIC_SENTRY_DSN: "", NEXT_PUBLIC_OCTOPUS_SELF_HOSTED: "" };
  delete env.SENTRY_ENVIRONMENT;
  const run = async (args: string[], variables: Record<string, string | undefined>) => {
    const child = Bun.spawn([process.execPath, ...args], { cwd, env: variables, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, `${stdout}\n${stderr}`).toBe(0);
  };
  try {
    for (const hosted of [true, false]) {
      const artifact = `${directory}/${hosted ? "hosted" : "selfhost"}.mjs`;
      const buildDsn = hosted ? "https://public@example.test/1" : "";
      await run(["scripts/build-sentry-smoke.ts", artifact], { ...env, NEXT_PUBLIC_APP_VERSION: "1.3.2",
        NEXT_PUBLIC_SENTRY_DSN: buildDsn, NEXT_PUBLIC_OCTOPUS_SELF_HOSTED: String(!hosted) });
      for (const runtimeDsn of ["", "https://runtime@example.test/2"]) {
        await run(["lib/__tests__/fixtures/sentry-smoke-harness.ts", artifact, buildDsn, hosted ? "production" : "self-hosted"],
          { ...env, SENTRY_DSN: runtimeDsn });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
