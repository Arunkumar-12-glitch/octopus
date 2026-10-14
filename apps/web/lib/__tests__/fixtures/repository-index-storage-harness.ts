import { mock } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma, type Repository } from "@octopus/db";

export async function exerciseStorageRace(scenario: string, repo: Repository) {
  type Point = { id: string; payload: { repoId: string; filePath: string; text: string } };
  const stored = new Map<string, Point>();
  let pause: "upsert" | "delete" | undefined;
  let reached!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const wait = async (operation: typeof pause) => {
    if (operation !== pause) return;
    pause = undefined;
    reached();
    await gate;
  };
  mock.module("@qdrant/js-client-rest", () => ({ QdrantClient: class {
    async getCollections() { return { collections: [{ name: "code_chunks" }] }; }
    async updateCollection() {}
    async upsert(_collection: string, request: { points: Point[]; wait: boolean }) {
      assert.equal(request.wait, true);
      await wait("upsert");
      for (const point of request.points) stored.set(point.id, point);
    }
    async delete(_collection: string, request: { wait: boolean; filter: { must: Array<{ key: string; match: { value?: string; any?: string[] } }> } }) {
      assert.equal(request.wait, true);
      await wait("delete");
      const repoId = request.filter.must.find(filter => filter.key === "repoId")?.match.value;
      const paths = request.filter.must.find(filter => filter.key === "filePath")?.match.any;
      for (const [id, point] of stored) {
        if (point.payload.repoId === repoId && (!paths || paths.includes(point.payload.filePath))) stored.delete(id);
      }
    }
  } }));
  mock.module("@/lib/embed-config", () => ({ getEmbedConfig: () => ({ dim: 1 }) }));
  mock.module("@/lib/embeddings", () => ({ createEmbeddings: async (texts: string[]) => texts.map(() => [0.1]) }));
  let generation = "old";
  const files = () => Array.from({ length: 101 }, (_, i) => ({ path: `file${i}.ts`, content: `export const value = '${generation}-${i}';` }));
  mock.module("@/lib/github", () => ({
    getInstallationToken: async () => "fixture-token",
    getRepositoryDetails: async () => ({ default_branch: "main" }),
    getFileContent: async (_id: number, _owner: string, _name: string, _ref: string, path: string) => path === ".octopusignore" ? null : `export const value = '${generation}-${path}';`,
  }));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/git/trees/")) return Response.json({ tree: files().map(file => ({ type: "blob", path: file.path, sha: file.path })) });
    if (url.includes("/git/blobs/")) return Response.json({ encoding: "base64", content: Buffer.from(`export const value = '${generation}';`).toString("base64") });
    if (url.includes("/contributors")) return Response.json([]);
    throw new Error(`Unexpected storage fixture request: ${url}`);
  }) as typeof fetch;
  const { indexRepository, incrementalIndex } = await import("@/lib/indexer");
  const { runRepositoryIndex } = await import("@/lib/repository-index-completion");
  const { prepareRepoForLocalIndex, claimLocalIndexBatch, indexLocalBatch, recordLocalIndexProgress } = await import("@/lib/index-local");
  const { deleteRepoChunks, deleteRepoFileChunks, upsertChunks } = await import("@/lib/qdrant");
  const snapshot = () => prisma.repository.findUniqueOrThrow({ where: { id: repo.id } });
  const full = (indexAttemptId: string) => runRepositoryIndex(repo.id, indexAttemptId, () => indexRepository(
    { repoId: repo.id, indexAttemptId }, repo.fullName, "main", 1,
  ));
  const prepare = () => prepareRepoForLocalIndex(repo.organizationId, "github", repo.fullName, "main", { totalBatches: 1, totalFiles: 101 });
  const local = async (uploadId: string) => {
    const batch = files();
    const claim = await claimLocalIndexBatch(repo.id, 0, 1, batch, uploadId);
    const delta = await indexLocalBatch(repo.id, repo.fullName, repo.organizationId, batch, claim.attemptId);
    await recordLocalIndexProgress(repo.id, null, {
      indexedFiles: delta.indexedInBatch, totalChunks: delta.chunksInBatch, totalVectors: delta.chunksInBatch,
    }, true, claim);
  };
  let old: Promise<unknown>;
  let oldOwner: { repoId: string; indexAttemptId: string } | { repoId: string; updatedAt: Date };
  if (scenario === "storage-provider") {
    oldOwner = { repoId: repo.id, indexAttemptId: repo.indexAttemptId! };
    pause = "upsert";
    old = full(repo.indexAttemptId!);
  } else if (scenario === "storage-incremental") {
    await full(repo.indexAttemptId!);
    oldOwner = { repoId: repo.id, updatedAt: (await snapshot()).updatedAt };
    pause = "upsert";
    old = incrementalIndex(oldOwner, repo.fullName, "main", 1, files().map(file => ({ filename: file.path, status: "modified" })));
  } else {
    await prisma.repository.update({ where: { id: repo.id }, data: { indexStatus: "pending", installationId: null, externalId: `cli:github:${repo.fullName}` } });
    if (scenario === "storage-reset") {
      pause = "delete";
      old = prepare();
      oldOwner = { repoId: repo.id, indexAttemptId: "unused" };
    } else {
      const prepared = await prepare();
      assert.ok(prepared.ok);
      const batch = files();
      const claim = await claimLocalIndexBatch(repo.id, 0, 1, batch, prepared.uploadId);
      oldOwner = { repoId: repo.id, indexAttemptId: claim.attemptId };
      pause = "upsert";
      old = indexLocalBatch(repo.id, repo.fullName, repo.organizationId, batch, claim.attemptId).then(delta => recordLocalIndexProgress(repo.id, null, {
        indexedFiles: delta.indexedInBatch, totalChunks: delta.chunksInBatch, totalVectors: delta.chunksInBatch,
      }, true, claim));
    }
  }
  const observed = old.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await ready;
  const before = await snapshot();
  const transition = prisma.repository.updateMany({
    where: { id: repo.id, indexStatus: before.indexStatus, indexAttemptId: before.indexAttemptId },
    data: { indexStatus: "pending" },
  }).then(result => { assert.equal(result.count, 1); });
  try {
    let blocked = false;
    for (let i = 0; i < 200; i++) {
      const rows = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query LIKE '%UPDATE%' AND query LIKE '%repositories%') AS blocked
      `;
      if (rows[0].blocked) { blocked = true; break; }
      await Bun.sleep(10);
    }
    assert.ok(blocked, "Cancellation must wait until the in-flight storage request finishes");
    assert.equal((await snapshot()).indexStatus, before.indexStatus);
  } finally { release(); }
  await transition;
  generation = "new";
  if (scenario === "storage-local" || scenario === "storage-reset") {
    const prepared = await prepare();
    assert.ok(prepared.ok);
    await local(prepared.uploadId);
  } else {
    const indexAttemptId = randomUUID();
    await prisma.repository.update({ where: { id: repo.id }, data: { indexStatus: "indexing", indexAttemptId } });
    await full(indexAttemptId);
  }
  const completed = await snapshot();
  const stale = await observed;
  if (scenario === "storage-reset") {
    const prepared = stale.value as Awaited<ReturnType<typeof prepare>>;
    assert.ok(prepared.ok);
    await assert.rejects(() => deleteRepoChunks({ repoId: repo.id, uploadId: prepared.uploadId }), /no longer current/);
    await assert.rejects(() => claimLocalIndexBatch(repo.id, 0, 1, files(), prepared.uploadId), /no longer current/);
  } else {
    assert.match(String(stale.error), /no longer current/);
    await assert.rejects(() => deleteRepoChunks(oldOwner), /no longer current/);
    await assert.rejects(() => deleteRepoFileChunks(oldOwner, ["file0.ts"]), /no longer current/);
    await assert.rejects(() => upsertChunks([{ id: randomUUID(), vector: [1], payload: { repoId: repo.id } }], oldOwner), /no longer current/);
  }
  assert.equal(completed.indexStatus, "indexed");
  assert.ok(completed.firstIndexedAt);
  assert.equal(completed.totalVectors, 101);
  assert.equal(stored.size, 101);
  assert.ok([...stored.values()].every(point => point.payload.text.includes("'new")), "The replacement must contain only its own vectors");
  assert.deepEqual(await snapshot(), completed, "Stale cleanup must preserve the replacement's statistics and milestone");
}
