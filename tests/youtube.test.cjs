'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),net=require('net'),tls=require('tls'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),crypto=require('crypto'),zlib=require('zlib'),vm=require('vm');
const acorn=require('acorn');
const {Duplex,PassThrough}=require('stream');
const address=require('../plugins/youtube/address.js'),tile=require('../plugins/youtube/tile.js'),setup=require('../plugins/youtube/setup.js'),proxyLib=require('../plugins/youtube/proxy.js');
const inject=require('../plugins/youtube/inject.js'),client=require('../plugins/youtube/tls-client.js'),us=require('../plugins/youtube/userscript.js'),ytFactory=require('../plugins/youtube/index.js');
const ifaces={lo:[{address:'127.0.0.1',family:'IPv4',internal:true}],wlan0:[{address:'192.168.1.50',family:'IPv4',internal:false},{address:'fe80::1%wlan0',family:'IPv6',internal:false}]};

function shEnv(){
 if(process.platform!=='win32')return process.env;
 const extra=['C:\\Program Files\\Git\\usr\\bin','C:\\Program Files\\Git\\bin'].filter(d=>fs.existsSync(d));
 return extra.length?Object.assign({},process.env,{PATH:extra.join(path.delimiter)}):process.env;
}
function freePort(){return new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});}
function makeCerts(dir){
 const env=shEnv();
 fs.writeFileSync(path.join(dir,'ca.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Test CA\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n');
 fs.writeFileSync(path.join(dir,'leaf.ext'),'subjectAltName=DNS:www.youtube.com,DNS:youtube.com\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
 const run=args=>{const r=cp.spawnSync('openssl',args,{cwd:dir,env});if(r.status!==0)throw new Error(String(r.stderr||r.error));};
 run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-days','2','-sha256','-config','ca.cnf']);
 run(['req','-new','-newkey','rsa:2048','-nodes','-keyout','leaf.key','-subj','/CN=www.youtube.com','-out','leaf.csr']);
 run(['x509','-req','-in','leaf.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out','leaf.crt','-days','2','-sha256','-extfile','leaf.ext']);
 const ca=fs.readFileSync(path.join(dir,'ca.crt'));
 return {ca,leaf:{key:fs.readFileSync(path.join(dir,'leaf.key')),cert:fs.readFileSync(path.join(dir,'leaf.crt'),'utf8')+ca.toString('utf8')}};
}

test('the proxy only talks to the TV itself',()=>{
 for(const a of ['127.0.0.1','127.0.0.2','::1','::ffff:127.0.0.1','192.168.1.50','::ffff:192.168.1.50','fe80::1'])assert.equal(address.isLocal(a,ifaces),true,a);
 for(const a of ['192.168.1.51','10.0.0.5','::ffff:192.168.1.51','8.8.8.8','',undefined])assert.equal(address.isLocal(a,ifaces),false,String(a));
});
test('address pick and mode',()=>{
 assert.equal(address.lanAddress(ifaces),'192.168.1.50');
 assert.equal(address.lanAddress({lo:ifaces.lo,x:[{address:'169.254.3.4',family:'IPv4',internal:false}]}),null);
 assert.equal(address.tizenMajor('Tizen6/TV 6.0.0'),6);assert.equal(address.tizenMajor('Tizen 9.0.0'),9);assert.equal(address.tizenMajor(''),0);
 assert.equal(address.chooseMode(undefined,6),'loopback');assert.equal(address.chooseMode(undefined,9),'lan');assert.equal(address.chooseMode(undefined,0),'loopback');
 assert.equal(address.chooseMode('loopback',9),'loopback');assert.equal(address.chooseMode('lan',6),'lan');
});
test('Samsung row: a LAN address fits when short, says toolong when not',()=>{
 const stock='--base_url=https://www.youtube.com/tv --dial_name=YouTube --use_eden --start_frag=#start';
 assert.ok(tile.patched(stock,'127.0.0.2',8101).length<=tile.MAX_VALUE);
 assert.ok(tile.patched(stock,'192.168.1.123',8101).length<=tile.MAX_VALUE);
 assert.equal(tile.patched(stock,'192.168.100.123',8101),null);
 const v=tile.patched(stock,'192.168.1.123',8101);
 assert.ok(tile.isPatched(v));assert.equal(tile.original(v),stock);                       // undoes whatever address was written
 const rows=[];const exec=s=>{rows.push(s);return Promise.resolve({stdout:rows.length===1?stock+'\n':''});};
 return tile.apply(exec,'192.168.100.123',8101).then(state=>{assert.equal(state,'toolong');assert.equal(rows.length,1);});    // nothing written
});
test('proxy refuses peers that are not the TV and counts what arrives',()=>new Promise((resolve,reject)=>{
 const logs=[];let allowed=false;
 const port=40000+Math.floor(Math.random()*20000);
 const q=proxyLib.createProxy({host:'127.0.0.1',port,log:m=>logs.push(m),leaf:()=>null,script:()=>null,allow:()=>allowed});
 q.listen(err=>{
  if(err)return reject(err);
  const c1=net.connect(port,'127.0.0.1');c1.on('error',()=>{});c1.resume();
  c1.on('close',()=>{
   try{assert.equal(q.stats().foreign,1);assert.equal(q.stats().accepted,0);}catch(x){q.close(true);return reject(x);}
   allowed=true;
   const c2=net.connect(port,'127.0.0.1',()=>c2.write('GET http://x/ HTTP/1.1\r\n\r\n'));c2.on('error',()=>{});c2.resume();
   c2.on('close',()=>{
    try{assert.equal(q.stats().accepted,1);assert.ok(logs.some(l=>/first connection/.test(l)));assert.ok(logs.some(l=>/not a CONNECT/.test(l)));}catch(x){q.close(true);return reject(x);}
    q.close(true);resolve();
   });
  });
 });
}));
test('proxy relays plain requests to the TV web server on loopback only',()=>new Promise((resolve,reject)=>{
 const seen=[];const web=require('http').createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{seen.push({line:req.method+' '+req.url,conn:req.headers.connection,pconn:req.headers['proxy-connection'],body:b});res.writeHead(200,{'content-length':2});res.end('ok');});});
 web.listen(0,'127.0.0.1',()=>{
  const lp=web.address().port,port=40000+Math.floor(Math.random()*20000),logs=[];
  const q=proxyLib.createProxy({host:'127.0.0.1',port,log:m=>logs.push(m),leaf:()=>null,script:()=>null,localPort:lp});
  const done=(e)=>{q.close(true);web.close();e?reject(e):resolve();};
  const ask=(target,cb)=>{let out='';const c=net.connect(port,'127.0.0.1',()=>c.write('POST '+target+' HTTP/1.1\r\nHost: localhost\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive\r\nContent-Length: 5\r\n\r\nhello'));c.on('data',d=>out+=d);c.on('error',()=>{});c.on('close',()=>cb(out));};
  q.listen(err=>{
   if(err){web.close();return reject(err);}
   ask('http://localhost:'+lp+'/ws/apps/YouTube/dial_data',r1=>{
    try{
     assert.match(r1,/^HTTP\/1\.1 200 /);assert.equal(seen.length,1);
     assert.equal(seen[0].line,'POST /ws/apps/YouTube/dial_data');assert.equal(seen[0].body,'hello');
     assert.equal(String(seen[0].conn).toLowerCase(),'close');assert.equal(seen[0].pconn,undefined);
     assert.equal(q.stats().relayed,1);assert.ok(logs.some(l=>/relaying/.test(l)));
    }catch(x){return done(x);}
    ask('http://localhost:'+(lp+1)+'/x',r2=>{                                  // another port: refused
     ask('http://example.com:'+lp+'/x',r3=>{                                    // another host: refused
      ask('http://192.168.1.1:'+lp+'/x',r4=>{
       try{[r2,r3,r4].forEach(r=>assert.match(r,/^HTTP\/1\.1 502 /));assert.equal(seen.length,1);assert.equal(q.stats().relayed,1);}catch(x){return done(x);}
       done();
      });
     });
    });
   });
  });
 });
}));
test('Open path starts the app with the chosen proxy address',()=>{
 assert.match(setup.launchScript('192.168.1.50',8101),/--proxy=192\.168\.1\.50:8101,direct:\/\/ --content=\/opt\/usr\/home\/owner\/share\/vyt/);
});

