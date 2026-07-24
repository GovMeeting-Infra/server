import crypto from 'crypto';
import pg from 'pg';

const { Pool } = pg;

async function verifyPassword(hash, password) {
  const [salt, key] = hash.split(':');
  if (!salt || !key) throw new Error('Invalid hash format');
  
  const derivedKey = crypto.scryptSync(
    password.normalize('NFKC'),
    Buffer.from(salt, 'hex'),
    64,
    16384, 16, 1
  );
  return derivedKey.toString('hex') === key;
}

async function main() {
  const pool = new Pool({
    connectionString: 'postgresql://govmeeting:devpass@localhost:5432/govmeeting_dev',
  });

  const result = await pool.query(
    'SELECT u.email, a.password FROM "User" u JOIN "Account" a ON a."userId"=u.id WHERE u.email=$1',
    ['super@gov.sl']
  );

  if (result.rows.length === 0) {
    console.error('No credentials found');
    process.exit(1);
  }

  const { email, password: hash } = result.rows[0];
  console.log(`Testing ${email}...`);
  
  const [salt, key] = hash.split(':');
  console.log(`Hash: ${salt}:${key.substring(0, 50)}...`);
  console.log(`Salt length: ${salt.length}, Key length: ${key.length}`);
  
  const valid = await verifyPassword(hash, 'Password@123');
  console.log(`Password@123 valid? ${valid}`);
  
  const invalid = await verifyPassword(hash, 'WrongPassword');
  console.log(`WrongPassword valid? ${invalid}`);

  await pool.end();
  process.exit(0);
}

main();
