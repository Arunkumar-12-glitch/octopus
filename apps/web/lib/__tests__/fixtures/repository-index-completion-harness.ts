import { mock } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const url = new URL(process.env.DATABASE_URL ?? "http://invalid");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
assert.match(url.pathname, /(^|[-_])test($|[-_])/);
const scenario = process.argv[2];
const sessionTimezone = scenario === "timezone-berlin" ? "Europe/Berlin" : "UTC";
if (scenario.startsWith("timezone-")) {
  // Apply to every pooled connection, including the helper's UPDATE connection.
  url.searchParams.set("options", `-c timezone=${sessionTimezone}`);
  process.env.DATABASE_URL = url.toString();
}
mock.module("server-only", () => ({}));
const { prisma } = await import("@octopus/db");
const { recordRepositoryIndexCompletion } = await import("@/lib/repository-index-completion");
const migration = await readFile(new URL(
  "../../../../../packages/db/prisma/migrations/20261014120000_add_repository_first_indexed_at/migration.sql",
  import.meta.url,
), "utf8");
const early = new Date("2026-01-01T12:00:00.123Z");
const late = new Date("2026-01-02T12:00:00.456Z");
const fixture = randomUUID();
const org = await prisma.organization.create({ data: { name: "Index completion test", slug: `index-test-${fixture}` } });
const repo = await prisma.repository.create({ data: {
  organizationId: org.id, name: "Index test", fullName: "fixture/index", externalId: fixture,
} });
const snapshot = () => prisma.repository.findUniqueOrThrow({ where: { id: repo.id } });
const stats = { totalFiles: 2, indexedFiles: 1, totalChunks: 1, totalVectors: 1,
  contributors: [], contributorCount: 0, durationMs: 10 };

