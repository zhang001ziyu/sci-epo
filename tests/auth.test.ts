import { afterEach, expect, test } from 'bun:test';
import { Store } from '../src/server/store';
import { createApp } from '../src/server/app';
import { demoProvider } from '../src/server/demo';
const stores: Store[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();});
const origin='https://sci.example.test';
async function harness(){
 const store=new Store();stores.push(store);
 const app=createApp(store,{demo:demoProvider},process.cwd(),{publicOrigin:origin});
 store.db.run('INSERT INTO auth_users(email,password_hash) VALUES(?,?)',['owner@example.test',await Bun.password.hash('test-only-password',{algorithm:'argon2id',memoryCost:8192,timeCost:1})]);
 const call=(path:string,body?:unknown,headers:Record<string,string>={})=>app(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{...(body!==undefined?{'content-type':'application/json',origin}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})}));
 const login=()=>call('/api/auth/login',{email:' OWNER@example.test ',password:'test-only-password'});
 return {store,app,call,login};
}
test('public API and exports are private; login gives secure cookie and independent CSRF',async()=>{
 const h=await harness();
 for(const path of ['/api/projects','/api/status','/api/revisions/secret/export','/api/localizations/secret/export','/api/auth/session'])expect((await h.call(path)).status).toBe(401);
 const response=await h.login();expect(response.status).toBe(200);
 const cookie=response.headers.get('set-cookie')!;expect(cookie).toContain('__Host-sciepo-session=');
 for(const attribute of ['HttpOnly','Secure','SameSite=Strict','Path=/'])expect(cookie).toContain(attribute);
 const data=await response.json();expect(Object.keys(data).sort()).toEqual(['csrf','email']);expect(data.csrf).toHaveLength(43);
 const sessions=h.store.db.query('SELECT token_hash FROM auth_sessions').all();expect(JSON.stringify(sessions)).not.toContain(cookie.split('=')[1]!.split(';')[0]!);
 const session=await h.call('/api/auth/session',undefined,{cookie});expect((await session.json()).email).toBe('owner@example.test');
 expect((await h.call('/api/projects',undefined,{cookie})).status).toBe(200);
 const brief={title:'Story',premise:'A choice',characters:'',worldRules:'',authorRules:''};
 expect((await h.call('/api/projects',brief,{cookie})).status).toBe(403);
 expect((await h.call('/api/projects',brief,{cookie,'x-csrf-token':data.csrf})).status).toBe(200);
 expect((await h.call('/api/auth/logout',{}, {cookie,'x-csrf-token':data.csrf})).status).toBe(200);
 expect((await h.call('/api/projects',undefined,{cookie})).status).toBe(401);
});
test('login and writes require exact origin and authority, even with forged forwarding headers',async()=>{
 const h=await harness();const body={email:'owner@example.test',password:'test-only-password'};
 expect((await h.call('/api/auth/login',body,{origin:'https://evil.test'})).status).toBe(403);
 expect((await h.app(new Request(origin+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}))).status).toBe(403);
 expect((await h.app(new Request('https://evil.test/api/auth/session',{headers:{'x-forwarded-host':'sci.example.test'}}))).status).toBe(403);
 expect((await h.call('/api/auth/login',null)).status).toBe(400);
});
test('unknown and incorrect credentials fail generically, attempts are bounded and expiry is enforced',async()=>{
 const h=await harness();
 for(let i=0;i<10;i++){
  const r=await h.call('/api/auth/login',{email:i%2?'missing@example.test':'owner@example.test',password:'wrong'});
  expect(r.status).toBe(401);expect(await r.text()).not.toContain('password_hash');
 }
 expect((await h.login()).status).toBe(429);
 h.store.db.run('DELETE FROM auth_attempts');
 const response=await h.login(),cookie=response.headers.get('set-cookie')!;
 h.store.db.run('UPDATE auth_sessions SET expires=0');
 expect((await h.call('/api/projects',undefined,{cookie})).status).toBe(401);
});
test('local mode still rejects a public Host and public origin cannot be insecure',()=>{
 const store=new Store();stores.push(store);
 expect(()=>createApp(store,{demo:demoProvider},process.cwd(),{publicOrigin:'http://sci.example.test'})).toThrow('HTTPS');
 const app=createApp(store,{demo:demoProvider});
 return app(new Request(origin+'/api/projects')).then(r=>expect(r.status).toBe(403));
});