const watchLib=require('../plugins/youtube/watch.js');
function cobaltLine(flags){return [watchLib.COBALT_BIN,'__AUL_STARTTIME__','x',Buffer.from(flags).toString('base64')].join('\0');}
// A fake /proc: procs maps pid -> cmdline text, or 'denied' (another app's process), or 'gone' (exits while being read).
function fakeProc(procs){
 const err=code=>Object.assign(new Error(code),{code});
 const fsMock={reads:0,
  readdirSync:()=>Object.keys(procs).concat(['self','stat']),
  readFileSync:f=>{fsMock.reads++;const v=procs[f.split('/')[2]];if(v==='denied')throw err('EACCES');if(v===undefined||v==='gone')throw err('ENOENT');return v;}};
 return fsMock;
}
test('watch: the app\'s command line says whether it carries our flags',()=>{
 assert.equal(watchLib.classify(cobaltLine(' --dial_name=YouTube --proxy=127.0.0.2:8101,direct:// --content=/opt/usr/home/owner/share/vyt')),'ok');
 assert.equal(watchLib.classify(cobaltLine(' --base_url=https://www.youtube.com/tv --dial_name=YouTube --use_eden')),'relaunch');
 assert.equal(watchLib.classify(cobaltLine(' --dial_name=Netflix')),null);
 assert.equal(watchLib.classify('/usr/bin/node\0service.js'),null);
 assert.equal(watchLib.classify(''),null);
});
test('watch: processes there at start, short-lived ones and ours never ask for a root check',()=>{
 const procs={'1':'/sbin/init','200':'denied'};const fsMock=fakeProc(procs);const g=new watchLib.Gate({fs:fsMock});
 assert.deepEqual(g.scan(),{verdict:null,check:false});assert.equal(fsMock.reads,0);            // first scan only takes note
 procs['300']='denied';assert.equal(g.scan().check,false);                                   // seen once
 delete procs['300'];assert.equal(g.scan().check,false);                                     // gone before the next scan
 procs['301']='/bin/sh\0-c\0pgrep';assert.equal(g.scan().check,false);                       // readable, not YouTube
 assert.equal(g.scan().check,false);assert.equal(g.scan().check,false);
});
test('watch: an unreadable process that stays asks for one root check, once',()=>{
 const procs={'1':'/sbin/init'};const fsMock=fakeProc(procs);const g=new watchLib.Gate({fs:fsMock});g.scan();
 procs['400']='denied';assert.equal(g.scan().check,false);
 assert.equal(g.scan().check,true);
 const reads=fsMock.reads;assert.equal(g.scan().check,false);assert.equal(g.scan().check,false);
 assert.equal(fsMock.reads,reads);                                                               // tried once in its life
});
test('watch: a readable YouTube without our flags is caught without root',()=>{
 const procs={'1':'/sbin/init'};const g=new watchLib.Gate({fs:fakeProc(procs)});g.scan();
 procs['500']=cobaltLine(' --base_url=https://www.youtube.com/tv --dial_name=YouTube');
 assert.deepEqual(g.scan(),{verdict:'relaunch',check:false});
 assert.deepEqual(g.scan(),{verdict:null,check:false});
 procs['501']=cobaltLine(' --dial_name=YouTube --content=/opt/usr/home/owner/share/vyt');
 assert.equal(g.scan().verdict,'ok');
});
test('watch: while the patched app runs new processes are only noted; reset starts over; no /proc means blind',()=>{
 const procs={'1':'/sbin/init'};const fsMock=fakeProc(procs);const g=new watchLib.Gate({fs:fsMock});g.scan();
 procs['600']='denied';g.scan(true);assert.equal(fsMock.reads,0);assert.equal(g.scan().check,false);
 g.reset();procs['601']='denied';assert.equal(g.scan().check,false);assert.equal(fsMock.reads,0);
 const b=new watchLib.Gate({fs:{readdirSync:()=>{throw Object.assign(new Error('EACCES'),{code:'EACCES'});}}});
 assert.equal(b.scan().blind,true);
});

// Runs the watch's timing for `minutes` of scans; events[t] (ms) changes the fake TV before that scan.
// fail(n): whether the n-th root check fails. Returns the times of the root checks and of the relaunches.
function simulate(procs,minutes,events,opts){
 opts=opts||{};const w=new watchLib.Watcher({fs:opts.fs||fakeProc(procs)}),checks=[],relaunches=[];
 for(let t=0;t<minutes*60000;t+=watchLib.SCAN_MS){
  if(events&&events[t])events[t]();
  const a=w.step(t,opts.quiet?opts.quiet(t):false,true);
  if(a.relaunch)relaunches.push(t);
  if(a.check){checks.push(t);if(opts.fail&&opts.fail(checks.length))w.failed();}
 }
 return {checks,relaunches,w};
}
test('watch timing: idle TV, 10 minutes, about one root check a minute',()=>{
 const procs={'1':'/sbin/init','2':'denied','3':'denied'};
 const r=simulate(procs,10,{
  // the root agent's own commands: unreadable, gone before the next scan
  9000:()=>{procs['700']='denied';},12000:()=>{delete procs['700'];},
  30000:()=>{procs['701']='/bin/sh';},33000:()=>{delete procs['701'];}
 });
 assert.equal(r.checks[0],0);                        // at start
 assert.equal(r.checks.length,10);                   // 0, 60, 120 ... 540 s
 assert.ok(r.checks.every((t,i)=>t===i*60000),String(r.checks));
});
test('watch timing: a process that is not ours and stays gets one prompt check',()=>{
 const procs={'1':'/sbin/init'};
 const r=simulate(procs,2,{21000:()=>{procs['800']='denied';}});
 assert.deepEqual(r.checks,[0,24000,84000]);         // seen at 21 s, still there at 24 s; then the backstop
});
test('watch timing: a readable unpatched YouTube is relaunched with no root check',()=>{
 const procs={'1':'/sbin/init'};
 const r=simulate(procs,1,{15000:()=>{procs['900']=cobaltLine(' --dial_name=YouTube');}});
 assert.deepEqual(r.relaunches,[15000]);assert.deepEqual(r.checks,[0]);
});
test('watch timing: a failed root check (no agent yet) is retried after 6 s, not after a minute',()=>{
 const r=simulate({'1':'/sbin/init'},1,null,{fail:n=>n<=3});
 assert.deepEqual(r.checks.slice(0,4),[0,6000,12000,18000]);
 assert.equal(r.checks.length,4);                   // then nothing until the backstop at 78 s
});
test('watch timing: none while the patched app is open, one when it closes; blind falls back to every 6 s',()=>{
 const open=t=>t>=30000&&t<150000;
 const r=simulate({'1':'/sbin/init'},3,null,{quiet:open});
 assert.deepEqual(r.checks,[0,150000]);
 const b=simulate({},10,null,{fs:{readdirSync:()=>{throw Object.assign(new Error('EACCES'),{code:'EACCES'});}}});
 assert.equal(b.w.blind,true);assert.equal(b.checks.length,100);
});

test('inject: isTvPage, unquoted/quoted CSP meta removal, case-insensitive last </body>, and no-store headers',()=>{
 for(const u of ['/tv','/tv/','/tv?launch=menu','/tv/?launch=menu','/tv#start','/tv/#start'])assert.equal(inject.isTvPage(u),true,u);
 for(const u of ['/tv_config?x=1','/tvx','/tv/watch','/',''])assert.equal(inject.isTvPage(u),false,u);
 const tag=inject.scriptTag('1.15.2');
 assert.equal(tag,'<script src="/vetro-youtube/userscript.js?v=1.15.2"></script>');
 const r1=inject.rewritePage('<html><meta http-equiv="Content-Security-Policy" content="default-src none"><body>hi</body></html>',tag);
 assert.equal(r1.injected,true);
 assert.equal(r1.html,'<html><body>hi'+tag+'</body></html>');
 const r2=inject.rewritePage('<html><meta http-equiv=Content-Security-Policy content="x"><META HTTP-EQUIV=Content-Security-Policy-Report-Only content="y"><BODY>hi<script>var s="</body>";</script></BODY ></html>',tag);
 assert.equal(r2.injected,true);
 assert.equal(r2.html,'<html><BODY>hi<script>var s="</body>";</script>'+tag+'</BODY ></html>');
 const r3=inject.rewritePage('<p>no body tag</p>',tag);
 assert.equal(r3.injected,false);assert.ok(r3.html.endsWith(tag));
 assert.equal(inject.rewritePage('<body>$&</body>',tag).html,'<body>$&'+tag+'</body>');
 const h=inject.pageHeaders({'content-security-policy':'default-src none','content-security-policy-report-only':'default-src none','content-length':'5','content-encoding':'gzip','alt-svc':'h3=":443"',etag:'"v1"','last-modified':'Wed, 21 Oct 2015 07:28:00 GMT',expires:'0','cache-control':'private, max-age=300',pragma:'no-cache',age:'12','x-frame-options':'SAMEORIGIN'},123);
 assert.deepEqual(Object.keys(h).sort(),['cache-control','content-length','content-security-policy','x-frame-options']);
 assert.equal(h['content-length'],123);
 assert.equal(h['cache-control'],'no-store, no-cache, must-revalidate');
 assert.equal(h['content-security-policy'],inject.CSP);
 assert.match(inject.CSP,/connect-src \* ws: wss: data: blob:/);
 assert.deepEqual(inject.passHeaders({'alt-svc':'h3','x-ok':'1'}),{'x-ok':'1'});
});

test('tls-client: noCache conditional header stripping, Dechunk framing, and parseHead normalization',()=>{
 const head=client.buildRequest({method:'GET',path:'/tv?launch=menu',identity:true,noCache:true,headers:{
  Host:'www.youtube.com','Accept-Encoding':'gzip, br',Connection:'keep-alive, x-hop','x-hop':'secret',
  'If-None-Match':'"etag1"','If-Modified-Since':'Wed, 21 Oct 2015 07:28:00 GMT','If-Match':'"etag1"',
  'If-Unmodified-Since':'Wed, 21 Oct 2015 07:28:00 GMT',Range:'bytes=0-99','X-Bad':'a\r\nEvil: 1',Cookie:['a=1','b=2']
 }},0);
 assert.match(head,/^GET \/tv\?launch=menu HTTP\/1\.1\r\n/);
 assert.match(head,/\r\naccept-encoding: identity\r\n/);
 assert.doesNotMatch(head,/if-none-match|if-modified-since|if-match|if-unmodified-since|range:|x-hop|Evil|gzip/i);
 assert.match(head,/cookie: a=1\r\ncookie: b=2\r\n/);
 const keepCache=client.buildRequest({method:'GET',path:'/y',headers:{Host:'www.youtube.com','If-None-Match':'"etag1"'}},0);
 assert.match(keepCache,/if-none-match: "etag1"/);

 const wire=Buffer.from('5\r\nhello\r\n6 ;ext=ok\r\n world\r\n0 \r\n\r\n');
 for(let cut=1;cut<wire.length;cut++){
  const out=new PassThrough(),got=[];out.on('data',c=>got.push(c));
  const d=new client.Dechunk(out);d.write(wire.slice(0,cut));d.write(wire.slice(cut));
  assert.equal(Buffer.concat(got).toString(),'hello world');assert.equal(d.complete(),true);
 }
 let badDelim=null;
 new client.Dechunk({writable:true,destroyed:false,write(){},end(){},abort(e){badDelim=e;}}).write(Buffer.from('1\r\nxNO'));
 assert.match(String(badDelim&&badDelim.message),/bad chunk delimiter/);
 let longHdr=null;
 new client.Dechunk({writable:true,destroyed:false,write(){},end(){},abort(e){longHdr=e;}}).write(Buffer.from('a'.repeat(1025)));
 assert.match(String(longHdr&&longHdr.message),/chunk header too long/);

 const p=client.parseHead('HTTP/1.1 200 OK\r\nContent-Type: text/html   \r\nContent-Length: 12\r\nContent-Length: 12\r\nSet-Cookie: a=1\r\nset-cookie: b=2');
 assert.equal(p.status,200);assert.equal(p.length,12);assert.equal(p.headers['content-length'],'12');
 assert.equal(p.headers['content-type'],'text/html');assert.deepEqual(p.headers['set-cookie'],['a=1','b=2']);
});

