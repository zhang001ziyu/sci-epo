import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });

async function createOwner(env: Record<string, string>, stdin: string) {
  const proc = Bun.spawn([process.execPath, 'run', 'scripts/create-owner.ts'], {
    cwd: join(import.meta.dir, '..'), env: {...process.env, ...env}, stdin: new Response(stdin), stdout: 'pipe', stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return {code, out, err};
}

test('self-hosting owner setup hashes the password, revokes sessions and keeps a single owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sciepo-owner-')); dirs.push(dir);
  const path = join(dir, 'studio.sqlite');
  const base = {SCIEPO_DB_PATH: path, SCIEPO_PUBLIC_ORIGIN: 'https://studio.example.test'};

  expect((await createOwner({...base, SCIEPO_OWNER_EMAIL: 'owner@example.test'}, 'too short\n')).code).not.toBe(0);
  expect((await createOwner({...base, SCIEPO_OWNER_EMAIL: 'owner@example.test', SCIEPO_PUBLIC_ORIGIN: 'http://studio.example.test'}, 'a long enough password\n')).code).not.toBe(0);

  const created = await createOwner({...base, SCIEPO_OWNER_EMAIL: ' Owner@Example.test '}, 'correct horse battery staple\nignored\n');
  expect(created.code).toBe(0);
  expect(created.out + created.err).not.toContain('correct horse');
  const db = new Database(path);
  const row = db.query('SELECT email,password_hash FROM auth_users').get() as {email: string; password_hash: string};
  expect(row.email).toBe('owner@example.test');
  expect(row.password_hash.startsWith('$argon2id$')).toBe(true);
  expect(await Bun.password.verify('correct horse battery staple', row.password_hash)).toBe(true);
  db.run('INSERT INTO auth_sessions(token_hash,email,csrf,expires) VALUES(?,?,?,?)', ['session-hash', row.email, 'csrf', Date.now() + 60_000]);
  db.close();

  expect((await createOwner({...base, SCIEPO_OWNER_EMAIL: 'owner@example.test'}, 'a replacement password\n')).code).toBe(0);
  expect((await createOwner({...base, SCIEPO_OWNER_EMAIL: 'someone@example.test'}, 'another long password\n')).code).not.toBe(0);
  const after = new Database(path);
  const owners = after.query('SELECT email,password_hash FROM auth_users').all() as {email: string; password_hash: string}[];
  expect(owners.map(o => o.email)).toEqual(['owner@example.test']);
  expect(await Bun.password.verify('a replacement password', owners[0]!.password_hash)).toBe(true);
  expect((after.query('SELECT count(*) AS n FROM auth_sessions').get() as {n: number}).n).toBe(0);
  after.close();
});
