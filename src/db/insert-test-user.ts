import 'dotenv/config';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function insertTestUser() {
  try {
    const hashedPassword = await bcrypt.hash('testpassword', 10);
    await pool.query(
      `INSERT INTO users (id, email, password_hash, household_size, default_budget)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         household_size = EXCLUDED.household_size,
         default_budget = EXCLUDED.default_budget`,
      [1, 'test@example.com', hashedPassword, 2, 50.0]
    );
    console.log('Test user inserted/updated successfully');
  } catch (err) {
    console.error('Error inserting/updating test user:', err);
  } finally {
    await pool.end();
  }
}

insertTestUser();
