import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function deleteAllUsers() {
  try {
    const result = await pool.query('DELETE FROM users');
    console.log(`Deleted ${result.rowCount} user(s). All users removed.`);
  } catch (err) {
    console.error('Error deleting users:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

deleteAllUsers();
