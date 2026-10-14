import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  databasePool: Pool | undefined;
};

export const databasePool = globalForPrisma.databasePool ?? new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(databasePool, { disposeExternalPool: true });

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.databasePool = databasePool;
}

export { Prisma, PrismaClient } from "@prisma/client";
export type * from "@prisma/client";
