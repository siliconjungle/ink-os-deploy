import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,mkdir,writeFile,rm,realpath}from'node:fs/promises';import{tmpdir}from'node:os';import{join,dirname}from'node:path';import{verifierSources}from'../lib/verifier-sources.mjs';
test('selected verifier identity includes shared continuation and the bounded backup checksum client',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ink-verifier-sources-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const put=async(path,text)=>{await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),text);};
 await put('scripts/verify.mjs',"import {createClient} from '../sdk/src/server.js';\n");
 await put('sdk/src/server.js',"import{backups}from './backups.js';\nimport{continuation}from '../../shared/continuation.mjs';\n");
 await put('sdk/src/backups.js',"export async function backups(){return await import('node:crypto');}\n");await put('shared/continuation.mjs','export const continuation=1;\n');
 const before=await verifierSources(root,'scripts/verify.mjs');assert.equal(Object.keys(before.hashes).length,4);
 await put('shared/continuation.mjs','export const continuation=2;\n');const after=await verifierSources(root,'scripts/verify.mjs');assert.notEqual(after.hashes['shared/continuation.mjs'],before.hashes['shared/continuation.mjs']);assert.equal(after.hashes['sdk/src/server.js'],before.hashes['sdk/src/server.js']);
 await put('sdk/src/backups.js',"export async function backups(){return await import('node:fs');}\n");await assert.rejects(()=>verifierSources(root,'scripts/verify.mjs'),e=>e.code==='selected-verifier-import-closure-unsupported');
 await put('sdk/src/backups.js',"import '../../server/untracked.mjs';\n");await assert.rejects(()=>verifierSources(root,'scripts/verify.mjs'),e=>e.code==='selected-verifier-import-closure-unsupported');
});
