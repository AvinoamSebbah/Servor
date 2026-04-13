const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const prisma = new PrismaClient();

async function main() {
  // Create shopping_lists table
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS shopping_lists (
      id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      code       CHAR(5)     NOT NULL,
      name       TEXT        NOT NULL DEFAULT 'רשימת קניות',
      items      JSONB       NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  console.log('Table shopping_lists created/verified');

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS shopping_lists_code_idx ON shopping_lists (code)
  `);
  console.log('Index created/verified');

  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION update_shopping_list_timestamp()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  console.log('Trigger function created/verified');

  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS shopping_lists_updated_at ON shopping_lists
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER shopping_lists_updated_at
      BEFORE UPDATE ON shopping_lists
      FOR EACH ROW EXECUTE FUNCTION update_shopping_list_timestamp()
  `);
  console.log('Trigger created/verified');

  console.log('Migration complete!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
