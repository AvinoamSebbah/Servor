require('dotenv').config();
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });

client.connect().then(async () => {
  const res = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' ORDER BY ordinal_position`);
  const cols = res.rows.map(r => r.column_name);
  console.log('Existing columns:', cols.join(', '));

  const migrations = [];

  if (!cols.includes('subscription_status')) {
    migrations.push(`ALTER TABLE users ADD COLUMN subscription_status VARCHAR(20) DEFAULT 'free' NOT NULL`);
  }
  if (!cols.includes('subscription_started_at')) {
    migrations.push(`ALTER TABLE users ADD COLUMN subscription_started_at TIMESTAMPTZ`);
  }
  if (!cols.includes('subscription_current_period_end')) {
    migrations.push(`ALTER TABLE users ADD COLUMN subscription_current_period_end TIMESTAMPTZ`);
  }
  if (!cols.includes('subscription_cancelled_at')) {
    migrations.push(`ALTER TABLE users ADD COLUMN subscription_cancelled_at TIMESTAMPTZ`);
  }
  if (!cols.includes('subscription_last_price')) {
    migrations.push(`ALTER TABLE users ADD COLUMN subscription_last_price DECIMAL(10,2)`);
  }
  if (!cols.includes('subscription_invoice_count')) {
    migrations.push(`ALTER TABLE users ADD COLUMN subscription_invoice_count INTEGER DEFAULT 0`);
  }

  for (const sql of migrations) {
    console.log('Running:', sql);
    await client.query(sql);
    console.log('✅ Done');
  }

  if (migrations.length === 0) {
    console.log('✅ All subscription columns already exist');
  }

  // Show final state
  const res2 = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' ORDER BY ordinal_position`);
  console.log('\nFinal columns:', res2.rows.map(r => r.column_name).join(', '));

  await client.end();
}).catch(e => { console.error('Error:', e.message); process.exit(1); });