test('proxy + tls-client end-to-end: 304 conditional cache bypass, pipelined CONNECT prependSocket, gzip /tv, and retries',async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yt-proxy-e2e-'));
 t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const {ca,leaf}=makeCerts(tmp);
 const HTML='<html><head><meta http-equiv=Content-Security-Policy content="default-src none"></head><BODY>TV<script>var x="</body>";</script></BODY></html>';
 const seenHeads=[];let flakyGet=0,flakyPost=0;
 const upstream=tls.createServer(leaf,sock=>{
  sock.on('error',()=>{});
  let buf='';
  sock.on('data',d=>{
   buf+=d.toString('latin1');
   const idx=buf.indexOf('\r\n\r\n');if(idx<0)return;
   const head=buf.slice(0,idx),first=head.split('\r\n')[0],reqPath=first.split(' ')[1];
   seenHeads.push(head);
   const big='x-big: '+'x'.repeat(20000)+'\r\n';
   if(reqPath==='/tv?launch=menu'){
    // Simulate YouTube returning 304 Not Modified whenever conditional cache validators leak through!
    if(/if-none-match:|if-modified-since:|range:/i.test(head)){
     sock.end('HTTP/1.1 304 Not Modified\r\netag: "cached"\r\n\r\n');
     return;
    }
    sock.end('HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\netag: "cached"\r\nlast-modified: Wed, 21 Oct 2015 07:28:00 GMT\r\ncache-control: private, max-age=600\r\nalt-svc: h3=":443"\r\n'+big+'content-length: '+Buffer.byteLength(HTML)+'\r\n\r\n'+HTML);
   }else if(reqPath==='/tv/?gzip=1'){
    const gz=zlib.gzipSync(Buffer.from(HTML,'utf8'));
    sock.write('HTTP/1.1 200 OK\r\ncontent-type: Text/HTML; charset=utf-8\r\ncontent-encoding: gzip\r\ncontent-length: '+gz.length+'\r\n\r\n');
    sock.end(gz);
   }else if(reqPath==='/api/cached'){
    if(/if-none-match:/i.test(head))sock.end('HTTP/1.1 304 Not Modified\r\n\r\n');
    else sock.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
   }else if(reqPath==='/flaky-get'){
    if(++flakyGet===1){sock.destroy();return;}
    sock.end('HTTP/1.1 200 OK\r\ncontent-length: 9\r\n\r\nrecovered');
   }else if(reqPath==='/flaky-post'){
    ++flakyPost;sock.destroy();
   }else if(reqPath==='/cut'){
    sock.write('HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 400\r\n\r\n<html><body>partial');
    setTimeout(()=>sock.destroy(),20);
   }else{
    sock.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n');
   }
  });
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 t.after(()=>upstream.close());
 const upPort=upstream.address().port;

 const realTlsConnect=tls.connect,realNetConnect=net.connect;
 tls.connect=function(o){return realTlsConnect.call(tls,{host:'127.0.0.1',port:upPort,servername:o.servername,ca});};
 net.connect=function(p,h){
  const host=(typeof p==='object'&&p)?p.host:h;
  return host==='www.youtube.com'?realNetConnect.call(net,upPort,'127.0.0.1'):realNetConnect.apply(net,arguments);
 };
 t.after(()=>{tls.connect=realTlsConnect;net.connect=realNetConnect;});
 const appTls=o=>realTlsConnect.call(tls,o);

 // 1. GET retries once on pre-response socket drop; POST never retries; truncated stream emits error without end.
 const directGet=(p,extra)=>new Promise((res,rej)=>client.request(Object.assign({host:'www.youtube.com',method:'GET',path:p,headers:{host:'www.youtube.com'},timeout:2000},extra||{}),null,(e,r)=>{
  if(e)return rej(e);const parts=[];r.body.on('data',c=>parts.push(c));r.body.on('end',()=>res({status:r.status,body:Buffer.concat(parts).toString()}));r.body.on('error',rej);
 }));
 assert.equal((await directGet('/flaky-get')).body,'recovered');
 assert.equal(flakyGet,2);
 await assert.rejects(directGet('/flaky-post',{method:'POST'}),/closed before/);
 assert.equal(flakyPost,1);
 {
  let errSeen=false,endSeen=false;
  await new Promise(resolve=>client.request({host:'www.youtube.com',method:'GET',path:'/cut',headers:{host:'www.youtube.com'},timeout:2000},null,(e,rr)=>{
   assert.equal(e,null);
   rr.body.on('error',()=>{errSeen=true;setTimeout(resolve,30);});
   rr.body.on('end',()=>{endSeen=true;});
   rr.body.resume();
  }));
  assert.equal(errSeen,true);assert.equal(endSeen,false,'truncated stream must not emit end after error');
 }

 // 2. Proxy MITM: 304 bypass on /tv, non-/tv preserves 304, gzip /tv/ decompression, and pipelined CONNECT + ClientHello.
 const port=await freePort();
 let pages=0,leafNow=leaf;
 const scriptObj={body:Buffer.from('window.__tizentube=1;'),version:'1.15.2'};
 const proxy=proxyLib.createProxy({host:'127.0.0.1',port,log(){},leaf:()=>leafNow,script:()=>scriptObj,onPage:()=>{pages++;},maxConnections:40});
 await new Promise((res,rej)=>proxy.listen(e=>e?rej(e):res()));
 t.after(()=>proxy.close(true));

 const openConnect=target=>new Promise((resolve,reject)=>{
  const s=realNetConnect.call(net,port,'127.0.0.1',()=>s.write('CONNECT '+target+' HTTP/1.1\r\nHost: '+target+'\r\n\r\n'));
  s.once('data',d=>resolve({s,head:d.toString()}));s.on('error',reject);
 });
 const viaProxy=async rawReq=>{
  const c=await openConnect('www.youtube.com:443');
  assert.match(c.head,/^HTTP\/1\.1 200/);
  const ts=appTls({socket:c.s,servername:'www.youtube.com',ca});
  await new Promise((res,rej)=>{ts.on('secureConnect',res);ts.on('error',rej);});
  ts.write(rawReq);
  return await new Promise(res=>{const chunks=[];ts.on('data',d=>chunks.push(d));ts.on('end',()=>res(Buffer.concat(chunks).toString()));ts.on('close',()=>res(Buffer.concat(chunks).toString()));});
 };

 // Conditional headers on /tv are stripped so upstream answers 200 (not 304) and the userscript is injected.
 const tvReply=await viaProxy('GET /tv?launch=menu HTTP/1.1\r\nHost: www.youtube.com\r\nIf-None-Match: "cached"\r\nIf-Modified-Since: Wed, 21 Oct 2015 07:28:00 GMT\r\nRange: bytes=0-64\r\nConnection: close\r\n\r\n');
 assert.match(tvReply,/^HTTP\/1\.1 200 OK/);
 assert.ok(tvReply.includes('<script src="/vetro-youtube/userscript.js?v=1.15.2"></script></BODY>'));
 assert.ok(!/\betag:/i.test(tvReply));
 assert.match(tvReply,/cache-control: no-store, no-cache, must-revalidate/i);
 assert.equal(pages,1);

 // Non-/tv paths keep conditional headers so normal API/asset 304 caching still works.
 const apiReply=await viaProxy('GET /api/cached HTTP/1.1\r\nHost: www.youtube.com\r\nIf-None-Match: "v1"\r\nConnection: close\r\n\r\n');
 assert.match(apiReply,/^HTTP\/1\.1 304/);

 // Gzip-encoded /tv/ with mixed-case Content-Type is decompressed and rewritten.
 const gzReply=await viaProxy('GET /tv/?gzip=1 HTTP/1.1\r\nHost: www.youtube.com\r\nConnection: close\r\n\r\n');
 assert.match(gzReply,/^HTTP\/1\.1 200 OK/);
 assert.ok(gzReply.includes('<script src="/vetro-youtube/userscript.js?v=1.15.2"></script></BODY>'));
 assert.ok(!/content-encoding:/i.test(gzReply));
 assert.equal(pages,2);

 // Pipelined CONNECT + TLS ClientHello in the same TCP packet still gets MITM'd via prependSocket().
 const pipelinedReply=await new Promise((resolve,reject)=>{
  let headBuf=Buffer.alloc(0),sentConnect=false;
  const rawSock=realNetConnect.call(net,port,'127.0.0.1');
  const outChunks=[];
  const bridge=new Duplex({
   read(){},
   write(chunk,enc,cb){
    if(!sentConnect){
     sentConnect=true;
     rawSock.write(Buffer.concat([Buffer.from('CONNECT www.youtube.com:443 HTTP/1.1\r\nHost: www.youtube.com:443\r\n\r\n'),chunk]));
    }else rawSock.write(chunk);
    cb();
   }
  });
  const ts=appTls({servername:'www.youtube.com',ca,socket:bridge});
  rawSock.on('data',d=>{
   if(headBuf!==null){
    headBuf=Buffer.concat([headBuf,d]);
    const eoh=headBuf.indexOf('\r\n\r\n');if(eoh<0)return;
    const rest=headBuf.slice(eoh+4);headBuf=null;
    if(rest.length)bridge.push(rest);
    return;
   }
   bridge.push(d);
  });
  rawSock.on('end',()=>bridge.push(null));
  ts.on('secureConnect',()=>{
   ts.write('GET /tv?launch=menu HTTP/1.1\r\nHost: www.youtube.com\r\nIf-None-Match: "cached"\r\nConnection: close\r\n\r\n');
  });
  ts.on('data',d=>outChunks.push(d));
  ts.on('end',()=>{rawSock.destroy();resolve(Buffer.concat(outChunks).toString());});
  ts.on('error',e=>{rawSock.destroy();reject(e);});
 });
 assert.match(pipelinedReply,/^HTTP\/1\.1 200 OK/);
 assert.ok(pipelinedReply.includes('<script src="/vetro-youtube/userscript.js?v=1.15.2"></script></BODY>'),'pipelined CONNECT + ClientHello rewrites /tv');
 assert.equal(pages,3);

 // Pipelined CONNECT + TLS ClientHello with canWrapDuplex:false (Node < 12 fallback) tunnels cleanly without hanging.
 const fbPort=await freePort();
 const fbProxy=proxyLib.createProxy({host:'127.0.0.1',port:fbPort,log(){},leaf:()=>leaf,script:()=>scriptObj,canWrapDuplex:false});
 await new Promise((res,rej)=>fbProxy.listen(e=>e?rej(e):res()));
 t.after(()=>fbProxy.close(true));
 const capClientHello=()=>new Promise((resolve,reject)=>{
  const srv=net.createServer(s=>s.once('data',d=>{srv.close();s.destroy();resolve(d);}));
  srv.listen(0,'127.0.0.1',()=>{
   const c=realTlsConnect.call(tls,{host:'127.0.0.1',port:srv.address().port,servername:'www.youtube.com',rejectUnauthorized:false});
   c.on('error',()=>{});
  });
  srv.on('error',reject);
 });
 const clientHello=await capClientHello();
 const fbReply=await new Promise((resolve,reject)=>{
  const s=realNetConnect.call(net,fbPort,'127.0.0.1',()=>{
   s.write(Buffer.concat([Buffer.from('CONNECT www.youtube.com:443 HTTP/1.1\r\nHost: www.youtube.com:443\r\n\r\n'),clientHello]));
  });
  let acc=Buffer.alloc(0);
  const timer=setTimeout(()=>{s.destroy();reject(new Error('fallback pipelined CONNECT timed out'));},2000);
  s.on('data',d=>{
   acc=Buffer.concat([acc,d]);
   const eoh=acc.indexOf('\r\n\r\n');
   if(eoh>=0&&acc.length>=eoh+9){clearTimeout(timer);s.destroy();resolve(acc);}
  });
  s.on('error',e=>{clearTimeout(timer);reject(e);});
 });
 const fbEoh=fbReply.indexOf('\r\n\r\n');
 assert.match(fbReply.slice(0,fbEoh).toString(),/^HTTP\/1\.1 200/);
 assert.equal(fbReply[fbEoh+4],0x16,'ServerHello TLS handshake record');
 assert.equal(fbProxy.stats().tunnels,1);
 assert.equal(fbProxy.stats().opened,0);

 // Bad cert rotation falls back to last-good TLS server; tunnel counts as 1 live connection; invalid IPv6 returns 400.
 leafNow={key:Buffer.from('invalid'),cert:'invalid'};
 const scriptReply=await viaProxy('GET /vetro-youtube/userscript.js?v=1.15.2 HTTP/1.1\r\nHost: www.youtube.com\r\nConnection: close\r\n\r\n');
 assert.match(scriptReply,/^HTTP\/1\.1 200 OK[\s\S]*window\.__tizentube=1;$/);
 leafNow=leaf;

 for(let i=0;i<40&&proxy.stats().live>0;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(proxy.stats().live,0);
 const tun=await openConnect('127.0.0.1:'+upPort);
 assert.match(tun.head,/^HTTP\/1\.1 200/);
 assert.equal(proxy.stats().live,1,'plain tunnel counts as 1 live client connection, not 2');
 tun.s.destroy();

 const badIpv6=await openConnect('[::::]:443');
 assert.match(badIpv6.head,/^HTTP\/1\.1 400/);
 badIpv6.s.destroy();
});

test('userscript: SHA-256 verification, concurrent ensure() deduplication, and atomic tmp save',async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yt-us-'));
 t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const u=new us.UserScript(tmp);
 assert.equal(u.load(),null);
 fs.writeFileSync(path.join(tmp,'userscript-'+us.VERSION+'.js'),'tampered');
 assert.equal(u.load(),null,'tampered cached script is ignored');

 const origFetch=client.fetchBuffer;
 t.after(()=>{client.fetchBuffer=origFetch;});
 let calls=0;
 client.fetchBuffer=(host,urlPath,maxBytes,cb)=>{calls++;setTimeout(()=>cb(new Error('network down')),15);};
 const results=await Promise.all([new Promise(r=>u.ensure(e=>r(e))),new Promise(r=>u.ensure(e=>r(e)))]);
 assert.equal(calls,1,'concurrent ensure() shares one in-flight download');
 assert.equal(results.filter(Boolean).length,2);
});

test('setup: atomic CA/content/leaf setupScript and symlink removal',t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yt-setup-'));
 t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const posix=s=>s.split(path.sep).join('/');
 const D=posix(path.join(tmp,'vy')),C=posix(path.join(tmp,'vyt')),cobalt=posix(path.join(tmp,'cobalt')),bin=path.join(tmp,'bin');
 fs.mkdirSync(path.join(tmp,'cobalt','content','ssl','certs'),{recursive:true});
 fs.mkdirSync(path.join(tmp,'cobalt','lib'),{recursive:true});
 fs.mkdirSync(bin,{recursive:true});
 fs.writeFileSync(path.join(tmp,'cobalt','content','ssl','certs','root0.0'),'orig');
 fs.writeFileSync(path.join(tmp,'cobalt','lib','libcobalt.so'),'so');
 fs.writeFileSync(path.join(bin,'chown'),'#!/bin/sh\nexit 0\n');
 fs.chmodSync(path.join(bin,'chown'),0o755);

 const raw=setup.setupScript();
 assert.ok(raw.includes('[ -L "$D" ] && rm -f "$D"; mkdir -p "$D"'));
 assert.ok(raw.includes('mv ca.key.tmp ca.key; mv ca.crt.tmp ca.crt'));
 assert.ok(raw.includes('mv "$C.tmp" "$C"')&&raw.includes('mv content.stamp.tmp content.stamp'));
 assert.ok(raw.includes('mv leaf.key.tmp leaf.key; mv leaf.crt.tmp leaf.crt'));

 const rewritten=raw.split(setup.CONTENT).join(C).split(setup.DIR).join(D).split('/usr/apps/com.samsung.tv.cobalt/content/app/cobalt').join(cobalt);
 const env=shEnv();
 const runEnv=Object.assign({},env,{PATH:bin+path.delimiter+env.PATH});
 for(const s of [raw,setup.launchScript('192.168.1.50',8101),setup.checkScript(),setup.cleanupScript()]){
  assert.equal(cp.spawnSync('sh',['-n'],{input:s,env:runEnv}).status,0);
 }

 const r=cp.spawnSync('sh',[],{input:rewritten+'\n',env:runEnv,encoding:'utf8'});
 assert.match(r.stdout,/^ready$/m,r.stderr);
 for(const f of ['ca.key','ca.crt','leaf.key','leaf.crt','content.stamp'])assert.ok(fs.existsSync(path.join(tmp,'vy',f)),f);
 assert.ok(fs.readdirSync(path.join(tmp,'vyt','ssl','certs')).length>=2,'CA hash links added to copied trust store');
 const verify=cp.spawnSync('openssl',['verify','-CAfile',path.join(tmp,'vy','ca.crt'),path.join(tmp,'vy','leaf.crt')],{env:runEnv,encoding:'utf8'});
 assert.equal(verify.status,0,verify.stderr);

 // If symlinks are permitted on this host, verify planted symlinks are unlinked rather than followed.
 let canSymlink=true;
 try{fs.unlinkSync(path.join(tmp,'vy','leaf.key'));fs.symlinkSync(path.join(tmp,'vy','ca.key'),path.join(tmp,'vy','leaf.key'));}
 catch(e){if(process.platform==='win32'&&e&&e.code==='EPERM')canSymlink=false;else throw e;}
 if(canSymlink){
  const r2=cp.spawnSync('sh',[],{input:rewritten+'\n',env:runEnv,encoding:'utf8'});
  assert.match(r2.stdout,/^ready$/m,r2.stderr);
  assert.equal(fs.lstatSync(path.join(tmp,'vy','leaf.key')).isSymbolicLink(),false);
 }
});

