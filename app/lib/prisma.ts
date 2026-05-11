import { PrismaBunSqlite } from "prisma-adapter-bun-sqlite";
import { PrismaClient } from "../generated/prisma/client";

declare global {
  // dev で HMR/再 import 時に PrismaClient を使い回すための単一スロット
  // eslint-disable-next-line no-var
  var __musicAnalyzerPrisma: PrismaClient | undefined;
}

function createPrismaClient() {
  const adapter = new PrismaBunSqlite({
    url: process.env.DATABASE_URL ?? "file:./dev.db",
  });
  return new PrismaClient({ adapter });
}

export const prisma = globalThis.__musicAnalyzerPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__musicAnalyzerPrisma = prisma;
}
