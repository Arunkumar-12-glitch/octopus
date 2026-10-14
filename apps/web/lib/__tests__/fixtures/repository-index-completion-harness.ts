import { mock } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

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
const { recordRepositoryIndexCompletion: recordCompletion, runRepositoryIndex } = await import("@/lib/repository-index-completion");
const recordRepositoryIndexCompletion = (id: string, time?: Date) => prisma.$transaction(tx => recordCompletion(tx, id, time));
const migration = await readFile(new URL(
  "../../../../../packages/db/prisma/migrations/20261014120000_add_repository_first_indexed_at/migration.sql",
  import.meta.url,
), "utf8");
const early = new Date("2026-01-01T12:00:00.123Z");
const late = new Date("2026-01-02T12:00:00.456Z");
const fixture = randomUUID();
const org = await prisma.organization.create({ data: { name: "Index completion test", slug: `index-test-${fixture}` } });
const repo = await prisma.repository.create({ data: {
  organizationId: org.id, name: "Index test", fullName: "fixture/index", externalId: fixture, indexStatus: "indexing",
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
  } else if (["failed", "cancelled", "background", "late-cancel", "empty", "superseded"].includes(scenario)) {
    const controller = new AbortController();
    mock.module("@/lib/indexer", () => ({ indexRepository: async () => {
      if (scenario === "failed") throw new Error("Index fixture failed");
      if (scenario === "cancelled") { controller.abort(); throw new Error("Indexing cancelled"); }
      if (scenario === "late-cancel") controller.abort();
      if (scenario === "superseded") await prisma.repository.update({ where: { id: repo.id }, data: { indexStatus: "pending", indexAttemptId: null } });
      return scenario === "empty" ? { ...stats, indexedFiles: 0, totalChunks: 0, totalVectors: 0 } : stats;
    } }));
    mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
    mock.module("@/lib/events", () => ({ eventBus: { emit: () => {} } }));
    mock.module("@/lib/summarizer", () => ({ summarizeRepository: async () => ({ summary: "Fixture", purpose: "Fixture" }) }));
    mock.module("@/lib/indexing-abort", () => ({ clearAbortController: () => {} }));
    const { runIndexingInBackground } = await import("@/lib/indexing-runner");
    await runIndexingInBackground(repo.id, repo.fullName, "main", org.id, 0, "fixture", () => {}, controller);
    const result = await snapshot();
    assert.equal(result.firstIndexedAt !== null, scenario === "background");
    assert.equal(result.indexedAt !== null, scenario === "background");
    if (scenario === "superseded") assert.equal(result.indexStatus, "pending");
  } else if (scenario === "replacement") {
    let finish!: () => void;
    let began!: () => void;
    const ready = new Promise<void>(resolve => { began = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const old = runRepositoryIndex(repo.id, async () => { began(); await pending; return stats; });
    const observed = old.then(() => null, error => error);
    await ready;
    await prisma.repository.update({ where: { id: repo.id }, data: { indexStatus: "indexing", indexAttemptId: null } });
    await runRepositoryIndex(repo.id, async () => ({ ...stats, indexedFiles: 2 }));
    const completed = await snapshot();
    finish();
    assert.match(String(await observed), /no longer current/);
    const after = await snapshot();
    assert.deepEqual(after.firstIndexedAt, completed.firstIndexedAt);
    assert.equal(after.indexStatus, "indexed");
    assert.equal(after.indexedFiles, 2);
  } else if (scenario.startsWith("local")) {
    mock.module("@/lib/qdrant", () => ({ deleteRepoChunks: async () => {}, upsertChunks: async () => {} }));
    mock.module("@/lib/embeddings", () => ({ createEmbeddings: async (texts: string[]) => texts.map(() => [0.1]) }));
    const { prepareRepoForLocalIndex, claimLocalIndexBatch, recordLocalIndexProgress, indexLocalBatch, markLocalIndexFailed } = await import("@/lib/index-local");
    const single = scenario === "local-single";
    const prepared = await prepareRepoForLocalIndex(org.id, "github", `local/${fixture}`, "main", { totalBatches: single ? 1 : 2, totalFiles: 2 });
    assert.ok(prepared.ok);
    const id = prepared.repoId;
    const files = [{ path: "a.ts", content: "export const a = 1;" }, { path: "b.ts", content: "export const b = 2;" }];
    const firstFiles = single ? files : files.slice(0, 1);
    const first = await claimLocalIndexBatch(id, 0, single ? 1 : 2, firstFiles, prepared.uploadId);
    const delta = await indexLocalBatch(id, `local/${fixture}`, org.id, firstFiles);
    const progress = { indexedFiles: delta.indexedInBatch, totalChunks: delta.chunksInBatch, totalVectors: delta.chunksInBatch };
    await recordLocalIndexProgress(id, Date.now(), progress, single, first);
    if (scenario === "local-gap") {
      await assert.rejects(() => claimLocalIndexBatch(id, 2, 3, files.slice(1), first.upload.id), /out of order/);
    } else if (scenario === "local-duplicate") {
      await assert.rejects(() => claimLocalIndexBatch(id, 1, 2, firstFiles, first.upload.id), /duplicate/);
    } else if (scenario === "local-wrong-session") {
      await assert.rejects(() => claimLocalIndexBatch(id, 1, 2, files.slice(1), "old-upload"), /no longer current/);
    } else if (!single && scenario !== "local-nonfinal") {
      const final = await claimLocalIndexBatch(id, 1, 2, files.slice(1), scenario === "local-legacy" ? undefined : first.upload.id);
      if (scenario === "local-cancel") {
        await prisma.repository.update({ where: { id }, data: { indexStatus: "pending", indexAttemptId: null } });
        await assert.rejects(() => recordLocalIndexProgress(id, null, progress, true, final), /cancelled or replaced/);
        await markLocalIndexFailed(id, final.attemptId);
      } else await recordLocalIndexProgress(id, null, progress, true, final);
    }
    const result = await prisma.repository.findUniqueOrThrow({ where: { id } });
    const verified = ["local-single", "local-verified"].includes(scenario);
    assert.equal(result.firstIndexedAt !== null, verified);
    if (scenario === "local-legacy") assert.ok(result.indexedAt);
    if (scenario === "local-cancel") assert.equal(result.indexStatus, "pending");
  } else throw new Error(`Unknown scenario ${scenario}`);
} finally {
  await prisma.organization.delete({ where: { id: org.id } });
  await prisma.$disconnect();
}
