'use strict';
const cp=require('child_process'),fs=require('fs');
function newer(a,b){const x=a.split('.').map(BigInt),y=b.split('.').map(BigInt);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]>y[i];}return false;}
function check(before,after){
 const old=new Map(before.plugins.map(p=>[p.id,p]));
 for(const entry of after.plugins){const previous=old.get(entry.id);if(!previous)continue;
  if(entry.version!==previous.version&&!newer(entry.version,previous.version))throw Error(entry.id+': version must increase');
  if(entry.sha256!==previous.sha256&&entry.version===previous.version)throw Error(entry.id+': changed bundle needs a new version');
 }
}
module.exports={check};
if(require.main===module){
 try{
  const ref=process.argv[2];if(!ref||!/^[A-Za-z0-9_./-]+$/.test(ref))throw Error('Pass a valid base ref');
  const before=JSON.parse(cp.execFileSync('git',['show',ref+':index.json'],{encoding:'utf8'}));
  check(before,JSON.parse(fs.readFileSync('index.json','utf8')));
  const changed=cp.execFileSync('git',['diff','--name-only','--diff-filter=M',ref+'...HEAD','--','dist/*.vplugin'],{encoding:'utf8'}).trim();
  if(changed)throw Error('Published bundles must not be modified: '+changed);
  console.log('PASS published versions are immutable and version numbers do not go backwards');
 }catch(e){console.error(e.message);process.exitCode=1;}
}
