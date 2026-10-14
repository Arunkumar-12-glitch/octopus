import "server-only";
import { databasePool } from "@octopus/db";
import { SupersededIndexError } from "@/lib/repository-index-completion";

export type RepositoryIndexOwner = { repoId: string; signal?: AbortSignal } & (
  { indexAttemptId: string } | { uploadId: string } | { updatedAt: Date }
);

export async function withRepositoryIndexStorage<T>(owner: RepositoryIndexOwner, mutate: () => Promise<T>): Promise<T> {
  owner.signal?.throwIfAborted();
  const client = await databasePool.connect();
  try {
    await client.query("BEGIN");
    const [condition, value] = "indexAttemptId" in owner
      ? [`"indexStatus" = 'indexing' AND "indexAttemptId" = $2`, owner.indexAttemptId]
      : "uploadId" in owner
        ? [`"indexStatus" = 'indexing' AND "indexAttemptId" IS NULL AND "localIndexUpload"->>'id' = $2`, owner.uploadId]
        : [`"indexStatus" = 'indexed' AND "updatedAt" = $2::timestamp`, owner.updatedAt.toISOString()];
    const result = await client.query(`SELECT id FROM repositories WHERE id = $1 AND ${condition} FOR UPDATE`, [owner.repoId, value]);
    if (result.rowCount !== 1) throw new SupersededIndexError();
    owner.signal?.throwIfAborted();
    const resultValue = await mutate();
    await client.query("COMMIT");
    return resultValue;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
