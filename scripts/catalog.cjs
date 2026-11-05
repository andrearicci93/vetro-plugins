'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
const signedText=(id,version,hash)=>'vetro-plugin\n'+id+'\n'+version+'\n'+hash;
function bundle(root,entry){
 if(!/^[a-z][a-z0-9-]{1,31}$/.test(entry.id)||!/^\d+\.\d+\.\d+$/.test(entry.version)||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Invalid catalog entry');
 const name=entry.id+'-'+entry.version+'.vplugin';
 if(entry.url!=='dist/'+name)throw Error(entry.id+': unexpected bundle URL');
 const file=path.join(root,'dist',name);if(fs.lstatSync(file).isSymbolicLink())throw Error('Symlink bundle refused');
 const raw=fs.readFileSync(file);if(sha(raw)!==entry.sha256)throw Error(entry.id+': bundle checksum mismatch');
 const manifest=JSON.parse(raw).manifest;if(!manifest||manifest.id!==entry.id||manifest.version!==entry.version)throw Error(entry.id+': manifest identity mismatch');
 return {name,raw};
}
function index(root){const d=JSON.parse(fs.readFileSync(path.join(root,'index.json'),'utf8'));if(d.format!=='vetro-plugin-index'||d.version!==1||!Array.isArray(d.plugins))throw Error('Invalid catalog');return d;}
function sign(root,out,privatePem){
 const key=crypto.createPrivateKey(privatePem),publicPem=crypto.createPublicKey(key).export({type:'spki',format:'pem'});
 const expected=crypto.createPublicKey(fs.readFileSync(path.join(root,'catalog-public.pem'))).export({type:'spki',format:'pem'});
 if(publicPem!==expected)throw Error('Signing key does not match the reviewed catalog public key');
 const d=index(root),files=d.plugins.map(e=>{const b=bundle(root,e);e.signature=crypto.sign('RSA-SHA256',Buffer.from(signedText(e.id,e.version,e.sha256)),key).toString('base64');return b;});
 fs.mkdirSync(path.join(out,'dist'),{recursive:true});
 for(const b of files)fs.writeFileSync(path.join(out,'dist',b.name),b.raw);
 fs.writeFileSync(path.join(out,'index.json'),JSON.stringify(d,null,2)+'\n');fs.writeFileSync(path.join(out,'catalog-public.pem'),publicPem);
 verify(out,expected);return d;
}
function verify(root,publicPem){
 const d=index(root),key=publicPem||fs.readFileSync(path.join(root,'catalog-public.pem'));
 for(const e of d.plugins){bundle(root,e);if(typeof e.signature!=='string'||!crypto.verify('RSA-SHA256',Buffer.from(signedText(e.id,e.version,e.sha256)),key,Buffer.from(e.signature,'base64')))throw Error(e.id+': invalid catalog signature');}
 return d;
}
module.exports={sign,verify,signedText};
if(require.main===module){try{
 const [command,root,out]=process.argv.slice(2);
 if(command==='sign'){if(!root||!out||!process.env.SHARDS_SIGNING_KEY)throw Error('Pass source/output folders and SHARDS_SIGNING_KEY');const d=sign(root,out,process.env.SHARDS_SIGNING_KEY);console.log('Signed and verified '+d.plugins.length+' catalog entries');}
 else if(command==='verify'&&root){verify(root);console.log('PASS catalog signatures and bundle checksums');}
 else throw Error('Usage: catalog.cjs sign <source> <output> | verify <catalog>');
}catch(e){console.error(e.message);process.exitCode=1;}}
