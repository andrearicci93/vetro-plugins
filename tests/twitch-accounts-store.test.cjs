'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const storage=require('../plugins/twitch/accounts/store.js');
function cookies(id='1',login='first',token='private-test-token'){
 return storage.names.map(name=>({name,value:name.startsWith('auth-token')?token:encodeURIComponent(JSON.stringify({id,login,version:'1'})),domain:'.twitch.tv',path:'/',secure:true,httpOnly:false,session:false,expires:2000000000,sameSite:'None',priority:'Medium'}));
}
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'twitch-accounts-store-'));return{root,dir:path.join(root,'twitch'),vault:path.join(root,'.twitch-accounts'),close(){fs.rmSync(root,{recursive:true,force:true})}}}
function profile(id='1',login='first',token){return{id,login,cookies:cookies(id,login,token),savedAt:1,state:'ready'}}
test('account vault encrypts credentials and metadata, restricts permissions and survives plugin folder replacement',()=>{
 const x=fixture();try{
  const store=storage.create(x.dir),value=store.load();assert.equal(fs.existsSync(x.vault),false);value.profiles.push(profile());store.save(value);
  const disk=fs.readFileSync(path.join(x.vault,'vault.json'),'utf8');assert.ok(!disk.includes('private-test-token'));assert.ok(!disk.includes('first'));assert.ok(!disk.includes('auth-token'));
  assert.equal(fs.statSync(x.vault).mode&0o777,0o700);assert.equal(fs.statSync(path.join(x.vault,'key')).mode&0o777,0o600);assert.equal(fs.statSync(path.join(x.vault,'vault.json')).mode&0o777,0o600);
  fs.mkdirSync(x.dir);fs.rmSync(x.dir,{recursive:true});fs.mkdirSync(x.dir);
  assert.deepEqual(storage.create(x.dir).load(),value);
 }finally{x.close()}
});
test('vault authentication rejects tampering, missing keys and insecure permissions without overwriting data',()=>{
 for(const mode of ['tamper','missing-key','permissions','directory-symlink','data-symlink']){
  const x=fixture();try{
   const store=storage.create(x.dir),value=store.load();value.profiles.push(profile());store.save(value);const file=path.join(x.vault,'vault.json'),key=path.join(x.vault,'key');
   if(mode==='tamper'){const envelope=JSON.parse(fs.readFileSync(file));envelope.tag=(envelope.tag[0]==='0'?'1':'0')+envelope.tag.slice(1);fs.writeFileSync(file,JSON.stringify(envelope));}
   if(mode==='missing-key')fs.unlinkSync(key);
   if(mode==='permissions')fs.chmodSync(key,0o644);
   if(mode==='directory-symlink'){fs.renameSync(x.vault,x.vault+'-original');fs.symlinkSync(x.vault+'-original',x.vault);}
   if(mode==='data-symlink'){fs.renameSync(file,file+'.original');fs.symlinkSync(file+'.original',file);}
   const before=fs.readFileSync(file);assert.throws(()=>storage.create(x.dir).load(),/securely/);assert.deepEqual(fs.readFileSync(file),before);
  }finally{x.close()}
 }
});
test('vault bounds account data and cookies and never accepts foreign cookies or identities',()=>{
 for(const change of [v=>v.profiles.push(...Array.from({length:9},(_,i)=>profile(String(i+1),'user'+i))),v=>v.profiles.push(profile(),profile()),v=>{const p=profile();p.cookies[0].domain='evil.test';v.profiles.push(p)},v=>{const p=profile();p.cookies[0].secure=false;v.profiles.push(p)},v=>{const p=profile();p.id='2';v.profiles.push(p)},v=>{const p=profile();p.cookies[0].value='x'.repeat(4097);v.profiles.push(p)},v=>{v.pending={kind:'arbitrary',previousCookies:[],targetId:null,startedAt:0}}]){
  const x=fixture();try{const store=storage.create(x.dir),value=store.load();change(value);assert.throws(()=>store.save(value));assert.equal(fs.existsSync(x.vault),false)}finally{x.close()}
 }
});
test('atomic vault failure leaves the last valid data and in-memory snapshot intact',()=>{
 const x=fixture();try{
  const store=storage.create(x.dir),value=store.load();value.profiles.push(profile());store.save(value);const before=fs.readFileSync(path.join(x.vault,'vault.json'));const rename=fs.renameSync;
  try{fs.renameSync=()=>{throw Error('Disk error')};const changed=store.read();changed.profiles=[];assert.throws(()=>store.save(changed),/securely/)}finally{fs.renameSync=rename}
  assert.equal(store.read().profiles.length,1);assert.deepEqual(fs.readFileSync(path.join(x.vault,'vault.json')),before);assert.equal(fs.readdirSync(x.vault).some(f=>f.startsWith('.write-')),false);
 }finally{x.close()}
});
test('pending rollback survives a fresh store instance and plaintext is never written',()=>{
 const x=fixture();try{const store=storage.create(x.dir),data=store.load();data.profiles.push(profile());data.pending={kind:'add',previousCookies:cookies(),targetId:null,startedAt:1};store.save(data);assert.deepEqual(storage.create(x.dir).load().pending,data.pending);assert.ok(!fs.readFileSync(path.join(x.vault,'vault.json'),'utf8').includes('private-test-token'))}finally{x.close()}
});

test('vault lock serializes plugin instances and stale process locks can be recovered',()=>{
 const x=fixture();try{
  const first=storage.create(x.dir),second=storage.create(x.dir);first.acquire();assert.throws(()=>second.acquire(),/still closing/);first.release();second.acquire();second.release();
  const lock=path.join(x.vault,'lock');fs.writeFileSync(lock,JSON.stringify({pid:2147483647,start:null,nonce:'a'.repeat(32)}),{mode:0o600});first.acquire();first.release();assert.equal(fs.existsSync(lock),false);
 }finally{x.close()}
});

test('deleting the local key during operation fails closed instead of writing an unrecoverable vault',()=>{
 const x=fixture();try{const store=storage.create(x.dir),data=store.load();data.profiles.push(profile());store.save(data);const file=path.join(x.vault,'vault.json'),before=fs.readFileSync(file);fs.unlinkSync(path.join(x.vault,'key'));assert.throws(()=>store.save(data));assert.deepEqual(fs.readFileSync(file),before)}finally{x.close()}
});
