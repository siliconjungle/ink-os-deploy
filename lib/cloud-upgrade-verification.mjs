import { readFile, lstat, realpath, mkdir } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { fingerprint as inputFingerprint } from './cloud-config.mjs';
import { privateDirectory, readPrivateJSON, writePrivateJSON, acquireCloudLock } from './cloud-private.mjs';
import { CloudSetupError } from './cloud-providers.mjs';
import { describeCloudProvisioning } from './cloud-setup.mjs';
import { describeCloudUpgrade } from './cloud-upgrades.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const fingerprint=value=>sha(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item));
const hex=(value,n=64)=>typeof value==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(value);
const same=(a,b)=>a!==undefined&&b!==undefined&&fingerprint(a)===fingerprint(b);
const fail=code=>{throw new CloudSetupError(code);};
const check=(value,code)=>{if(!value)fail(code);};
const entry='scripts/verify-upgraded-host.mjs',indexName='upgrade-verification.json',loaded=new Map();
const originalBinding=journal=>({instanceId:journal.identity.id,originSha256:sha(journal.plan.origin),configHash:journal.configHash,artifactHash:journal.artifactHash,planHash:inputFingerprint(journal.plan)});
const proofBinding=binding=>({instanceId:binding.instanceId,hostOriginSha256:binding.originSha256,images:binding.images,generation:binding.generation,upgradeReceiptSha256:binding.upgradeReceiptSha256,verifierSourceSha256:binding.verifierSourceSha256,sdkSourcesSha256:binding.sdkSourcesSha256});
const currentBinding=(journal,current,selected)=>({format:'ink-cloud-upgraded-verifier-binding-v1',...originalBinding(journal),generation:current.generation,images:current.images,upgradeOperationId:current.lastOperation,upgradeReceiptSha256:current.receiptHash,...selected});
async function optional(path){try{return await readPrivateJSON(path);}catch(error){if(error.code!=='ENOENT')throw error;return null;}}
async function existingDirectory(path){const info=await lstat(path);check(info.isDirectory()&&!info.isSymbolicLink()&&!(info.mode&0o077)&&(!process.getuid||info.uid===process.getuid())&&await realpath(path)===path,'upgraded-verification-private-path-invalid');return path;}

