/// <reference types="bun-types" />
const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/sentry-smoke.ts`],
  target: "node",
  external: ["@sentry/nextjs"],
  define: Object.fromEntries([
    "NEXT_PUBLIC_APP_VERSION", "NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_OCTOPUS_SELF_HOSTED",
  ].map(name => [`process.env.${name}`, JSON.stringify(process.env[name] ?? "")])),
});
if (!result.success) throw new AggregateError(result.logs, "Sentry checker build failed");
await Bun.write(process.argv[2] ?? "../../sentry-smoke.mjs", result.outputs[0]);

export {};
