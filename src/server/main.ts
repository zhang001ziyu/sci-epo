import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Store } from './store';
import { createApp } from './app';
import { demoProvider } from './demo';
import { ProviderManager, providerKey } from './providerManager';
const root=resolve(import.meta.dir,'../..');
const dbPath=process.env.SCIEPO_DB_PATH??resolve(root,'data/sci-epo.sqlite');
mkdirSync(dirname(dbPath),{recursive:true,mode:0o700});
if(process.env.SCIEPO_PREBUILT==='true') {
 if(!existsSync(resolve(root,'dist/app.js')))throw new Error('缺少已构建的界面。');
} else {
 const build=await Bun.build({entrypoints:[resolve(root,'web/app.ts')],outdir:resolve(root,'dist'),target:'browser',minify:true});
 if(!build.success)throw new Error('界面构建失败，请运行 bun run typecheck 检查。');
}
const store=new Store(dbPath);chmodSync(dbPath,0o600);store.recoverInterrupted();
const port=Number(process.env.SCIEPO_PORT??4317);
const modelFile=process.env.SCIEPO_MODEL_CONFIG_FILE;
const hasSecrets=!!store.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_revisions'").get()&&!!store.db.query('SELECT 1 FROM model_revisions WHERE secret IS NOT NULL LIMIT 1').get();
const managed=new ProviderManager(store.db,providerKey(process.env.SCIEPO_PROVIDER_KEY_FILE??resolve(dirname(dbPath),'provider.key'),hasSecrets));
let modelEnv=process.env;
if(!managed.catalog().connections.length){
 if(modelFile){try{modelEnv=await Bun.file(modelFile).json();}catch{throw new Error('私密模型配置文件无法读取或格式无效。');}}
 managed.importEnvironment(modelEnv);
}
const publicOrigin=process.env.SCIEPO_PUBLIC_ORIGIN;
if(process.env.NODE_ENV==='production'&&!publicOrigin)throw new Error('公开部署必须启用账号保护。');
const mediaDir=process.env.SCIEPO_MEDIA_DIR??resolve(dirname(dbPath),'media');
mkdirSync(mediaDir,{recursive:true,mode:0o700});
const quotaMb=Number(process.env.SCIEPO_MEDIA_QUOTA_MB??5120);
if(!Number.isFinite(quotaMb)||quotaMb<=0)throw new Error('SCIEPO_MEDIA_QUOTA_MB 需为正数。');
const workerPublicUrl=process.env.SCIEPO_WORKER_PUBLIC_URL;
if(workerPublicUrl&&!/^https:\/\/[^\s/?#]+\/?$/u.test(workerPublicUrl))throw new Error('SCIEPO_WORKER_PUBLIC_URL 需为 https 地址，例如隧道地址。');
const app=createApp(store,{demo:demoProvider,managed},root,{publicOrigin,media:{dir:mediaDir,quotaMb},...(workerPublicUrl?{workerPublicUrl}:{})});
// JSON routes check their own limit; the larger cap is for media uploads, which are checked per kind while streaming.
const server=Bun.serve({hostname:'127.0.0.1',port,idleTimeout:0,maxRequestBodySize:300*1024*1024,fetch:app});
console.log(`Sci-epo: ${server.url} · ${managed.ready()?'创作模型配置已加载':'未配置真实模型；示例演练可用'}`);
// Optional second listener with only the worker API, for a tunnel from Colab to a Sci-epo on this computer.
const workerPort=process.env.SCIEPO_WORKER_PORT?Number(process.env.SCIEPO_WORKER_PORT):undefined;
const workerServer=workerPort?Bun.serve({hostname:'127.0.0.1',port:workerPort,idleTimeout:0,maxRequestBodySize:80*1024*1024,fetch:app.worker}):undefined;
if(workerServer)console.log(`Sci-epo worker API only: ${workerServer.url}${workerPublicUrl?` · sessions use ${workerPublicUrl}`:' · set SCIEPO_WORKER_PUBLIC_URL to the tunnel address'}`);
const stop=()=>{server.stop(true);workerServer?.stop(true);store.close();process.exit(0);};
process.on('SIGINT',stop);
process.on('SIGTERM',stop);
