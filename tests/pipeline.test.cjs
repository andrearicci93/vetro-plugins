'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),cp=require('child_process');
const build=require('../scripts/build.cjs'),catalog=require('../scripts/catalog.cjs'),changes=require('../scripts/check-changes.cjs');
const root=path.join(__dirname,'..'),manifest={id:'sample',apiVersion:1,name:'Sample',version:'1.0.0',description:'A fixture',author:'test',permissions:[]};
const source='module.exports=function(){return {start:function(){},stop:function(){}};};';
const validFiles={'index.js':source,'README.md':'# Sample'};
function fixture(code,ui){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shards-tests-'));fs.mkdirSync(path.join(dir,'plugins/sample'),{recursive:true});fs.writeFileSync(path.join(dir,'plugins/sample/manifest.json'),JSON.stringify(ui?{...manifest,ui:{label:'Test'}}:manifest));fs.writeFileSync(path.join(dir,'plugins/sample/index.js'),code||source);fs.writeFileSync(path.join(dir,'plugins/sample/README.md'),'# Sample');return dir;}
test('ES5 rejection, bundle checks, symlinks and stale generated files',()=>{
 assert.deepEqual(build.validate('sample',manifest,validFiles),[]);
 for(const code of ['const x=()=>1;','module.exports=class X {};','async function x() {}'])assert.ok(build.validate('sample',manifest,{...validFiles,'index.js':code}).some(e=>/ES5/.test(e)));
 const dir=fixture();build.build(dir,false);build.build(dir,true);
 fs.appendFileSync(path.join(dir,'dist/sample-1.0.0.vplugin'),' ');assert.throws(()=>build.build(dir,true),/Out of date/);
 fs.symlinkSync('/etc/hosts',path.join(dir,'plugins/sample/leak.txt'));assert.ok(build.pack(path.join(dir,'plugins/sample'),'sample').errors.some(e=>/symlink/.test(e)));
});
test('runtime catches factory/start/UI/stop errors and cleans up across restarts',()=>{
 const cases=[['module.exports=42;',false],['module.exports=function(){throw Error("factory");};',false],['module.exports=function(){return {start:function(){throw Error("start");}};};',false],['module.exports=function(){var t;return {start:function(){t=setInterval(function(){},1000);},stop:function(){clearInterval(t);}};};',true],['module.exports=function(){return {start:function(){setInterval(function(){},1000);}};};',false],[source,true],['module.exports=function(){return {route:function(){return false;}};};',false,true],['module.exports=function(){return {route:function(req,res){res.writeHead(200).write("<html>");res.end("ok</html>");}};};',true,true]];
 for(const [code,ok,ui] of cases){const dir=fixture(code,ui);const r=cp.spawnSync(process.execPath,[path.join(root,'scripts/test-runtime.cjs'),path.join(dir,'plugins')],{timeout:8000,encoding:'utf8'});assert.equal(r.status===0,ok,r.stderr);}
});
test('signature round trip and tampered/wrong-key/identity rejection',()=>{
 const dir=fixture();build.build(dir,false);const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048});const other=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 fs.writeFileSync(path.join(dir,'catalog-public.pem'),keys.publicKey.export({type:'spki',format:'pem'}));
 assert.throws(()=>catalog.sign(dir,path.join(dir,'bad'),other.privateKey.export({type:'pkcs8',format:'pem'})),/does not match/);
 const out=path.join(dir,'catalog');catalog.sign(dir,out,keys.privateKey.export({type:'pkcs8',format:'pem'}));catalog.verify(out);
 const ix=JSON.parse(fs.readFileSync(path.join(out,'index.json')));ix.plugins[0].signature='AAAA';fs.writeFileSync(path.join(out,'index.json'),JSON.stringify(ix));assert.throws(()=>catalog.verify(out),/invalid catalog signature/);
 catalog.sign(dir,out,keys.privateKey.export({type:'pkcs8',format:'pem'}));fs.appendFileSync(path.join(out,'dist/sample-1.0.0.vplugin'),' ');assert.throws(()=>catalog.verify(out),/checksum/);
 const current=JSON.parse(fs.readFileSync(path.join(dir,'index.json')));current.plugins[0].url='../outside';fs.writeFileSync(path.join(dir,'index.json'),JSON.stringify(current));assert.throws(()=>catalog.sign(dir,out,keys.privateKey.export({type:'pkcs8',format:'pem'})),/unexpected bundle URL/);
});
test('published changes require higher versions',()=>{
 const old={plugins:[{id:'sample',version:'1.2.0',sha256:'before'}]};
 assert.throws(()=>changes.check(old,{plugins:[{id:'sample',version:'1.2.0',sha256:'after'}]}),/new version/);
 assert.throws(()=>changes.check(old,{plugins:[{id:'sample',version:'1.1.9',sha256:'after'}]}),/increase/);
 changes.check(old,{plugins:[{id:'sample',version:'1.3.0',sha256:'after'}]});
});