test('Tizen 9 cobalt_launcher: watch.classify, launchScript yt_up(), and checkScript() backgroundAppStartup preload handling',t=>{
 const b64=s=>Buffer.from(s,'utf8').toString('base64');
 // 1. watch.classify(): shifted USERDATA, bare base64 __AUL_APPID__ (including binary AUL bundle framing), and ytkids/yttv exclusions.
 const shiftedUnpatched=[watchLib.COBALT_BIN,'__APP_SVC_OP_TYPE__','x','__AUL_APPID__',b64('com.samsung.tv.cobalt-yt'),'USERDATA',b64(' --dial_name=YouTube --use_eden')].join('\0');
 const shiftedPatched=[watchLib.COBALT_BIN,'__APP_SVC_OP_TYPE__','x','__AUL_APPID__',b64('com.samsung.tv.cobalt-yt'),'USERDATA',b64(' --dial_name=YouTube --proxy=192.168.1.10:8101,direct:// --content=/opt/usr/home/owner/share/vyt')].join('\0');
 const bareAppId=[watchLib.COBALT_BIN,'__AUL_APPID__',Buffer.from('\x01\x00com.samsung.tv.cobalt-yt\x00','binary').toString('base64')].join('\0');
 const kidsCmd=[watchLib.COBALT_BIN,'__AUL_APPID__',b64('com.samsung.tv.cobalt-ytkids'),'USERDATA',b64(' --dial_name=YouTubeKids')].join('\0');
 const tvCmd=[watchLib.COBALT_BIN,'__AUL_APPID__',b64('com.samsung.tv.cobalt-yttv'),'USERDATA',b64(' --dial_name=YouTubeTV')].join('\0');
 assert.equal(watchLib.classify(shiftedUnpatched),'relaunch');
 assert.equal(watchLib.classify(shiftedPatched),'ok');
 assert.equal(watchLib.classify(bareAppId),'relaunch');
 assert.equal(watchLib.classify(kidsCmd),null,'YouTube Kids must not match');
 assert.equal(watchLib.classify(tvCmd),null,'YouTube TV must not match');

 // 2. launchScript yt_unpatched(): shell subshell exclusion, Tizen 9 base64 detection, skips -t/-k when already patched with same proxy+content, kills on unpatched or stale proxy.
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yt-tizen9-'));
 t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const posix=s=>s.split(path.sep).join('/');
 const procBase=path.join(tmp,'cases'),binDir=path.join(tmp,'bin');
 fs.mkdirSync(procBase,{recursive:true});fs.mkdirSync(binDir,{recursive:true});
 const env=shEnv();
 const runEnv=Object.assign({},env,{PATH:binDir+path.delimiter+env.PATH});

 const launch=setup.launchScript('192.168.1.10',8101);
 assert.match(launch,/while \[ \$i -lt 15 \] && yt_unpatched/);
 assert.match(launch,/while \[ \$i -lt 5 \] && yt_unpatched/);
 const fnBody=launch.slice(0,launch.indexOf('\nyt_wait()'));
 const ytCases=[
  ['sh-wrap',['/bin/sh','-c','app_launcher -t com.samsung.tv.cobalt-yt -u 5001'],'sh','no'],
  ['bb-wrap',['busybox','sh','-c','com.samsung.tv.cobalt-yt'],'busybox','no'],
  ['shifted-unpatched',[watchLib.COBALT_BIN,'__APP_SVC_OP_TYPE__','x','__AUL_APPID__',b64('com.samsung.tv.cobalt-yt'),'USERDATA',b64(' --dial_name=YouTube')],'cobalt_launcher','yes'],
  ['shifted-patched',[watchLib.COBALT_BIN,'__APP_SVC_OP_TYPE__','x','__AUL_APPID__',b64('com.samsung.tv.cobalt-yt'),'USERDATA',b64(' --dial_name=YouTube --proxy=192.168.1.10:8101,direct:// --content=/opt/usr/home/owner/share/vyt')],'cobalt_launcher','no'],
  ['shifted-stale-proxy',[watchLib.COBALT_BIN,'__APP_SVC_OP_TYPE__','x','__AUL_APPID__',b64('com.samsung.tv.cobalt-yt'),'USERDATA',b64(' --dial_name=YouTube --proxy=192.168.1.99:8101,direct:// --content=/opt/usr/home/owner/share/vyt')],'cobalt_launcher','yes'],
  ['shifted-no-vyt',[watchLib.COBALT_BIN,'__APP_SVC_OP_TYPE__','x','__AUL_APPID__',b64('com.samsung.tv.cobalt-yt'),'USERDATA',b64(' --dial_name=YouTube --proxy=192.168.1.10:8101,direct://')],'cobalt_launcher','yes'],
  ['bare',[watchLib.COBALT_BIN,'__AUL_APPID__',b64('com.samsung.tv.cobalt-yt')],'cobalt_launcher','yes'],
  ['raw-unpatched',['/usr/apps/com.samsung.tv.cobalt/content/app/cobalt/cobalt','--app=com.samsung.tv.cobalt-yt'],'cobalt','yes'],
  ['raw-patched',['/usr/apps/com.samsung.tv.cobalt/content/app/cobalt/cobalt','--app=com.samsung.tv.cobalt-yt','--proxy=192.168.1.10:8101,direct://','--content=/opt/usr/home/owner/share/vyt'],'cobalt','no'],
  ['ytkids',[watchLib.COBALT_BIN,'__AUL_APPID__',b64('com.samsung.tv.cobalt-ytkids'),'USERDATA',b64(' --dial_name=YouTubeKids')],'cobalt_launcher','no'],
  ['yttv',[watchLib.COBALT_BIN,'__AUL_APPID__',b64('com.samsung.tv.cobalt-yttv')],'cobalt_launcher','no']
 ];
 const batchLines=[];
 ytCases.forEach((c,idx)=>{
  const dir=path.join(procBase,'c'+idx,'15319');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'cmdline'),Buffer.from(c[1].join('\0')+'\0'));
  if(c[2])fs.writeFileSync(path.join(dir,'comm'),c[2]+'\n');
  const fn=fnBody.replace('yt_unpatched()','yt_unpatched_'+idx+'()').split('/proc/[0-9]*/cmdline').join(posix(path.join(procBase,'c'+idx))+'/[0-9]*/cmdline');
  batchLines.push(fn,'if yt_unpatched_'+idx+'; then echo "'+c[0]+':yes"; else echo "'+c[0]+':no"; fi');
 });
 const batchOut=cp.spawnSync('sh',[],{input:batchLines.join('\n')+'\n',env:runEnv,encoding:'utf8'});
 assert.equal(batchOut.status,0,batchOut.stderr);
 assert.deepEqual(batchOut.stdout.trim().split(/\r?\n/),ytCases.map(c=>c[0]+':'+c[3]));

 // Cold-start and already-patched skips -t/-k; stuck unpatched process escalates -t -> -k -> -s.
 const procDir=path.join(tmp,'proc');
 fs.mkdirSync(path.join(procDir,'15319'),{recursive:true});
 fs.writeFileSync(path.join(procDir,'15319','cmdline'),Buffer.from([watchLib.COBALT_BIN,'__AUL_APPID__',b64('com.samsung.tv.cobalt-yt')].join('\0')+'\0'));
 fs.writeFileSync(path.join(procDir,'15319','comm'),'cobalt_launcher\n');
 const callsFile=posix(path.join(tmp,'app_calls'));
 fs.writeFileSync(path.join(binDir,'app_launcher'),'#!/bin/sh\necho "$*" >> "'+callsFile+'"\nif [ "$1" = "-k" ]; then rm -rf "'+posix(path.join(procDir,'15319'))+'"; fi\nif [ "$1" = "-s" ]; then echo "... successfully launched"; fi\n');
 fs.chmodSync(path.join(binDir,'app_launcher'),0o755);
 const rewrittenLaunch=launch.split('/proc/[0-9]*/cmdline').join(posix(procDir)+'/[0-9]*/cmdline')
  .replace(/yt_wait\(\) \{[^\n]+\}/,'yt_wait() { :; }')
  .replace('[ $i -lt 15 ]','[ $i -lt 2 ]').replace('[ $i -lt 5 ]','[ $i -lt 1 ]');

 const patchedProcSetup=[
  'mkdir -p "'+posix(path.join(procDir,'15320'))+'"',
  'printf "%s\\0%s\\0%s\\0%s\\0%s\\0" "'+watchLib.COBALT_BIN+'" "__AUL_APPID__" "'+b64('com.samsung.tv.cobalt-yt')+'" "USERDATA" "'+b64(' --dial_name=YouTube --proxy=192.168.1.10:8101,direct:// --content=/opt/usr/home/owner/share/vyt')+'" > "'+posix(path.join(procDir,'15320','cmdline'))+'"',
  'echo cobalt_launcher > "'+posix(path.join(procDir,'15320','comm'))+'"'
 ].join('\n');
 const warmColdOut=cp.spawnSync('sh',[],{input:rewrittenLaunch+'\necho "---SPLIT---" >> "'+callsFile+'"\n'+rewrittenLaunch+'\necho "---SPLIT---" >> "'+callsFile+'"\n'+patchedProcSetup+'\n'+rewrittenLaunch+'\n',env:runEnv,encoding:'utf8'});
 assert.equal(warmColdOut.status,0,warmColdOut.stderr);
 const [warmPart,coldPart,patchedPart]=fs.readFileSync(path.join(tmp,'app_calls'),'utf8').trim().split(/\r?\n---SPLIT---\r?\n/);
 const warmCalls=warmPart.trim().split(/\r?\n/),coldCalls=coldPart.trim().split(/\r?\n/),patchedCalls=patchedPart.trim().split(/\r?\n/);
 assert.equal(warmCalls.length,3,JSON.stringify(warmCalls));
 assert.match(warmCalls[0],/^-t com\.samsung\.tv\.cobalt-yt/);
 assert.match(warmCalls[1],/^-k com\.samsung\.tv\.cobalt-yt/);
 assert.match(warmCalls[2],/^-s com\.samsung\.tv\.cobalt-yt/);
 assert.equal(coldCalls.length,1,JSON.stringify(coldCalls));
 assert.match(coldCalls[0],/^-s com\.samsung\.tv\.cobalt-yt/);
 assert.equal(patchedCalls.length,1,'already-patched Cobalt skips -t/-k: '+JSON.stringify(patchedCalls));
 assert.match(patchedCalls[0],/^-s com\.samsung\.tv\.cobalt-yt/);

 // 3. checkScript(): Tizen 9 amd backgroundAppStartup preload returns "bg" when TV/another app is foreground, "relaunch" when YouTube is foreground, "ok" when patched.
 const chkDir=path.join(tmp,'chk');
 const writeProc=(sub,pid,tokens)=>{const d=path.join(chkDir,sub,pid);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'cmdline'),Buffer.from(tokens.join('\0')+'\0'));};
 writeProc('unpatched','2200',[watchLib.COBALT_BIN,'__AUL_APPID__',b64('com.samsung.tv.cobalt-yt')]);
 writeProc('patched','2201',[watchLib.COBALT_BIN,'__AUL_APPID__',b64('com.samsung.tv.cobalt-yt'),'USERDATA',b64(' --dial_name=YouTube --content=/opt/usr/home/owner/share/vyt')]);
 writeProc('kids','2202',[watchLib.COBALT_BIN,'__AUL_APPID__',b64('com.samsung.tv.cobalt-ytkids'),'USERDATA',b64(' --dial_name=YouTubeKids')]);

 fs.writeFileSync(path.join(binDir,'pgrep'),'#!/bin/sh\necho "$FAKE_PIDS"\n');
 fs.chmodSync(path.join(binDir,'pgrep'),0o755);
 fs.writeFileSync(path.join(binDir,'vconftool'),'#!/bin/sh\necho "memory/appfw/current_fullscreen_appid, value = $FAKE_FULL (string)"\n');
 fs.chmodSync(path.join(binDir,'vconftool'),0o755);

 const chkCases=[
  ['unpatched','2200','org.tizen.tv-viewer','bg'],
  ['unpatched','2200','com.samsung.tv.csfs','bg'],
  ['unpatched','2200','org.tizen.netflix-app','bg'],
  ['unpatched','2200','com.samsung.tv.cobalt-yt','relaunch'],
  ['unpatched','2200','9Ur5IzDKqV.TizenYouTube','relaunch'],
  ['unpatched','2200','','relaunch'],
  ['patched','2201','com.samsung.tv.cobalt-yt','ok'],
  ['kids','2202','com.samsung.tv.cobalt-ytkids','']
 ];
 const chkLines=['export FAKE_PIDS FAKE_FULL'];
 chkCases.forEach((c,i)=>{
  const body=setup.checkScript().split('/proc/$p/cmdline').join(posix(path.join(chkDir,c[0]))+'/$p/cmdline').replace(/echo \$R$/,'echo "'+i+':$R"');
  chkLines.push('FAKE_PIDS="'+c[1]+'"','FAKE_FULL="'+c[2]+'"',body);
 });
 const chkRes=cp.spawnSync('sh',[],{input:chkLines.join('\n')+'\n',env:runEnv,encoding:'utf8'});
 assert.equal(chkRes.status,0,chkRes.stderr);
 assert.deepEqual(chkRes.stdout.trim().split(/\r?\n/),chkCases.map((c,i)=>i+':'+c[3]));
});

