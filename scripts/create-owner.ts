/** Create or replace the owner account of a self-hosted deployment.
 * The password is read from the first line of standard input, hashed with Argon2id,
 * and never printed or stored in plaintext. Replacing the password revokes every session. */
import { Database } from 'bun:sqlite';
import { Auth } from '../src/server/auth';

const email = process.env.SCIEPO_OWNER_EMAIL?.trim().toLowerCase();
const path = process.env.SCIEPO_DB_PATH;
const origin = process.env.SCIEPO_PUBLIC_ORIGIN;
if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('Set SCIEPO_OWNER_EMAIL to the owner email address.');
if (!path) throw new Error('Set SCIEPO_DB_PATH to the database the server uses.');
if (!origin) throw new Error('Set SCIEPO_PUBLIC_ORIGIN to the exact HTTPS origin of the deployment.');
const password = (await new Response(Bun.stdin.stream()).text()).split(/\r?\n/)[0] ?? '';
if (password.length < 12 || password.length > 1024) throw new Error('Provide a password of 12 to 1024 characters on standard input.');

const db = new Database(path, {create: true, strict: true});
try {
  new Auth(db, origin);
  if (db.query('SELECT email FROM auth_users WHERE email<>?').get(email)) throw new Error('This deployment supports one owner, and a different owner already exists.');
  const hash = await Bun.password.hash(password, {algorithm: 'argon2id'});
  db.transaction(() => {
    db.run('INSERT INTO auth_users(email,password_hash) VALUES(?,?) ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash', [email, hash]);
    db.run('DELETE FROM auth_sessions');
  })();
  console.log(JSON.stringify({ownerConfigured: true, email, sessionsRevoked: true}));
} finally {
  db.close();
}
