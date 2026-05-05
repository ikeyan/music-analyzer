import { PrismaBunSqlite } from "prisma-adapter-bun-sqlite";
import { PrismaClient } from "../generated/prisma/client";

// JSON.stringify は bigint を投げる。sizeBytes 等は 2^53 を超えない前提で number に落とす
const bigintProto = BigInt.prototype as unknown as { toJSON?: () => number };
if (!bigintProto.toJSON) {
  bigintProto.toJSON = function (this: bigint) {
    return Number(this);
  };
}

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createPrismaClient() {
  const adapter = new PrismaBunSqlite({
    url: process.env.DATABASE_URL ?? "file:./dev.db",
  });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
