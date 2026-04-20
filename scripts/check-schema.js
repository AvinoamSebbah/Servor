require('dotenv').config();
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });

client.connect().then(async () => {
  // Check existing columns
  const res = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' ORDER BY ordinal_position`);
  console.log('users columns:', res.rows.map(r => r.column_name).join(', '));

  // Check if preferences column exists
  const hasPref = res.rows.some(r => r.column_name === 'preferences');
  
  if (!hasPref) {
    console.log('Adding preferences column...');
    await client.query(`ALTER TABLE users ADD COLUMN preferences JSONB DEFAULT '{}' NOT NULL`);
    console.log('✅ preferences column added!');
  } else {
    console.log('✅ preferences column already exists');
  }

  await client.end();
}).catch(e => { console.error(e.message); process.exit(1); });