try {
  if (scenario.startsWith("timezone-")) {
    const session = await prisma.$queryRaw<Array<{ TimeZone: string }>>`SHOW TimeZone`;
    assert.equal(session[0].TimeZone, sessionTimezone);
    const completedAt = new Date("2026-07-01T12:34:56.789Z");
    await recordRepositoryIndexCompletion(repo.id, completedAt);
    const rows = await prisma.$queryRaw<Array<{ indexedAt: string; firstIndexedAt: string; updatedAt: string }>>`
      SELECT "indexedAt"::text AS "indexedAt", "firstIndexedAt"::text AS "firstIndexedAt",
        "updatedAt"::text AS "updatedAt" FROM repositories WHERE id = ${repo.id}
    `;
    const expected = completedAt.toISOString().replace("T", " ").slice(0, -1);
    assert.deepEqual(rows, [{ indexedAt: expected, firstIndexedAt: expected, updatedAt: expected }]);
  } else if (scenario === "migration") {
    await prisma.$transaction(async tx => {
      const schema = `index_migration_${fixture.replaceAll("-", "")}`;
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe('CREATE TABLE repositories (id TEXT PRIMARY KEY, "indexedAt" TIMESTAMP(3), name TEXT)');
      await tx.$executeRaw`INSERT INTO repositories VALUES ('old', ${early}::timestamp, 'Preserved'), ('new', NULL, 'Unindexed')`;
      const before = await tx.$queryRaw`SELECT * FROM repositories ORDER BY id`;
      await tx.$executeRawUnsafe(migration);
      assert.deepEqual(await tx.$queryRaw`SELECT id, "indexedAt", name FROM repositories ORDER BY id`, before);
      assert.deepEqual(await tx.$queryRaw`SELECT "firstIndexedAt" FROM repositories`, [{ firstIndexedAt: null }, { firstIndexedAt: null }]);
      const columns = await tx.$queryRaw<Array<{ column_default: string | null; is_nullable: string; data_type: string }>>`
        SELECT column_default, is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = ${schema} AND table_name = 'repositories' AND column_name = 'firstIndexedAt'
      `;
      assert.deepEqual(columns, [{ column_default: null, is_nullable: "YES", data_type: "timestamp without time zone" }]);
      await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    });
  } else if (scenario === "first" || scenario === "reindex" || scenario === "legacy") {
    if (scenario === "legacy") await prisma.repository.update({ where: { id: repo.id }, data: { indexedAt: early } });
    else await recordRepositoryIndexCompletion(repo.id, early);
    if (scenario !== "first") await recordRepositoryIndexCompletion(repo.id, late);
    const result = await snapshot();
    assert.deepEqual(result.firstIndexedAt, scenario === "legacy" ? null : early);
    assert.deepEqual(result.indexedAt, scenario === "first" ? early : late);
  } else if (scenario.startsWith("concurrent-")) {
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lock = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM repositories WHERE id = ${repo.id} FOR UPDATE`;
      acquired();
      await gate;
    }, { timeout: 15_000 });
    await ready;
    const waitForBlocked = async (count: number) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query LIKE '%UPDATE "repositories"%'
        `;
        if (Number(rows[0].count) >= count) return;
        await Bun.sleep(10);
      }
      throw new Error("Completion did not wait on the repository lock");
    };
    const times = scenario === "concurrent-earlier-first" ? [early, late] : [late, early];
    const first = recordRepositoryIndexCompletion(repo.id, times[0]);
    try {
      await waitForBlocked(1);
      const second = recordRepositoryIndexCompletion(repo.id, times[1]);
      try { await waitForBlocked(2); } finally { release(); }
      await Promise.all([lock, first, second]);
    } finally { release(); await lock; }
    const result = await snapshot();
    assert.deepEqual(result.firstIndexedAt, early);
    assert.deepEqual(result.indexedAt, times[1]);
  } else if (["failed", "cancelled", "background"].includes(scenario)) {
    mock.module("@/lib/indexer", () => ({ indexRepository: async () => {
      if (scenario === "failed") throw new Error("Index fixture failed");
      if (scenario === "cancelled") throw new Error("Indexing cancelled");
      return stats;
    } }));
    mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
    mock.module("@/lib/events", () => ({ eventBus: { emit: () => {} } }));
    mock.module("@/lib/summarizer", () => ({ summarizeRepository: async () => ({ summary: "Fixture", purpose: "Fixture" }) }));
    const { runIndexingInBackground } = await import("@/lib/indexing-runner");
    await runIndexingInBackground(repo.id, repo.fullName, "main", org.id, 0, "fixture", () => {}, new AbortController());
    const result = await snapshot();
    assert.equal(result.firstIndexedAt !== null, scenario === "background");
    assert.equal(result.indexedAt !== null, scenario === "background");
  } else {
    // Exercise the actual completion statements from each route against PostgreSQL,
    // without invoking provider APIs or the surrounding review pipeline.
    const routes: Record<string, string> = {
      queued: "lib/repository-index-job.ts", local: "lib/index-local.ts", "local-nonfinal": "lib/index-local.ts",
      community: "lib/community-review.ts", reviewer: "lib/reviewer.ts",
      action: "app/api/github-action/review/route.ts", incremental: "app/api/github/webhook/route.ts",
    };
    const source = await readFile(new URL(`../../../${routes[scenario]}`, import.meta.url), "utf8");
    const ast = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
    let statements: ts.Statement[] | undefined;
    function visit(node: ts.Node) {
      if (ts.isBlock(node)) {
        const position = node.statements.findIndex(statement => {
          const text = statement.getText(ast);
          return text.includes("await recordRepositoryIndexCompletion(") && !text.includes("prisma.repository.update(");
        });
        if (position > 0) statements = Array.from(node.statements.slice(position - 1, position + 1));
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(statements, `Missing completion call in ${routes[scenario]}`);
    assert.match(statements[0].getText(ast), /await prisma\.repository\.update\(/);
    const fragment = statements.map(statement => statement.getText(ast)).join("\n");
    assert.doesNotMatch(fragment, /indexedAt\s*:/);
    const compiled = ts.transpileModule(fragment, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    let calls = 0;
    const complete = async (id: string) => { calls++; assert.equal(id, repo.id); await recordRepositoryIndexCompletion(id, early); };
    await new AsyncFunction("prisma", "recordRepositoryIndexCompletion", "repo", "repoId", "stats", "indexStats", "commit", "startedAt", "delta", compiled)(
      prisma, complete, repo, repo.id, stats, stats, scenario !== "local-nonfinal", null,
      { indexedFiles: 1, totalChunks: 1, totalVectors: 1, totalFiles: 2 },
    );
    const final = scenario !== "local-nonfinal";
    assert.equal(calls, final ? 1 : 0);
    const result = await snapshot();
    assert.deepEqual(result.firstIndexedAt, final ? early : null);
    assert.deepEqual(result.indexedAt, final ? early : null);
  }
} finally {
  await prisma.organization.delete({ where: { id: org.id } });
  await prisma.$disconnect();
}