async function selectedVerifier(platformRoot){
  check(typeof platformRoot==='string'&&platformRoot.length>0,'explicit-selected-platform-root-required');const root=resolve(platformRoot);check(await realpath(root)===root,'selected-platform-verifier-path-invalid');
  const hashes={},imports=new Map(),pending=[entry];let bytes=0;
  while(pending.length){const path=pending.pop();if(Object.hasOwn(hashes,path))continue;check(path===entry||path.startsWith('sdk/src/')&&/\.(?:js|mjs)$/.test(path),'selected-verifier-import-closure-unsupported');check(Object.keys(hashes).length<33,'selected-platform-verifier-source-limit');
    const file=join(root,path),info=await lstat(file);check(info.isFile()&&!info.isSymbolicLink()&&info.size<=2*1024*1024&&await realpath(file)===file,'selected-platform-verifier-path-invalid');const source=await readFile(file);bytes+=source.length;check(bytes<=4*1024*1024,'selected-platform-verifier-source-limit');hashes[path]=sha(source);const text=source.toString('utf8');check(!/\bimport\s*\(/.test(text),'selected-verifier-import-closure-unsupported');const dependencies=[];
    for(const match of text.matchAll(/(?:^|[;\n])\s*(?:import|export)\s*(?:[^;'"\n]*?\bfrom\s*)?['"]([^'"]+)['"]/g)){
      const specifier=match[1];if(specifier.startsWith('node:')){check(path===entry&&['node:assert/strict','node:crypto','node:fs','node:fs/promises','node:path','node:url'].includes(specifier),'selected-verifier-import-closure-unsupported');continue;}
      check(specifier.startsWith('./')||specifier.startsWith('../'),'selected-verifier-import-closure-unsupported');const dependency=relative(root,resolve(dirname(file),specifier));check(dependency.startsWith('sdk/src/')&&/\.(?:mjs|js)$/.test(dependency),'selected-verifier-import-closure-unsupported');dependencies.push(dependency);pending.push(dependency);
    }imports.set(path,dependencies);
  }
  check(imports.get(entry)?.includes('sdk/src/server.js'),'selected-verifier-import-closure-unsupported');
  const sourceBinding={sourcesHash:fingerprint(hashes),verifierSourceSha256:hashes[entry],sdkSourcesSha256:fingerprint(Object.fromEntries(Object.entries(hashes).filter(([path])=>path.startsWith('sdk/src/'))))},previous=loaded.get(root);
  check(!previous||same(previous.sourceBinding,sourceBinding),'selected-verifier-sources-changed-restart-process');if(previous)return previous;
  const module=await import(pathToFileURL(join(root,entry)).href+'?ink_upgraded_verifier='+sourceBinding.sourcesHash);check(typeof module.verifyUpgradedHost==='function','selected-platform-verifier-export-required');const result={sourceBinding,verify:module.verifyUpgradedHost};loaded.set(root,result);return result;
}

function validateIndex(journal,index){
  if(!index)return;
  check(index.format==='ink-cloud-upgraded-verification-state-v1'&&same(index.originalBinding,originalBinding(journal))&&hex(index.attempt?.id,32)&&['running','complete'].includes(index.attempt.status),'invalid-upgraded-verification-state');
  const binding=index.attempt.binding;check(binding?.format==='ink-cloud-upgraded-verifier-binding-v1'&&same(Object.fromEntries(Object.keys(originalBinding(journal)).map(key=>[key,binding[key]])),originalBinding(journal))&&Number.isSafeInteger(binding.generation)&&binding.generation>=1&&hex(binding.upgradeOperationId,32)&&hex(binding.upgradeReceiptSha256)&&hex(binding.verifierSourceSha256)&&hex(binding.sdkSourcesSha256)&&hex(binding.sourcesHash)&&binding.images&&['os','runtime'].every(key=>typeof binding.images[key]==='string'&&/@sha256:[a-f0-9]{64}$/.test(binding.images[key])),'invalid-upgraded-verification-state');
}
function validateVerifierJournal(binding,saved,proof){
  check(saved?.format==='ink-os-upgraded-host-journal-v1'&&hex(saved.nonce,32)&&saved.slug==='ink-upgrade-'+saved.nonce.slice(0,24)&&saved.title==='Upgrade acceptance '+saved.nonce&&saved.appId===sha('ink-os-app:'+saved.slug).slice(0,32)&&same(saved.binding,proofBinding(binding)),'upgraded-verifier-journal-identity-mismatch');const{digest,...body}=saved;check(digest===fingerprint(body),'upgraded-verifier-journal-identity-mismatch');
  if(proof)check(saved.phase==='complete'&&same(saved.proof,proof)&&saved.proofSha256===fingerprint(proof)&&proof.canaryId===saved.appId,'upgraded-verifier-journal-incomplete');return saved;
}
function validateProof(journal,binding,saved,proof){
  check(proof?.format==='ink-os-upgraded-host-proof-v1'&&['passed','cleaned','cleanup-acknowledgement-pending'].includes(proof.status)&&Object.entries(proofBinding(binding)).every(([key,value])=>same(proof[key],value))&&hex(proof.bootId,32)&&hex(proof.canaryId,32)&&(!proof.releaseId||hex(proof.releaseId,32))&&Number.isFinite(Date.parse(proof.completedAt))&&proof.scope==='historical-current-generation-runtime-proof'&&proof.liveAudit==='not-performed','upgraded-proof-identity-mismatch');
  check(proof.canaryAppsRemaining===0&&proof.canaryWorkersRemaining===0&&proof.sourceAssetsRemaining===0&&proof.foreignMutationRequests===0&&proof.catalogIdsUnchanged===true&&Number.isSafeInteger(proof.initialCatalogCount)&&proof.initialCatalogCount>=0&&proof.initialCatalogCount<=1000&&hex(proof.initialCatalogSha256)&&proof.finalCatalogSha256===proof.initialCatalogSha256&&proof.initialCatalogCount===saved.initialCatalogIds?.length&&proof.initialCatalogSha256===fingerprint(saved.initialCatalogIds),'upgraded-proof-cleanup-incomplete');
  if(proof.status==='passed'){
    check(same(proof.observedImages,binding.images)&&proof.bootId===saved.bootId&&['backendVerified','edgeVerified','sourcePrivacyVerified','sourceDeletionAcknowledged'].every(key=>proof[key]===true)&&hex(proof.releaseId,32)&&hex(proof.bundleSha256)&&proof.bundleSha256===saved.bundleSha256&&proof.stateSha256===fingerprint({marker:saved.nonce,count:1,operation:saved.nonce})&&proof.edgeOriginSha256===sha('https://'+proof.releaseId+'-'+(journal.identity.appHostSuffix||'inkos')+'.'+journal.identity.appDomain)&&Number.isSafeInteger(proof.removedBlobs)&&proof.removedBlobs>=1,'upgraded-proof-acceptance-incomplete');
  }
  return proof;
}
async function receiptAt(root,journal,attempt){
  const path=await existingDirectory(join(await existingDirectory(join(root,'upgrade-verification')),attempt.id)),receipt=await readPrivateJSON(join(path,'receipt.json')),saved=await readPrivateJSON(join(path,'journal.json')),proof=await readPrivateJSON(join(path,'proof.json'));
  check(receipt.format==='ink-cloud-upgraded-verification-receipt-v1'&&same(receipt.binding,attempt.binding)&&receipt.proofHash===fingerprint(receipt.proof)&&receipt.verifierJournalHash===fingerprint(saved)&&receipt.receiptHash===fingerprint({binding:receipt.binding,proofHash:receipt.proofHash,verifierJournalHash:receipt.verifierJournalHash,recordedAt:receipt.recordedAt})&&attempt.receiptHash===fingerprint(receipt)&&same(receipt.proof,proof)&&Number.isFinite(Date.parse(receipt.recordedAt)),'invalid-upgraded-verification-receipt');
  validateVerifierJournal(attempt.binding,saved,proof);validateProof(journal,attempt.binding,saved,proof);return receipt;
}

/** Status reads historical local evidence; it performs no host/provider requests. */
export async function cloudUpgradeVerificationSummary({directory,journal,lineage}){
  const index=await optional(join(directory,indexName));if(!index)return null;validateIndex(journal,index);const attempt=index.attempt;
  const matches=lineage&&attempt.binding.generation===lineage.generation&&same(attempt.binding.images,lineage.images)&&attempt.binding.upgradeOperationId===lineage.lastOperation&&attempt.binding.upgradeReceiptSha256===lineage.receiptHash;
  let receipt;if(attempt.status==='complete')receipt=await receiptAt(directory,journal,attempt);
  if(!matches)return null;
  if(!receipt)return{status:'running',acceptance:'pending',canaryCleanup:'may-be-pending',liveAudit:'not-performed'};
  const proof=receipt.proof;return{status:proof.status,acceptance:proof.status==='passed'?'passed':'pending',pooledBackendCanary:proof.status==='passed'?'passed':'pending',edgeOrigins:proof.status==='passed'?'passed':'pending',sourcePrivacy:proof.status==='passed'?'passed':'pending',sourceCleanup:proof.sourceDeletionAcknowledged?'acknowledged':'acknowledgement-pending',installedCanaryApps:'zero-after-cleanup',receiptSha256:fingerprint(receipt),proofSha256:receipt.proofHash,verifierSourcesSha256:attempt.binding.sourcesHash,recordedAt:receipt.recordedAt,liveAudit:'not-performed'};
}

/** Current-generation acceptance uses the selected verifier export, never imported
 * caller proof JSON. It does not restart hosts or call provider/pool controls. */
export async function verifyCloudUpgrade({directory,config,artifacts,platformRoot,phase,fetch:transport=globalThis.fetch}={}){
  check(['run','cleanup'].includes(phase),'explicit-upgraded-verification-phase-required');const root=await privateDirectory(directory),unlock=await acquireCloudLock(root);
  try{
    await describeCloudProvisioning({directory:root,config,artifacts});await describeCloudUpgrade({directory:root,config,artifacts});const journal=await readPrivateJSON(join(root,'journal.json')),current=await readPrivateJSON(join(root,'current-images.json'));
    check(current.generation>=1&&current.lastOperation&&current.receiptHash,'upgraded-verification-current-generation-required');if(phase==='run')check(!current.activeOperation,'upgraded-verification-upgrade-in-progress');
    const selected=await selectedVerifier(platformRoot),wanted=currentBinding(journal,current,selected.sourceBinding);let index=await optional(join(root,indexName));validateIndex(journal,index);let attempt=index?.attempt;
    if(attempt?.status==='complete'&&same(attempt.binding,wanted)){const receipt=await receiptAt(root,journal,attempt);if(receipt.proof.status==='passed'||phase==='cleanup')return{status:receipt.proof.status,generation:current.generation,acceptance:await cloudUpgradeVerificationSummary({directory:root,journal,lineage:current}),historical:true};}
    if(attempt?.status==='running')check(same(attempt.binding,wanted)||phase==='cleanup'&&same(Object.fromEntries(Object.keys(selected.sourceBinding).map(key=>[key,attempt.binding[key]])),selected.sourceBinding),'upgraded-verification-inputs-changed-cleanup-required');
    else{
      check(phase==='run','upgraded-verification-active-attempt-required');const parent=await privateDirectory(join(root,'upgrade-verification')),id=randomBytes(16).toString('hex');await mkdir(join(parent,id),{mode:0o700});attempt={id,binding:wanted,status:'running',phase,startedAt:new Date().toISOString()};index={format:'ink-cloud-upgraded-verification-state-v1',originalBinding:originalBinding(journal),attempt};await writePrivateJSON(join(root,indexName),index);
    }
    const path=await existingDirectory(join(root,'upgrade-verification',attempt.id)),journalFile=join(path,'journal.json'),output=join(path,'proof.json'),saved=await optional(journalFile);if(saved)validateVerifierJournal(attempt.binding,saved);else check(phase==='run'&&attempt.phase==='run'&&!attempt.mutationAttempted,'upgraded-verification-journal-recovery-required');
    const secrets=await readPrivateJSON(join(root,'secrets.json'));check(secrets.format==='ink-cloud-secrets-v1'&&same(secrets.identity,journal.identity)&&secrets.configHash===journal.configHash&&secrets.artifactHash===journal.artifactHash&&typeof secrets.ownerToken==='string'&&secrets.ownerToken.length>=32&&!/[\r\n]/.test(secrets.ownerToken),'private-state-inputs-mismatch');
    const scopedFetch=async(input,init={})=>{const url=new URL(input),authorization=new Headers(init.headers).get('authorization');check(url.protocol==='https:'&&!url.username&&!url.password,'upgraded-verification-origin-refused');if(url.origin===journal.plan.origin)check(!authorization||authorization==='Bearer '+secrets.ownerToken,'upgraded-verification-credential-refused');else{const currentJournal=await readPrivateJSON(journalFile);check(hex(currentJournal.releaseId,32)&&url.origin==='https://'+currentJournal.releaseId+'-'+(journal.identity.appHostSuffix||'inkos')+'.'+journal.identity.appDomain&&!authorization,'upgraded-verification-origin-refused');}if(!['GET','HEAD'].includes(init.method||'GET')&&!attempt.mutationAttempted){attempt.mutationAttempted=true;await writePrivateJSON(join(root,indexName),index);}return transport(input,{...init,redirect:'manual'});};
    const proof=await selected.verify({url:journal.plan.origin,ownerToken:secrets.ownerToken,expectedInstanceId:journal.identity.id,currentImages:attempt.binding.images,generation:attempt.binding.generation,upgradeReceiptSha256:attempt.binding.upgradeReceiptSha256,journal:journalFile,output,phase,fetch:scopedFetch});check(same(proof,await readPrivateJSON(output)),'upgraded-verifier-output-mismatch');const completed=await readPrivateJSON(journalFile);validateVerifierJournal(attempt.binding,completed,proof);validateProof(journal,attempt.binding,completed,proof);
    const recordedAt=new Date().toISOString(),proofHash=fingerprint(proof),verifierJournalHash=fingerprint(completed),receipt={format:'ink-cloud-upgraded-verification-receipt-v1',binding:attempt.binding,proof,proofHash,verifierJournalHash,recordedAt,receiptHash:fingerprint({binding:attempt.binding,proofHash,verifierJournalHash,recordedAt})};await writePrivateJSON(join(path,'receipt.json'),receipt);Object.assign(attempt,{status:'complete',phase,receiptHash:fingerprint(receipt),completedAt:recordedAt});await writePrivateJSON(join(root,indexName),index);
    return{status:proof.status,generation:attempt.binding.generation,acceptance:await cloudUpgradeVerificationSummary({directory:root,journal,lineage:current})};
  }catch(error){if(error instanceof CloudSetupError)throw error;if(/^INK_UPGRADE_PROOF_[A-Z0-9_]+$/.test(error.code||''))throw new CloudSetupError('upgraded-verifier-'+error.code.toLowerCase().replaceAll('_','-'));throw new CloudSetupError('upgraded-verification-failed-resume-same-state');}
  finally{await unlock();}
}