test('Shard entry: sandboxed UI avoids confirm(), launch() matches manifest, and stop() restores row before closing proxy',async()=>{
 const calls=[];
 const port=await freePort();
 const inst=ytFactory({
  config:{get:()=>({tile:false,port}),set:()=>{}},
  execute:cmd=>{calls.push(cmd);return Promise.resolve({exit_code:0,stdout:'ready\n... successfully launched\n',stderr:''});}
 });
 let html='';
 assert.equal(inst.route({method:'GET'},{writeHead(){},end(b){html=b;}},'ui'),true);
 assert.doesNotMatch(html,/\bconfirm\(/,'sandboxed iframe UI must not call window.confirm');
 assert.match(html,/document\.hidden/);

 const origFetch=client.fetchBuffer,origListen=net.Server.prototype.listen;
 client.fetchBuffer=(h,p,m,cb)=>cb(new Error('offline'));
 // macOS does not bind 127.0.0.2 by default; map 127.0.0.2 to 127.0.0.1 in the test host.
 net.Server.prototype.listen=function(...args){
  if(args[1]==='127.0.0.2')args[1]='127.0.0.1';
  return origListen.apply(this,args);
 };
 try{
  assert.equal(await inst.launch('org.tizen.netflix-app'),false);
  assert.equal(await inst.launch('9Ur5IzDKqV.TizenYouTube'),false);
  assert.equal(await inst.launch('com.samsung.tv.cobalt-yt'),true);
  assert.equal(inst.status().proxy,true);

  const port2=await freePort();
  let releaseStop,proxyAtRestore=null;
  const stopGate=new Promise(r=>{releaseStop=r;});
  const inst2=ytFactory({
   config:{get:()=>({tile:false,port:port2}),set:()=>{}},
   execute:cmd=>{
    const text=Buffer.from(cmd.split(' ')[1],'base64').toString('utf8');
    if(/sqlite3/.test(text)){
     proxyAtRestore=inst2.status().proxy;
     return stopGate.then(()=>({exit_code:0,stdout:'',stderr:''}));
    }
    return Promise.resolve({exit_code:0,stdout:'ready\n... successfully launched\n',stderr:''});
   }
  });
  await inst2.launch('com.samsung.tv.cobalt-yt');
  const stopping=inst2.stop();
  await new Promise(r=>setTimeout(r,20));
  assert.equal(inst2.status().proxy,true,'proxy stays up while tile row is being restored');
  releaseStop();
  await stopping;
  assert.equal(proxyAtRestore,true);
  assert.equal(inst2.status().proxy,false);

  await inst.stop();
  assert.equal(inst.status().proxy,false);
 }finally{
  client.fetchBuffer=origFetch;
  net.Server.prototype.listen=origListen;
 }
});

test('openYoutube(): coalesces concurrent launches, applies 3500 ms cooldown, and resets on close/cleanup/stop',async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yt-open-cd-'));
 t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const origDir=setup.DIR,origContent=setup.CONTENT,origCache=setup.CACHE;
 const origFetch=client.fetchBuffer,origListen=net.Server.prototype.listen;
 setup.DIR=path.join(tmp,'vy');setup.CONTENT=path.join(tmp,'vyt');setup.CACHE=path.join(tmp,'vy','cache');
 fs.mkdirSync(path.join(setup.CONTENT,'ssl','certs'),{recursive:true});
 fs.mkdirSync(setup.DIR,{recursive:true});
 const {leaf}=makeCerts(setup.DIR);
 fs.writeFileSync(path.join(setup.DIR,'ca.crt'),fs.readFileSync(path.join(setup.DIR,'ca.crt')));
 client.fetchBuffer=(h,p,m,cb)=>cb(new Error('offline'));
 net.Server.prototype.listen=function(...args){
  if(args[1]==='127.0.0.2')args[1]='127.0.0.1';
  return origListen.apply(this,args);
 };
 t.after(()=>{
  setup.DIR=origDir;setup.CONTENT=origContent;setup.CACHE=origCache;
  client.fetchBuffer=origFetch;net.Server.prototype.listen=origListen;
 });

 const port=await freePort();
 let launchExecs=0,releaseFirst=null,failNextLaunch=false;
 const firstGate=new Promise(r=>{releaseFirst=r;});
 const inst=ytFactory({
  config:{get:()=>({tile:false,port}),set:()=>{}},
  execute:cmd=>{
   const text=Buffer.from(cmd.split(' ')[1],'base64').toString('utf8');
   if(/app_launcher -s/.test(text)){
    launchExecs++;
    if(failNextLaunch)return Promise.resolve({exit_code:0,stdout:'failed to launch',stderr:''});
    if(launchExecs===1)return firstGate.then(()=>({exit_code:0,stdout:'... successfully launched\n',stderr:''}));
    return Promise.resolve({exit_code:0,stdout:'... successfully launched\n',stderr:''});
   }
   return Promise.resolve({exit_code:0,stdout:'ready\n',stderr:''});
  }
 });
 t.after(()=>inst.stop());

 const postRoute=(sub,body)=>new Promise(resolve=>{
  const req=Object.assign(new PassThrough(),{method:'POST',url:'/'+sub});
  const res={writeHead(){},end(b){resolve(JSON.parse(b));}};
  assert.equal(inst.route(req,res,sub),true);
  if(body!==undefined)req.end(JSON.stringify(body));else req.end();
 });

 // 1. Concurrent openYoutube() calls coalesce behind one in-flight promise.
 const p1=postRoute('open');
 const p2=inst.launch('com.samsung.tv.cobalt-yt');
 await new Promise(r=>setTimeout(r,25));
 assert.equal(launchExecs,1,'concurrent openYoutube calls share one launchScript execution');
 releaseFirst();
 const [r1,r2]=await Promise.all([p1,p2]);
 assert.equal(r1.ok,true);
 assert.match(String(r1.warning),/could not be downloaded/);
 assert.equal(r2,true);

 // 2. Sequential openYoutube() within 3500 ms resolves with cached warning without spawning launchScript.
 const r3=await postRoute('open');
 assert.equal(r3.ok,true);
 assert.equal(r3.warning,r1.warning);
 assert.equal(launchExecs,1,'cooldown skips duplicate launchScript within 3500 ms');

 // 3. close route resets lastOpenAt so next openYoutube() launches again.
 const rc=await postRoute('close');
 assert.equal(rc.ok,true);
 const r4=await postRoute('open');
 assert.equal(r4.ok,true);
 assert.equal(launchExecs,2);

 // 4. cleanup route resets lastOpenAt.
 const rclean=await postRoute('cleanup');
 assert.equal(rclean.ok,true);
 fs.mkdirSync(path.join(setup.CONTENT,'ssl','certs'),{recursive:true});
 const r5=await postRoute('open');
 assert.equal(r5.ok,true);
 assert.equal(launchExecs,3);

 // 5. stop() resets lastOpenAt; failed openYoutube() does not arm cooldown.
 await inst.stop();
 const r6=await postRoute('open');
 assert.equal(r6.ok,true,r6.error);
 assert.equal(launchExecs,4);
 await postRoute('close');
 failNextLaunch=true;
 const rFail=await postRoute('open');
 assert.equal(rFail.ok,false);
 assert.equal(launchExecs,5);
 failNextLaunch=false;
 const rRetry=await postRoute('open');
 assert.equal(rRetry.ok,true,rRetry.error);
 assert.equal(launchExecs,6);
});

