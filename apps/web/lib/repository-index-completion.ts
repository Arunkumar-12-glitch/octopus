import "server-only";
import { randomUUID } from "node:crypto";
import { prisma, type Prisma } from "@octopus/db";
import type { IndexStats } from "@/lib/indexer";

/** A replacement attempt or cancellation owns the row now. */
export class SupersededIndexError extends Error {
  constructor() { super("Indexing attempt is no longer current"); }
}

/** Persist a complete snapshot and its milestones in one guarded transaction. */
export async function runRepositoryIndex(
  repositoryId: string,
  work: () => Promise<IndexStats>,
  signal?: AbortSignal,
): Promise<IndexStats> {
  const attempt = await prisma.repository.findUniqueOrThrow({
    where: { id: repositoryId }, select: { updatedAt: true, indexStatus: true },
  });
  if (attempt.indexStatus !== "indexing") throw new SupersededIndexError();
  const indexAttemptId = randomUUID();
  const claimed = await prisma.repository.updateMany({
    where: { id: repositoryId, indexStatus: "indexing", updatedAt: attempt.updatedAt, indexAttemptId: null },
    data: { indexAttemptId },
  });
  if (!claimed.count) throw new SupersededIndexError();
  const where = { id: repositoryId, indexStatus: "indexing", indexAttemptId };
  try {
    signal?.throwIfAborted();
    const stats = await work();
    signal?.throwIfAborted();
    if (stats.totalChunks !== stats.totalVectors || stats.totalChunks < 0 ||
        (stats.totalChunks > 0 && stats.indexedFiles <= 0)) {
      throw new Error("Indexing incomplete: invalid completion statistics");
    }
    await prisma.$transaction(async tx => {
      signal?.throwIfAborted();
      const saved = await tx.repository.updateMany({ where, data: {
        indexStatus: "indexed", indexAttemptId: null,
        totalFiles: stats.totalFiles, indexedFiles: stats.indexedFiles,
        totalChunks: stats.totalChunks, totalVectors: stats.totalVectors,
        contributorCount: stats.contributorCount,
        contributors: JSON.parse(JSON.stringify(stats.contributors)),
        indexDurationMs: stats.durationMs,
        ...(stats.resolvedDefaultBranch ? { defaultBranch: stats.resolvedDefaultBranch } : {}),
      } });
      if (saved.count !== 1) throw new SupersededIndexError();
      signal?.throwIfAborted();
      // Empty snapshots are valid for reviewing a first PR, but deliver no
      // indexed content. Keep dates unset until there is a usable full index.
      if (stats.indexedFiles > 0 && stats.totalChunks > 0 && stats.totalVectors === stats.totalChunks) {
        await recordRepositoryIndexCompletion(tx, repositoryId);
      }
    });
    return stats;
  } catch (error) {
    // Never let an expired worker overwrite its replacement's state.
    await prisma.repository.updateMany({ where, data: {
      indexStatus: signal?.aborted ? "pending" : "failed", indexAttemptId: null,
    } });
    throw error;
  }
}

/** Only call inside the transaction that commits a verified full snapshot. */
export async function recordRepositoryIndexCompletion(
  tx: Prisma.TransactionClient,
  repositoryId: string,
  completedAt: Date = new Date(),
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "repositories"
    SET "firstIndexedAt" = CASE
          WHEN "firstIndexedAt" IS NOT NULL
            THEN LEAST("firstIndexedAt", ${completedAt}::timestamp)
          WHEN "indexedAt" IS NULL THEN ${completedAt}::timestamp
          ELSE NULL
        END,
        "indexedAt" = ${completedAt}::timestamp,
        "updatedAt" = ${completedAt}::timestamp
    WHERE "id" = ${repositoryId}
  `;
}
