import "server-only";
import { prisma } from "@octopus/db";

/** Record completion atomically, preserving unknown first dates on legacy rows. */
export async function recordRepositoryIndexCompletion(
  repositoryId: string,
  completedAt: Date = new Date(),
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "repositories"
    SET "firstIndexedAt" = CASE
          WHEN "firstIndexedAt" IS NOT NULL
            THEN LEAST("firstIndexedAt", ${completedAt}::timestamp)
          WHEN "indexedAt" IS NULL THEN ${completedAt}::timestamp
          ELSE NULL
        END,
        "indexedAt" = ${completedAt}::timestamp,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${repositoryId}
  `;
}
