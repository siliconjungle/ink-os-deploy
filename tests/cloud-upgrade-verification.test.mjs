import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, realpath, mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { initializeCloudSetup, describeCloudSetup, runCloudSetup } from '../lib/cloud-setup.mjs';
import { planCloudUpgrade } from '../lib/cloud-upgrades.mjs';
import { verifyCloudUpgrade } from '../lib/cloud-upgrade-verification.mjs';
import { fingerprint } from '../lib/cloud-config.mjs';
import { readPrivateJSON, writePrivateJSON } from '../lib/cloud-private.mjs';
import { runCloudCLI } from '../cli/cloud.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>hash(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item));
const platformRoot=process.env.INK_OS_TEST_PLATFORM_ROOT?await realpath(resolve(process.env.INK_OS_TEST_PLATFORM_ROOT)):null;
const edgeModule=platformRoot?await import(pathToFileURL(join(platformRoot,'infra/edge/worker.mjs')).href):null;
const integration=(name,run)=>test(name,{skip:platformRoot?false:'Set INK_OS_TEST_PLATFORM_ROOT to a trusted selected platform checkout for integration fixtures.'},run);
const image=(name,n)=>'example.test/'+name+'@sha256:'+n.repeat(64),foreignId='f'.repeat(32);
async function fixture(t,{bootstrap=false,lose,wrongInstance=false,wrongImages=false,busy=false,generationZero=false}={}){
  const directory=await realpath(await mkdtemp(join(tmpdir(),'ink-upgrade-verification-')));t.after(()=>rm(directory,{recursive:true,force:true}));
  const config={fly:{organization:'proof-org',region:'syd',osImage:image('os','a'),runtimeImage:image('runtime','b')},cloudflare:{accountId:'a'.repeat(32),zoneId:'b'.repeat(32),zoneName:'example.test',tls:'existing',appRouting:'shared-zone-wildcard'}};
  const [storage,edge,assets]=await Promise.all(['infra/r2/worker.mjs','infra/edge/worker.mjs','infra/edge/game-assets.mjs'].map(path=>readFile(join(platformRoot,path),'utf8'))),artifacts={storage:{'worker.mjs':storage},edge:{'worker.mjs':edge,'game-assets.mjs':assets}},args={directory,config,artifacts,platformRoot},plan=await initializeCloudSetup(args),journalPath=join(directory,'journal.json'),journal=await readPrivateJSON(journalPath),secrets=await readPrivateJSON(join(directory,'secrets.json'));
  for(const step of journal.plan.steps)journal.steps[step]={status:'done',attempt:'0'.repeat(32),receipt:{id:step}};journal.status='acceptance-pending';journal.storageProof={stage:'complete'};await writePrivateJSON(journalPath,journal);const originalJournal=await readFile(journalPath,'utf8');
  const target={os:image('os','c'),runtime:bootstrap?config.fly.runtimeImage:image('runtime','d')};let upgrade;
  if(!generationZero){
    upgrade=await planCloudUpgrade({...args,images:target,mode:bootstrap?'external-stopped-bootstrap':'automatic'});const path=join(directory,'upgrades',upgrade.operationId),intent=await readPrivateJSON(join(path,'intent.json')),progress=await readPrivateJSON(join(path,'progress.json'));
    // Historical completed image-transition fixture; runtime acceptance is executed below.
    const binding={instanceId:journal.identity.id,configHash:journal.configHash,artifactHash:journal.artifactHash,planHash:fingerprint(journal.plan)},evidence={format:'ink-cloud-upgrade-evidence-v1',operationId:upgrade.operationId,intentHash:digest(intent),provider:{}};
    const receipt={format:'ink-cloud-upgrade-receipt-v1',operationId:upgrade.operationId,intentHash:digest(intent),binding,generation:1,fromImages:intent.fromImages,targetImages:target,evidenceSha256:digest(evidence),customRuntimeImages:[],completedAt:new Date().toISOString(),verification:bootstrap?'bootstrap-applied-with-external-quiescence-attestation-automatic-proof-pending':'host-restart-and-image-provenance-verified-post-upgrade-runtime-use-pending'};
    await writePrivateJSON(join(path,'evidence.json'),evidence);await writePrivateJSON(join(path,'receipt.json'),receipt);await writePrivateJSON(join(path,'progress.json'),{...progress,phase:'complete'});await writePrivateJSON(join(directory,'current-images.json'),{format:'ink-cloud-current-images-v1',binding,generation:1,images:target,activeOperation:null,lastOperation:upgrade.operationId,receiptHash:digest(receipt)});
  }
  const foreign={id:foreignId,title:'Existing paid app',namespace:'os',kind:'app',body:JSON.stringify({slug:'do-not-touch',commands:[{id:'paid',effect:'paid'}]})},foreignData={id:'9'.repeat(32),namespace:foreignId,kind:'state',title:'Existing state',tags:[],body:'{"credits":37}'};
  const apps=new Map([[foreignId,foreign]]),records=new Map([[foreignData.id,foreignData]]),releases=new Map(),objects=new Map(),state=new Map(),calls=[],mutations=[];
  const model={images:wrongImages?{...target,os:image('wrong','e')}:target,instanceId:wrongInstance?'e'.repeat(32):plan.instanceId,bootId:'3'.repeat(32),busy,lost:false,slot:null,idle:false,idlePolls:0,creates:0,purges:0};let backend,bundle,sourceBytes,canaryId;
  const foreignWorker={slotId:'8'.repeat(32),appId:foreignId,releaseId:'7'.repeat(32),leaseId:'6'.repeat(32),status:'ready',inFlight:2,holds:[{id:'foreign-held'}]};
  const env={EDGE_TOKEN:secrets.edgeToken,APP_DOMAIN:plan.resources.appDomain,APP_HOST_SUFFIX:plan.resources.appHostSuffix,ASSETS:{get:async key=>objects.has(key)?new Response(objects.get(key)):null}};
  async function invoke(appId,input){assert.equal(appId,canaryId);model.slot={slotId:'4'.repeat(32),appId,releaseId:'2'.repeat(32),leaseId:'5'.repeat(32),status:'ready',inFlight:0,holds:model.busy?[{id:'own-held'}]:[]};const ink={state:{get:async key=>({value:state.get(key)||null,revision:state.has(key)?1:0}),set:async(key,value,expected)=>{assert.equal(expected,state.has(key)?1:0);state.set(key,value);const id=hash(appId+'\0state\0'+key).slice(0,32);records.set(id,{id,namespace:appId,kind:'state',title:key,tags:[],body:JSON.stringify(value)});return{value,revision:1};}},compute:{allowIdle:async()=>{assert.equal(model.busy,false);model.idle=true;}}};const result=await backend.fetch(new Request('https://backend.test'+input.path,{method:input.method||'GET',...(input.body?{body:JSON.stringify(input.body),headers:{'Content-Type':'application/json'}}:{})}),{ink});return{status:result.status,headers:{},body:await result.json()};}
  const server=createServer(async(request,response)=>{const json=(value,status=200)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};try{
    const url=new URL(request.url,plan.origin),path=url.pathname,method=request.method;calls.push({path,method,authorization:request.headers.authorization});if(path==='/api/health'){assert.equal(request.headers.authorization,undefined);return json({ok:true,instanceId:model.instanceId});}
    assert.equal(request.headers.authorization,'Bearer '+(path==='/_ink/edge/invoke'?secrets.edgeToken:secrets.ownerToken));const chunks=[];for await(const chunk of request)chunks.push(chunk);const input=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
    if(path==='/_ink/edge/invoke')return json(await invoke(input.appId,input));const api=path.slice('/api/v1/'.length);if(method!=='GET')mutations.push({path:api,method});
    if(api==='maintenance')return json({format:'ink-os-maintenance-inspection-v1',instanceId:plan.instanceId,bootId:model.bootId,images:model.images,admissionClosed:false,activeOperation:null,ready:true});
    if(api==='apps'&&method==='GET')return json([...apps.values()]);
    if(api==='runtimes'){if(model.idle&&++model.idlePolls>=2&&!model.busy)model.slot=null;return json({slots:[foreignWorker,...(model.slot?[model.slot]:[])]});}
    if(api==='apps'&&method==='POST'){canaryId=hash('ink-os-app:'+input.slug).slice(0,32);const app={id:canaryId,title:input.title,namespace:'os',kind:'app',body:JSON.stringify({slug:input.slug,commands:input.commands,capabilities:input.capabilities})};apps.set(canaryId,app);model.creates++;if(lose==='create'&&!model.lost){model.lost=true;return response.destroy();}return json(app,201);}
    const appId=api.split('/')[1],app=apps.get(appId);if(method!=='GET')assert.notEqual(appId,foreignId);
    if(api==='apps/'+appId+'/status')return app?json({app,releases:[...releases.values()]}):json({},404);
    if(api==='apps/'+appId+'/releases'&&method==='POST'){bundle=input;sourceBytes=Buffer.from(JSON.stringify(input));const digest=hash(sourceBytes),id='2'.repeat(32),asset='a'.repeat(32),record={id:asset,namespace:appId,kind:'file',title:'Source',tags:['app-source','release'],body:JSON.stringify({digest}),location:'r2://fixture/objects/'+digest};records.set(asset,record);objects.set('objects/'+digest,sourceBytes);backend=await import('data:text/javascript;base64,'+input.files.find(file=>file.path==='server/main.mjs').base64);const release={id,body:JSON.stringify({appId,digest,runtimeAuth:2,commands:input.commands,backend:input.backend,entry:input.entry,bundleObjectId:asset,bundleLocation:record.location})};releases.set(id,release);if(lose==='release'&&!model.lost){model.lost=true;return response.destroy();}return json(release,201);}
    if(api.startsWith('runtime/bundle/'))return json(bundle);
    if(api.startsWith('assets/'))return records.has(api.slice(7))?(response.writeHead(200),response.end(sourceBytes)):json({},404);
    if(api.endsWith('/publish')){const id=api.split('/')[3],meta=JSON.parse(releases.get(id).body);meta.deployment={provider:'pool',url:'https://'+id+'-'+env.APP_HOST_SUFFIX+'.'+env.APP_DOMAIN};releases.get(id).body=JSON.stringify(meta);app.body=JSON.stringify({...JSON.parse(app.body),releaseId:id});objects.set('edge/releases/'+id+'.json',JSON.stringify({appId,releaseId:id,digest:meta.digest,entry:bundle.entry,backend:bundle.backend}));if(lose==='publish'&&!model.lost){model.lost=true;return response.destroy();}return json(app);}
    if(api.endsWith('/invoke')){const result=await invoke(appId,input);if(lose==='invoke'&&input.path==='/count'&&!model.lost){model.lost=true;return response.destroy();}return json(result);}
    if(api.startsWith('state/'))return json({value:state.get('upgraded-canary')||null,revision:state.size?1:0});
    if(api.endsWith('/launch')){const releaseId=JSON.parse(app.body).releaseId,origin='https://'+releaseId+'-'+env.APP_HOST_SUFFIX+'.'+env.APP_DOMAIN,ticket=await edgeModule.sign({kind:'launch',appId,releaseId,exp:Date.now()+60000},secrets.edgeToken);return json({releaseId,origin,url:origin+'/_ink/launch?ticket='+ticket});}
    if(api==='data')return json([...records.values()].filter(record=>record.namespace===url.searchParams.get('namespace')));
    if(api.startsWith('data/'))return releases.has(api.slice(5))?json(releases.get(api.slice(5))):json({},404);
    if(api==='apps/'+appId&&method==='DELETE'){assert.notEqual(model.slot?.appId,appId);if(!url.searchParams.has('permanent')){app.archived=true;return json(app);}apps.delete(appId);for(const[id,record]of records)if(record.namespace===appId)records.delete(id);releases.clear();objects.clear();state.clear();model.purges++;if(lose==='purge'&&!model.lost){model.lost=true;return response.destroy();}return json({deleted:true,permanent:true,removedBlobs:1});}
    return json({},404);
  }catch(error){json({error:'Fixture assertion: '+error.message},500);}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const local='http://127.0.0.1:'+server.address().port;env.OS_ORIGIN=local;t.after(()=>new Promise(done=>server.close(done)));
  const transport=async(input,init={})=>{const url=new URL(input);if(url.origin===plan.origin)return fetch(local+url.pathname+url.search,init);assert.equal(new Headers(init.headers).get('authorization'),null);return edgeModule.default.fetch(new Request(input,init),env);};
  const configPath=join(directory,'config-input.json');await writePrivateJSON(configPath,config);
  const cli=async argv=>{let output='',errors='';const code=await runCloudCLI({argv:[...argv,'--config',configPath,'--state',directory,'--platform-root',platformRoot],env:{},fetch:transport,stdout:{write:value=>output+=value},stderr:{write:value=>errors+=value}});return{code,result:JSON.parse(output||errors),errors};};
  const preserved=()=>{assert.deepEqual(apps.get(foreignId),foreign);assert.deepEqual(records.get(foreignData.id),foreignData);assert.equal(foreignWorker.inFlight,2);assert.equal(foreignWorker.holds.length,1);assert.ok(mutations.every(item=>item.path==='apps'||item.path.startsWith('apps/'+canaryId)));};
  return{args,plan,upgrade,target,model,apps,records,calls,mutations,directory,secrets,originalJournal,journalPath,transport,cli,preserved};
}

integration('actual current verifier/SDK/edge over HTTP promotes only current-generation runtime acceptance on nonempty host',async t=>{
  const f=await fixture(t),result=await verifyCloudUpgrade({...f.args,phase:'run',fetch:f.transport});assert.equal(result.status,'passed');assert.equal(result.acceptance.pooledBackendCanary,'passed');assert.equal(f.apps.size,1);f.preserved();assert.equal(await readFile(f.journalPath,'utf8'),f.originalJournal);
  const status=await describeCloudSetup(f.args);assert.equal(status.status,'post-upgrade-runtime-verified');assert.equal(status.acceptance.pooledBackendCanary,'passed');assert.equal(status.acceptance.runtimeVerification.liveAudit,'not-performed');assert.equal(status.acceptance.restartPersistence,'not-accepted-for-current-generation');
  const count=f.calls.length;assert.equal((await verifyCloudUpgrade({...f.args,phase:'run',fetch:()=>assert.fail('historical receipt is offline')})).historical,true);assert.equal(f.calls.length,count);assert.equal((await runCloudSetup({...f.args,fetch:()=>assert.fail('completed apply is historical')})).status,'post-upgrade-runtime-verified');
  assert.ok(!JSON.stringify(result).includes(f.secrets.ownerToken));
});

integration('bootstrap runtime proof passes independently while automatic maintenance proof remains pending and CLI is explicit',async t=>{
  const f=await fixture(t,{bootstrap:true});for(const argv of [['upgrade','verify'],['upgrade','verify','--phase','restart'],['upgrade','verify','--phase','run','--operation',f.upgrade.operationId],['upgrade','verify','--phase','run','--token','do-not-print-token']]){const result=await f.cli(argv);assert.equal(result.code,1);assert.ok(!result.errors.includes('do-not-print-token'));}assert.equal(f.mutations.length,0);
  const result=await f.cli(['upgrade','verify','--phase','run']);assert.equal(result.code,0,result.errors);assert.equal(result.result.verification.status,'passed');assert.equal(result.result.deployment.status,'bootstrap-automatic-proof-pending');assert.equal(result.result.deployment.acceptance.pooledBackendCanary,'passed');assert.equal(result.result.deployment.acceptance.automaticMaintenanceProof,'pending');f.preserved();
});

for(const lose of ['create','release','publish','invoke','purge'])integration('lost '+lose+' current-verifier reply preserves same attempt and foreign work',async t=>{
  const f=await fixture(t,{lose});await assert.rejects(verifyCloudUpgrade({...f.args,phase:'run',fetch:f.transport}));const index=await readPrivateJSON(join(f.directory,'upgrade-verification.json')),id=index.attempt.id;const result=await verifyCloudUpgrade({...f.args,phase:'run',fetch:f.transport});assert.equal((await readPrivateJSON(join(f.directory,'upgrade-verification.json'))).attempt.id,id);assert.equal(result.status,lose==='purge'?'cleanup-acknowledgement-pending':'passed');assert.equal(f.model.creates,1);assert.equal(f.model.purges,1);f.preserved();
  if(lose==='purge'){assert.equal((await describeCloudSetup(f.args)).status,'post-upgrade-runtime-use-pending');assert.equal((await describeCloudSetup(f.args)).acceptance.pooledBackendCanary,'pending-for-current-generation');}
});

integration('missing active verifier journal never initializes a second canary after mutation; lost wrapper write resumes completed proof',async t=>{
  const f=await fixture(t,{lose:'create'});await assert.rejects(verifyCloudUpgrade({...f.args,phase:'run',fetch:f.transport}));const index=await readPrivateJSON(join(f.directory,'upgrade-verification.json')),path=join(f.directory,'upgrade-verification',index.attempt.id,'journal.json');await unlink(path);const count=f.calls.length;await assert.rejects(verifyCloudUpgrade({...f.args,phase:'run',fetch:()=>assert.fail('missing journal must fail locally')}),{code:'upgraded-verification-journal-recovery-required'});assert.equal(f.calls.length,count);assert.equal(f.model.creates,1);f.preserved();
  const g=await fixture(t);await verifyCloudUpgrade({...g.args,phase:'run',fetch:g.transport});const indexPath=join(g.directory,'upgrade-verification.json'),saved=await readPrivateJSON(indexPath);saved.attempt.status='running';delete saved.attempt.receiptHash;await writePrivateJSON(indexPath,saved);await unlink(join(g.directory,'upgrade-verification',saved.attempt.id,'receipt.json'));assert.equal((await verifyCloudUpgrade({...g.args,phase:'run',fetch:()=>assert.fail('completed actual verifier journal is offline')})).status,'passed');assert.equal(g.model.creates,1);g.preserved();
});

integration('wrong instance/image, generation zero and active upgrade refuse before canary writes',async t=>{
  for(const options of[{wrongInstance:true},{wrongImages:true},{generationZero:true}]){const f=await fixture(t,options);await assert.rejects(verifyCloudUpgrade({...f.args,phase:'run',fetch:f.transport}));assert.equal(f.mutations.length,0);if(options.wrongInstance)assert.ok(f.calls.every(call=>!call.authorization));f.preserved();}
  const active=await fixture(t);await planCloudUpgrade({...active.args,images:{os:image('next-os','e'),runtime:image('next-runtime','f')}});await assert.rejects(verifyCloudUpgrade({...active.args,phase:'run',fetch:()=>assert.fail('active image transition cannot verify')}),{code:'upgraded-verification-upgrade-in-progress'});
});

integration('busy canary and changed-image explicit cleanup never promote a current proof',async t=>{
  const f=await fixture(t,{lose:'invoke'});await assert.rejects(verifyCloudUpgrade({...f.args,phase:'run',fetch:f.transport}));f.model.images={...f.target,os:image('different','e')};const result=await verifyCloudUpgrade({...f.args,phase:'cleanup',fetch:f.transport});assert.equal(result.status,'cleaned');assert.equal((await describeCloudSetup(f.args)).status,'post-upgrade-runtime-use-pending');assert.equal(f.apps.size,1);f.preserved();
});

integration('tampered proof/current receipt and unsupported selected source closure never become acceptance',async t=>{
  const f=await fixture(t);await verifyCloudUpgrade({...f.args,phase:'run',fetch:f.transport});const index=await readPrivateJSON(join(f.directory,'upgrade-verification.json')),proofPath=join(f.directory,'upgrade-verification',index.attempt.id,'proof.json'),proof=await readPrivateJSON(proofPath);proof.foreignMutationRequests=1;await writePrivateJSON(proofPath,proof);await assert.rejects(describeCloudSetup(f.args),{code:'invalid-upgraded-verification-receipt'});
  const g=await fixture(t),selected=join(g.directory,'unsupported-platform');await mkdir(join(selected,'scripts'),{recursive:true});await writeFile(join(selected,'scripts/verify-upgraded-host.mjs'),'import "https://foreign.example.test/proof.mjs";export function verifyUpgradedHost(){}');await assert.rejects(verifyCloudUpgrade({...g.args,platformRoot:selected,phase:'run',fetch:()=>assert.fail('unsupported code must not execute')}),{code:'selected-verifier-import-closure-unsupported'});assert.equal(g.mutations.length,0);
});

integration('a later generation or changed current upgrade receipt never inherits the prior runtime proof',async t=>{
  const f=await fixture(t);await verifyCloudUpgrade({...f.args,phase:'run',fetch:f.transport});
  const images={os:image('next-os','e'),runtime:image('next-runtime','f')},next=await planCloudUpgrade({...f.args,images}),path=join(f.directory,'upgrades',next.operationId),intent=await readPrivateJSON(join(path,'intent.json')),progress=await readPrivateJSON(join(path,'progress.json')),current=await readPrivateJSON(join(f.directory,'current-images.json'));
  const evidence={format:'ink-cloud-upgrade-evidence-v1',operationId:next.operationId,intentHash:digest(intent),provider:{}},receipt={format:'ink-cloud-upgrade-receipt-v1',operationId:next.operationId,intentHash:digest(intent),binding:current.binding,generation:2,fromImages:intent.fromImages,targetImages:images,evidenceSha256:digest(evidence),customRuntimeImages:[],completedAt:new Date().toISOString(),verification:'host-restart-and-image-provenance-verified-post-upgrade-runtime-use-pending'};
  await writePrivateJSON(join(path,'evidence.json'),evidence);await writePrivateJSON(join(path,'receipt.json'),receipt);await writePrivateJSON(join(path,'progress.json'),{...progress,phase:'complete'});await writePrivateJSON(join(f.directory,'current-images.json'),{...current,generation:2,images,activeOperation:null,lastOperation:next.operationId,receiptHash:digest(receipt)});
  const status=await describeCloudSetup(f.args);assert.equal(status.generation,2);assert.equal(status.status,'post-upgrade-runtime-use-pending');assert.equal(status.acceptance.pooledBackendCanary,'pending-for-current-generation');assert.equal(status.acceptance.runtimeVerification,undefined);f.preserved();
  const altered=await readPrivateJSON(join(path,'receipt.json'));altered.completedAt='2000-01-01T00:00:00.000Z';await writePrivateJSON(join(path,'receipt.json'),altered);await assert.rejects(describeCloudSetup(f.args),{code:'upgrade-lineage-receipt-mismatch'});
});

integration('changed active source binding and caller proof arguments cannot replace actual verifier execution',async t=>{
  const f=await fixture(t,{lose:'create'});await assert.rejects(verifyCloudUpgrade({...f.args,phase:'run',fetch:f.transport}));const indexPath=join(f.directory,'upgrade-verification.json'),index=await readPrivateJSON(indexPath);index.attempt.binding.sourcesHash='c'.repeat(64);await writePrivateJSON(indexPath,index);
  await assert.rejects(verifyCloudUpgrade({...f.args,phase:'run',fetch:()=>assert.fail('changed source binding executed')}),{code:'upgraded-verification-inputs-changed-cleanup-required'});assert.equal(f.model.creates,1);
  const g=await fixture(t),result=await g.cli(['upgrade','verify','--phase','run','--proof','/private/claimed-passed.json']);assert.equal(result.code,1);assert.equal(g.mutations.length,0);
});
