'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),net=require('net');
const address=require('../plugins/youtube/address.js'),tile=require('../plugins/youtube/tile.js'),setup=require('../plugins/youtube/setup.js'),proxyLib=require('../plugins/youtube/proxy.js');
const ifaces={lo:[{address:'127.0.0.1',family:'IPv4',internal:true}],wlan0:[{address:'192.168.1.50',family:'IPv4',internal:false},{address:'fe80::1%wlan0',family:'IPv6',internal:false}]};

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
test('Open path starts the app with the chosen proxy address',()=>{
 assert.match(setup.launchScript('192.168.1.50',8101),/--proxy=192\.168\.1\.50:8101,direct:\/\/ --content=\/opt\/usr\/home\/owner\/share\/vyt/);
});

const watchLib=require('../plugins/youtube/watch.js');
function cobaltLine(flags){return [watchLib.COBALT_BIN,'__AUL_STARTTIME__','x',Buffer.from(flags).toString('base64')].join('\0');}
// A fake /proc: procs maps pid -> cmdline text, or 'denied' (another app's process), or 'gone' (exits while being read).
function fakeProc(procs){
 const err=code=>Object.assign(new Error(code),{code});
 const fs={reads:0,
  readdirSync:()=>Object.keys(procs).concat(['self','stat']),
  readFileSync:f=>{fs.reads++;const v=procs[f.split('/')[2]];if(v==='denied')throw err('EACCES');if(v===undefined||v==='gone')throw err('ENOENT');return v;}};
 return fs;
}
test('watch: the app\'s command line says whether it carries our flags',()=>{
 assert.equal(watchLib.classify(cobaltLine(' --dial_name=YouTube --proxy=127.0.0.2:8101,direct:// --content=/opt/usr/home/owner/share/vyt')),'ok');
 assert.equal(watchLib.classify(cobaltLine(' --base_url=https://www.youtube.com/tv --dial_name=YouTube --use_eden')),'relaunch');
 assert.equal(watchLib.classify(cobaltLine(' --dial_name=Netflix')),null);
 assert.equal(watchLib.classify('/usr/bin/node\0service.js'),null);
 assert.equal(watchLib.classify(''),null);
});
test('watch: processes there at start, short-lived ones and ours never ask for a root check',()=>{
 const procs={'1':'/sbin/init','200':'denied'};const fs=fakeProc(procs);const g=new watchLib.Gate({fs});
 assert.deepEqual(g.scan(),{verdict:null,check:false});assert.equal(fs.reads,0);            // first scan only takes note
 procs['300']='denied';assert.equal(g.scan().check,false);                                   // seen once
 delete procs['300'];assert.equal(g.scan().check,false);                                     // gone before the next scan
 procs['301']='/bin/sh\0-c\0pgrep';assert.equal(g.scan().check,false);                       // readable, not YouTube
 assert.equal(g.scan().check,false);assert.equal(g.scan().check,false);
});
test('watch: an unreadable process that stays asks for one root check, once',()=>{
 const procs={'1':'/sbin/init'};const fs=fakeProc(procs);const g=new watchLib.Gate({fs});g.scan();
 procs['400']='denied';assert.equal(g.scan().check,false);
 assert.equal(g.scan().check,true);
 const reads=fs.reads;assert.equal(g.scan().check,false);assert.equal(g.scan().check,false);
 assert.equal(fs.reads,reads);                                                               // tried once in its life
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
 const procs={'1':'/sbin/init'};const fs=fakeProc(procs);const g=new watchLib.Gate({fs});g.scan();
 procs['600']='denied';g.scan(true);assert.equal(fs.reads,0);assert.equal(g.scan().check,false);
 g.reset();procs['601']='denied';assert.equal(g.scan().check,false);assert.equal(fs.reads,0);
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
