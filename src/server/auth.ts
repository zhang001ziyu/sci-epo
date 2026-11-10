import { createHash, randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const cookieName = '__Host-sciepo-session';
const lifetime = 7 * 24 * 60 * 60 * 1000;
export class AuthError extends Error { constructor(public status: number, message: string) { super(message); } }
export interface Session { tokenHash: string; email: string; csrf: string }

/** A private, single-owner workspace. No public registration or shared AINovel sessions. */
export class Auth {
  private activeChecks = 0;
  constructor(readonly db: Database, readonly origin: string) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('公开部署必须配置精确的 HTTPS origin。');
    db.exec(`CREATE TABLE IF NOT EXISTS auth_users (email TEXT PRIMARY KEY, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_attempts (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, resets INTEGER NOT NULL);`);
  }
  session(req: Request): Session | undefined {
    const raw = req.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!raw || !/^[\w-]{43}$/.test(raw)) return;
    const tokenHash = hash(raw);
    const row = this.db.query<{email: string; csrf: string}, [string, number]>(
      'SELECT s.email,s.csrf FROM auth_sessions s JOIN auth_users u ON u.email=s.email WHERE token_hash=? AND expires>?').get(tokenHash, Date.now());
    return row ? {tokenHash, ...row} : undefined;
  }
  require(req: Request, write: boolean): Session {
    const session = this.session(req);
    if (!session) throw new AuthError(401, '请先登录创作空间。');
    if (write && req.headers.get('x-csrf-token') !== session.csrf) throw new AuthError(403, '会话校验失败，请刷新后重试。');
    return session;
  }
  private throttle(ip: string, email: string) {
    const time = Date.now();
    this.db.run('DELETE FROM auth_attempts WHERE resets<=?', [time]);
    for (const bucket of ['ip:' + hash(ip), 'email:' + hash(email)]) {
      const row = this.db.query<{count:number}, [string]>('SELECT count FROM auth_attempts WHERE bucket=?').get(bucket);
      if ((row?.count ?? 0) >= 10) throw new AuthError(429, '登录尝试过多，请 15 分钟后重试。');
    }
    for (const bucket of ['ip:' + hash(ip), 'email:' + hash(email)]) this.db.run(
      'INSERT INTO auth_attempts(bucket,count,resets) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1', [bucket,time+15*60*1000]);
  }
  async login(req: Request, ip: string): Promise<Response> {
    if (!req.headers.get('content-type')?.startsWith('application/json')) throw new AuthError(415, '请使用 JSON 请求。');
    const text = await req.text();
    if (text.length > 4096) throw new AuthError(413, '登录信息过长。');
    let body: {email?:unknown;password?:unknown};
    try { body = JSON.parse(text); } catch { throw new AuthError(400, '登录信息格式无效。'); }
    if (!body || typeof body.email !== 'string' || body.email.length > 254 || typeof body.password !== 'string' || !body.password || body.password.length > 1024) throw new AuthError(400, '请输入邮箱和密码。');
    const email = body.email.trim().toLowerCase();
    this.throttle(ip, email);
    if (this.activeChecks >= 2) throw new AuthError(429, '登录服务繁忙，请稍后再试。');
    // Use the same work factor for unknown emails without leaking the stored credential.
    const owner = this.db.query<{email:string;password_hash:string}, []>('SELECT email,password_hash FROM auth_users LIMIT 1').get();
    if (!owner) throw new AuthError(503, '账号尚未初始化。');
    this.activeChecks++;
    let verified = false;
    try { verified = await Bun.password.verify(body.password, owner.password_hash); }
    finally { this.activeChecks--; }
    if (!verified || owner.email !== email) throw new AuthError(401, '邮箱或密码不正确。');
    this.db.run('DELETE FROM auth_attempts WHERE bucket IN (?,?)', ['ip:' + hash(ip), 'email:' + hash(email)]);
    const raw = token(), csrf = token(), time = Date.now();
    this.db.run('DELETE FROM auth_sessions WHERE expires<=?', [time]);
    const previous = this.session(req);
    if (previous) this.db.run('DELETE FROM auth_sessions WHERE token_hash=?', [previous.tokenHash]);
    this.db.run('INSERT INTO auth_sessions(token_hash,email,csrf,expires) VALUES(?,?,?,?)', [hash(raw), email, csrf, time+lifetime]);
    return Response.json({email,csrf}, {headers:{'set-cookie':`${cookieName}=${raw}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${lifetime/1000}`}});
  }
  logout(req: Request): Response {
    const session = this.require(req, true);
    this.db.run('DELETE FROM auth_sessions WHERE token_hash=?', [session.tokenHash]);
    return Response.json({ok:true}, {headers:{'set-cookie':`${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`}});
  }
}