test('inject: preludeTag, <head> injection, fallback without <head>, and strict ES5 PRELUDE_BODY',()=>{
 assert.equal(inject.PRELUDE_PATH,'/vetro-youtube/prelude.js');
 const pTag=inject.preludeTag('1.15.2');
 const sTag=inject.scriptTag('1.15.2');
 assert.equal(pTag,'<script src="/vetro-youtube/prelude.js?v=1.15.2"></script>');

 // Valid ES5 in PRELUDE_BODY.
 assert.equal(typeof inject.PRELUDE_BODY,'string');
 assert.doesNotThrow(()=>acorn.parse(inject.PRELUDE_BODY,{ecmaVersion:5}));
 assert.doesNotMatch(inject.PRELUDE_BODY,/\beval\s*\(|\bnew\s+Function\b/);

 // Injects prelude immediately after <head> (or <head ...>), ignoring <header>, keeping userscript before </body>.
 const h1=inject.rewritePage('<html><head><script>early();</script></head><body>hi</body></html>',sTag,pTag);
 assert.equal(h1.injected,true);
 assert.equal(h1.html,'<html><head>'+pTag+'<script>early();</script></head><body>hi'+sTag+'</body></html>');

 const h2=inject.rewritePage('<html><HEAD lang="en"><meta http-equiv="Content-Security-Policy" content="x"></HEAD><body>hi</body></html>',sTag,pTag);
 assert.equal(h2.html,'<html><HEAD lang="en">'+pTag+'</HEAD><body>hi'+sTag+'</body></html>');

 // <header> must not match <head>; without <head>, preludeTag falls back right before sTag.
 const h3=inject.rewritePage('<html><header>nav</header><body>hi</body></html>',sTag,pTag);
 assert.equal(h3.injected,true);
 assert.equal(h3.html,'<html><header>nav</header><body>hi'+pTag+sTag+'</body></html>');

 const h4=inject.rewritePage('<p>plain</p>',sTag,pTag);
 assert.equal(h4.injected,false);
 assert.equal(h4.html,'<p>plain</p>'+pTag+sTag);
});

test('PRELUDE_BODY: Response.prototype.json, fetch fallback, XHR json, composable JSON.parse hook, and ad sanitization',async()=>{
 function makeSandbox(opts){
  opts=opts||{};
  const storage=new Map(opts.storage||[]);
  function FakeResponse(bodyText){this._body=bodyText;}
  FakeResponse.prototype.text=function(){return Promise.resolve(this._body);};
  FakeResponse.prototype.json=function(){return Promise.resolve({bypassedNative:true});};
  if(opts.lockResponseJson){
   Object.defineProperty(FakeResponse.prototype,'json',{value:FakeResponse.prototype.json,writable:false,configurable:false});
  }
  function FakeXHR(){this._rt='';this.readyState=4;this._raw='';}
  let rtStore=new WeakMap(),rawStore=new WeakMap();
  Object.defineProperty(FakeXHR.prototype,'responseType',{
   configurable:true,enumerable:true,
   get(){return rtStore.get(this)||'';},
   set(v){rtStore.set(this,v);}
  });
  Object.defineProperty(FakeXHR.prototype,'response',{
   configurable:true,enumerable:true,
   get(){
    if((rtStore.get(this)||'')==='json')return {bypassedNativeXhr:true};
    return rawStore.get(this)||'';
   }
  });
  FakeXHR.prototype.open=function(){};
  FakeXHR.prototype.send=function(body){rawStore.set(this,body);};

  const sandbox={
   JSON:{parse:JSON.parse,stringify:JSON.stringify},
   localStorage:{getItem:k=>storage.has(k)?storage.get(k):null},
   Response:FakeResponse,
   XMLHttpRequest:FakeXHR,
   fetch:()=>Promise.resolve(new FakeResponse(opts.fetchBody||'{"ok":true}')),
   Object,Array,Promise,Error,TypeError,SyntaxError,String
  };
  sandbox.window=sandbox;
  vm.createContext(sandbox);
  vm.runInContext(inject.PRELUDE_BODY,sandbox);
  return sandbox;
 }

 // 1. Response.prototype.json routes through JSON.parse, strips XSSI prefix, and removes player & feed ads.
 const s1=makeSandbox();
 const adPayload={
  adPlacements:[{a:1}],adSlots:[{b:2}],playerAds:[{c:3}],adBreakHeartbeatParams:{d:4},
  playerResponse:{adPlacements:[{x:1}],adSlots:[{y:2}],playerAds:true,adBreakHeartbeatParams:{z:3},videoDetails:{id:'v1'}},
  contents:{
   sectionListRenderer:{contents:[{adSlotRenderer:{id:'a1'}},{promotedSparklesWebRenderer:{id:'p1'}},{shelfRenderer:{content:{horizontalListRenderer:{items:[{adSlotRenderer:{id:'a2'}},{gridVideoRenderer:{id:'ok1'}}]},gridRenderer:{items:[{command:{reelWatchEndpoint:{adClientParams:{isAd:true}}}},{gridVideoRenderer:{id:'ok2'}}]}}}}]},
   gridRenderer:{items:[{adSlotRenderer:{id:'g1'}},{gridVideoRenderer:{id:'ok3'}}]}
  },
  continuationContents:{
   sectionListContinuation:{contents:[{adSlotRenderer:{id:'sc1'}},{itemSectionRenderer:{id:'ok4'}}]},
   horizontalListContinuation:{items:[{promotedSparklesWebRenderer:{id:'hc1'}},{gridVideoRenderer:{id:'ok5'}}]},
   gridContinuation:{items:[{command:{reelWatchEndpoint:{adClientParams:{isAd:true}}}},{gridVideoRenderer:{id:'ok6'}}]}
  },
  onResponseReceivedActions:[
   {reloadContinuationItemsCommand:{continuationItems:[{adSlotRenderer:{id:'r1'}},{videoRenderer:{id:'ok7'}}]}},
   {appendContinuationItemsAction:{continuationItems:[{promotedSparklesWebRenderer:{id:'ap1'}},{videoRenderer:{id:'ok8'}}]}}
  ],
  onResponseReceivedEndpoints:[{appendContinuationItemsAction:{continuationItems:[{adSlotRenderer:{id:'e1'}},{videoRenderer:{id:'ok9'}}]}}],
  onResponseReceivedCommands:[{reloadContinuationItemsCommand:{continuationItems:[{adSlotRenderer:{id:'c1'}},{videoRenderer:{id:'ok10'}}]}}],
  entries:[{command:{reelWatchEndpoint:{adClientParams:{isAd:true}}}},{command:{reelWatchEndpoint:{videoId:'reel1'}}}]
 };
 const plain=v=>JSON.parse(JSON.stringify(v));
 const parsed1=plain(await new s1.Response(")]}'\n"+JSON.stringify(adPayload)).json());
 assert.deepEqual(parsed1.adPlacements,[]);
 assert.deepEqual(parsed1.adSlots,[]);
 assert.equal(parsed1.playerAds,false);
 assert.equal('adBreakHeartbeatParams' in parsed1,false);
 assert.deepEqual(parsed1.playerResponse.adPlacements,[]);
 assert.deepEqual(parsed1.playerResponse.adSlots,[]);
 assert.equal(parsed1.playerResponse.playerAds,false);
 assert.equal('adBreakHeartbeatParams' in parsed1.playerResponse,false);
 assert.equal(parsed1.playerResponse.videoDetails.id,'v1');
 assert.equal(parsed1.contents.sectionListRenderer.contents.length,1);
 assert.deepEqual(parsed1.contents.sectionListRenderer.contents[0].shelfRenderer.content.horizontalListRenderer.items,[{gridVideoRenderer:{id:'ok1'}}]);
 assert.deepEqual(parsed1.contents.sectionListRenderer.contents[0].shelfRenderer.content.gridRenderer.items,[{gridVideoRenderer:{id:'ok2'}}]);
 assert.deepEqual(parsed1.contents.gridRenderer.items,[{gridVideoRenderer:{id:'ok3'}}]);
 assert.deepEqual(parsed1.continuationContents.sectionListContinuation.contents,[{itemSectionRenderer:{id:'ok4'}}]);
 assert.deepEqual(parsed1.continuationContents.horizontalListContinuation.items,[{gridVideoRenderer:{id:'ok5'}}]);
 assert.deepEqual(parsed1.continuationContents.gridContinuation.items,[{gridVideoRenderer:{id:'ok6'}}]);
 assert.deepEqual(parsed1.onResponseReceivedActions[0].reloadContinuationItemsCommand.continuationItems,[{videoRenderer:{id:'ok7'}}]);
 assert.deepEqual(parsed1.onResponseReceivedActions[1].appendContinuationItemsAction.continuationItems,[{videoRenderer:{id:'ok8'}}]);
 assert.deepEqual(parsed1.onResponseReceivedEndpoints[0].appendContinuationItemsAction.continuationItems,[{videoRenderer:{id:'ok9'}}]);
 assert.deepEqual(parsed1.onResponseReceivedCommands[0].reloadContinuationItemsCommand.continuationItems,[{videoRenderer:{id:'ok10'}}]);
 assert.equal(parsed1.entries.length,1);
 assert.equal(parsed1.entries[0].command.reelWatchEndpoint.videoId,'reel1');

 // Array of responses (including nested e.playerResponse).
 const arrRes=plain(s1.JSON.parse(JSON.stringify([{adPlacements:[1],adBreakHeartbeatParams:{},playerResponse:{adSlots:[2],playerAds:true,adBreakHeartbeatParams:{}}}])));
 assert.deepEqual(arrRes[0].adPlacements,[]);
 assert.equal('adBreakHeartbeatParams' in arrRes[0],false);
 assert.deepEqual(arrRes[0].playerResponse.adSlots,[]);
 assert.equal(arrRes[0].playerResponse.playerAds,false);
 assert.equal('adBreakHeartbeatParams' in arrRes[0].playerResponse,false);

 // 2. Composable JSON.parse hook after TizenTube hooks JSON.parse + re-entrancy & SyntaxError safety.
 vm.runInContext('var origTT = JSON.parse; JSON.parse = function(t, r) { var cfg = origTT(localStorage.getItem("ytaf-configuration") || "{}"); var o = origTT(t, r); if (o && typeof o === "object") o.ttProcessed = true; return o; };',s1);
 const parsedAfterTT=plain(await new s1.Response(JSON.stringify({adPlacements:[9],contents:{sectionListContinuation:{contents:[{adSlotRenderer:{}},{ok:1}]}}})).json());
 assert.equal(parsedAfterTT.ttProcessed,true);
 assert.deepEqual(parsedAfterTT.adPlacements,[]);
 assert.deepEqual(parsedAfterTT.contents.sectionListContinuation.contents,[{ok:1}]);
 assert.throws(()=>s1.JSON.parse('{bad'),{name:'SyntaxError'});
 assert.deepEqual(plain(s1.JSON.parse('{"adPlacements":[1]}')).adPlacements,[]);

 // 3. Respects enableAdBlock === false in ytaf-configuration.
 const sOff=makeSandbox({storage:[['ytaf-configuration',JSON.stringify({enableAdBlock:false})]]});
 const offRes=plain(sOff.JSON.parse(JSON.stringify({adPlacements:[123],playerAds:true})));
 assert.deepEqual(offRes.adPlacements,[123]);
 assert.equal(offRes.playerAds,true);

 // 4. Fallback wraps window.fetch when Response.prototype.json is non-writable & non-configurable.
 const sLocked=makeSandbox({lockResponseJson:true,fetchBody:")]}'\n"+JSON.stringify({adPlacements:[1],playerAds:true})});
 const lockedResp=await sLocked.fetch('/youtubei/v1/player');
 const lockedJson=plain(await lockedResp.json());
 assert.deepEqual(lockedJson.adPlacements,[]);
 assert.equal(lockedJson.playerAds,false);

 // 5. XHR responseType='json' routes through window.JSON.parse.
 const xhr=new s1.XMLHttpRequest();
 xhr.open('POST','/youtubei/v1/browse');
 xhr.responseType='json';
 assert.equal(xhr.responseType,'json');
 xhr.send(")]}'\n"+JSON.stringify({adSlots:[1],entries:[{adSlotRenderer:{}},{id:'keep'}]}));
 const xhrResp=plain(xhr.response);
 assert.deepEqual(xhrResp.adSlots,[]);
 assert.deepEqual(xhrResp.entries,[{id:'keep'}]);
});

test('proxy: serves /vetro-youtube/prelude.js, injects preludeTag in /tv, sets requestTimeout=0, and suppresses idle ERR_HTTP_REQUEST_TIMEOUT logs',async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yt-prelude-proxy-'));
 t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const {ca,leaf}=makeCerts(tmp);
 const HTML='<html><head lang="en"><script>boot();</script></head><BODY>TV</BODY></html>';
 const upstream=tls.createServer(leaf,sock=>{
  sock.on('error',()=>{});
  let buf='';
  sock.on('data',d=>{
   buf+=d.toString('latin1');
   const idx=buf.indexOf('\r\n\r\n');if(idx<0)return;
   const path0=buf.slice(0,idx).split('\r\n')[0].split(' ')[1];
   if(path0==='/tv')sock.end('HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: '+Buffer.byteLength(HTML)+'\r\n\r\n'+HTML);
   else sock.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n');
  });
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 t.after(()=>upstream.close());
 const upPort=upstream.address().port;

 const realTlsConnect=tls.connect,realNetConnect=net.connect;
 tls.connect=function(o){return realTlsConnect.call(tls,{host:'127.0.0.1',port:upPort,servername:o.servername,ca});};
 net.connect=function(p,h){
  const host=(typeof p==='object'&&p)?p.host:h;
  return host==='www.youtube.com'?realNetConnect.call(net,upPort,'127.0.0.1'):realNetConnect.apply(net,arguments);
 };
 t.after(()=>{tls.connect=realTlsConnect;net.connect=realNetConnect;});

 const logs=[];
 let currentScript={body:Buffer.from('window.__tt=1;'),version:'1.15.2'};
 const port=await freePort();
 const proxy=proxyLib.createProxy({host:'127.0.0.1',port,log:m=>logs.push(m),leaf:()=>leaf,script:()=>currentScript});
 await new Promise((res,rej)=>proxy.listen(e=>e?rej(e):res()));
 t.after(()=>proxy.close(true));

 const reqViaProxy=async rawReq=>{
  const s=realNetConnect.call(net,port,'127.0.0.1',()=>s.write('CONNECT www.youtube.com:443 HTTP/1.1\r\nHost: www.youtube.com:443\r\n\r\n'));
  await new Promise((res,rej)=>{s.once('data',()=>res());s.on('error',rej);});
  const ts=realTlsConnect.call(tls,{socket:s,servername:'www.youtube.com',ca});
  await new Promise((res,rej)=>{ts.on('secureConnect',res);ts.on('error',rej);});
  ts.write(rawReq);
  return await new Promise(res=>{const chunks=[];ts.on('data',d=>chunks.push(d));ts.on('end',()=>res(Buffer.concat(chunks).toString()));ts.on('close',()=>res(Buffer.concat(chunks).toString()));});
 };

 const tvReply=await reqViaProxy('GET /tv HTTP/1.1\r\nHost: www.youtube.com\r\nConnection: close\r\n\r\n');
 assert.ok(tvReply.includes('<head lang="en"><script src="/vetro-youtube/prelude.js?v=1.15.2"></script><script>boot();</script></head>'));
 assert.ok(tvReply.includes('<script src="/vetro-youtube/userscript.js?v=1.15.2"></script></BODY>'));

 const preludeReply=await reqViaProxy('GET /vetro-youtube/prelude.js?v=1.15.2 HTTP/1.1\r\nHost: www.youtube.com\r\nConnection: close\r\n\r\n');
 assert.match(preludeReply,/^HTTP\/1\.1 200 OK/);
 assert.match(preludeReply,/content-type: application\/javascript; charset=utf-8/i);
 assert.match(preludeReply,/cache-control: no-store/i);
 assert.ok(preludeReply.endsWith('\r\n\r\n'+inject.PRELUDE_BODY));

 // 404 when opts.script() is null (direct HTTP on internal server not reachable without script, check via CONNECT when script becomes null after TLS setup or test helper).
 // Check requestTimeout=0 and clientError suppression via a raw TLS socket that sends nothing or emits clientError on httpServer.
 const createHttpOrig=require('http').createServer;
 let capturedHttp=null;
 require('http').createServer=function(...args){capturedHttp=createHttpOrig.apply(this,args);return capturedHttp;};
 t.after(()=>{require('http').createServer=createHttpOrig;});
 const port2=await freePort();
 const logs2=[];
 const proxy2=proxyLib.createProxy({host:'127.0.0.1',port:port2,log:m=>logs2.push(m),leaf:()=>leaf,script:()=>currentScript});
 await new Promise((res,rej)=>proxy2.listen(e=>e?rej(e):res()));
 t.after(()=>proxy2.close(true));
 const s2=realNetConnect.call(net,port2,'127.0.0.1',()=>s2.write('CONNECT www.youtube.com:443 HTTP/1.1\r\nHost: www.youtube.com:443\r\n\r\n'));
 await new Promise(r=>s2.once('data',r));
 const ts2=realTlsConnect.call(tls,{socket:s2,servername:'www.youtube.com',ca});
 await new Promise(r=>ts2.on('secureConnect',r));
 assert.ok(capturedHttp,'httpServer created');
 assert.equal(capturedHttp.requestTimeout,0);
 let destroyedIdle=false,destroyedActive=false;
 capturedHttp.emit('clientError',{code:'ERR_HTTP_REQUEST_TIMEOUT'},{bytesRead:0,destroy(){destroyedIdle=true;}});
 assert.equal(destroyedIdle,true);
 assert.equal(logs2.some(l=>/ERR_HTTP_REQUEST_TIMEOUT/.test(l)),false);
 capturedHttp.emit('clientError',{code:'ERR_HTTP_REQUEST_TIMEOUT'},{bytesRead:12,destroy(){destroyedActive=true;}});
 assert.equal(destroyedActive,true);
 assert.equal(logs2.some(l=>/ERR_HTTP_REQUEST_TIMEOUT/.test(l)),true);
 ts2.destroy();
});
