import { PrismaBunSqlite } from "prisma-adapter-bun-sqlite";
import { PrismaClient } from "../app/generated/prisma/client";

const adapter = new PrismaBunSqlite({
  url: process.env.DATABASE_URL ?? "file:./dev.db",
});
const prisma = new PrismaClient({ adapter });

async function main() {
  // 接続検証だけ。スキーマは何もfixtureを必要としない
  await prisma.$queryRaw`SELECT 1`;
  console.log("Seed: schema in place, no fixtures to insert");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
