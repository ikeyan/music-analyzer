import { PrismaBunSqlite } from "prisma-adapter-bun-sqlite";
import { PrismaClient } from "../app/generated/prisma/client";

const adapter = new PrismaBunSqlite({
  url: process.env.DATABASE_URL ?? "file:./dev.db",
});
const prisma = new PrismaClient({ adapter });

async function main() {
  const existing = await prisma.message.findFirst();
  if (existing) {
    console.log("Seed skipped: messages already exist");
    return;
  }
  const created = await prisma.message.create({
    data: { content: "Hello, World!" },
  });
  console.log("Seeded:", created);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
