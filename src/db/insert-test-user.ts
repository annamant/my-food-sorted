import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function insertTestUser() {
  try {
    await pool.query(
      'INSERT INTO users (id, email, household_size, default_budget) VALUES (1, $1, $2, $3)',
      ['test@example.com', 2, 50.00]
    );
    console.log('Test user inserted successfully');
  } catch (err) {
    console.error('Error inserting test user:', err);
  } finally {
    await pool.end();
  }
}

insertTestUser();
