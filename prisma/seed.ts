import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const existing = await prisma.message.findFirst()
  if (existing) {
    console.log('Seed skipped: messages already exist')
    return
  }
  const created = await prisma.message.create({
    data: { content: 'Hello, World!' },
  })
  console.log('Seeded:', created)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
