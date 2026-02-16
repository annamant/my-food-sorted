import 'dotenv/config';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is required. Set it in .env');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

const schemaPath = path.join(__dirname, 'schema.sql');
const sql = fs.readFileSync(schemaPath, 'utf8');

async function run() {
  try {
    await pool.query(sql);
    console.log('Schema applied successfully.');
  } catch (err) {
    console.error('Schema failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
