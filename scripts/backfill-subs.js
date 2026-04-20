require('dotenv').config();
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });

client.connect().then(() => {
  const nextMonth = new Date();
  nextMonth.setDate(nextMonth.getDate() + 30);
  
  return client.query(`
    UPDATE users 
    SET 
      subscription_status = 'active', 
      subscription_current_period_end = $1, 
      subscription_last_price = CASE 
        WHEN plan = 'pro' THEN 9.90 
        WHEN plan = 'max' THEN 19.90 
        ELSE 0 
      END 
    WHERE plan != 'free' AND subscription_current_period_end IS NULL
  `, [nextMonth]);
}).then(res => {
  console.log('Updated rows:', res.rowCount);
  client.end();
}).catch(err => {
  console.error(err);
  client.end();
});
