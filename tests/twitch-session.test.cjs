'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),cp=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const platform=require('../plugins/twitch/session-shell.js');
test('session shell programs are syntactically valid and accept only observed numeric process values',()=>{
 for(const source of [platform.inspectSessionScript(),platform.prepareSessionScript(42,'123'),platform.prepareSessionScript(0,'0',true),platform.cleanupSessionScript({restoreNormalApp: true}),platform.cleanupSessionScript()]){
  const r=cp.spawnSync('sh',['-n'],{input:source,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 }
 for(const bad of ['1; touch /tmp/not-allowed','-2','abc'])assert.throws(()=>platform.prepareSessionScript(bad,'123'));
 assert.throws(()=>platform.prepareSessionScript(42,'1;echo bad'));
 assert.throws(()=>platform.prepareSessionScript(0,'0'));
});
test('snapshot parser rejects malformed or unready sessions',()=>{
 const state={format:1,pid:42,start:'123',port:8123,ready:true};
 assert.deepEqual(platform.parseSessionSnapshot('pid=42\nstart=123\nforeground=1\nstate='+JSON.stringify(state)).ownedSession,state);
 for(const s of [{...state,port:80},{...state,pid:'42'},{...state,start:'abc'},{...state,ready:false}])assert.equal(platform.parseSessionSnapshot('state='+JSON.stringify(s)).ownedSession,null);
});
test('a successful retry clears an earlier root-agent error while waiting for Twitch', async () => {
    const vm = require('node:vm');
    const sandbox = { module: { exports: {} }, require: () => platform, Promise, Date,
        setInterval() { return 1; }, clearInterval() {} };
    vm.runInNewContext(fs.readFileSync('plugins/twitch/session-manager.js', 'utf8'), sandbox);
    let unavailable = true;
    const manager = sandbox.module.exports({
        async execute() {
            if (unavailable) { unavailable = false; throw Error('No root agent connected'); }
            return { exit_code: 0, stdout: 'pid=0\nstart=0\nforeground=0\n' };
        }
    });
    const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
    try {
        manager.start();
        await flush();
        assert.equal(manager.status().error, 'No root agent connected');
        manager.retry();
        await flush();
        assert.equal(manager.status().phase, 'waiting-for-twitch');
        assert.equal(manager.status().error, null);
    } finally {
        await manager.stop();
    }
});
function simulate(mode){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'twitch-session-test-'));const runtime=path.join(dir,'runtime');
 const fromTile=mode.startsWith('tile-'), reuse=mode==='tile-reuse', noPid=fromTile&&!reuse;
 fs.writeFileSync(path.join(dir,'pid'),noPid?'':'42');
 if(reuse){
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime,'owner'),'42 123 8123\n');
  fs.writeFileSync(path.join(runtime,'state.json'),JSON.stringify({format:1,pid:42,start:'123',port:8123,ready:true}));
 }
 let source=platform.prepareSessionScript(noPid?0:42,noPid?'0':'123',fromTile);
 source=source.replace('SESSION_DIR=/run/vetro-twitch-session','SESSION_DIR='+runtime).replace('APP_USER_ID=$(id -u owner)','APP_USER_ID=5001').replace('[ "$(stat -c %u "$SESSION_DIR")" = 0 ]','true');
 const mock=[
  'twitch_pid() { cat "$FIXTURE/pid"; }','process_start_time() { echo 123; }','twitch_is_foreground() { [ "$MODE" != tile-reuse ] && { [ "$MODE" != background-failure ] || [ ! -f "$FIXTURE/launched" ]; }; }',
  'app_launcher() {',
  ' echo "$*" >> "$FIXTURE/apps"',
  ' case "$1" in -w) [ -f "$FIXTURE/v4-guard" ] && [ -f "$FIXTURE/v6-guard" ] || return 1; touch "$FIXTURE/launched"; echo 43 > "$FIXTURE/pid"; echo "... successfully launched pid = 43 with debug 1 port: 8123";; -t) : > "$FIXTURE/pid";; -s) echo 44 > "$FIXTURE/pid";; esac',
  '}',
  'iptables() {',
  ' echo "$*" >> "$FIXTURE/rules"',
  ' if [ "$1" = -nL ]; then [ "$MODE" = foreign ]; return; fi',
  ' if [ "$1" = -I ] && [ "$*" = "-I INPUT 1 ! -i lo -p tcp --syn -j VETRO_TWITCH_AUTO" ]; then touch "$FIXTURE/v4-guard"; fi',
  ' if [ "$1" = -S ] && [ -f "$FIXTURE/v4-guard" ]; then echo "-A INPUT ! -i lo -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -j VETRO_TWITCH_AUTO"; fi',
  ' if [ "$1" = -D ] && [ "$*" = "-D INPUT ! -i lo -p tcp --syn -j VETRO_TWITCH_AUTO" ]; then rm -f "$FIXTURE/v4-guard"; fi',
  ' if [ "$1" = -C ] && [ -f "$FIXTURE/launched" ] && { [ "$MODE" = failure ] || [ "$MODE" = background-failure ] || [ "$MODE" = tile-failure ]; }; then return 1; fi',
  ' return 0',
  '}',
  'ipv6_available() { return 0; }',
  'ip6tables() {',
  ' if [ "$1" = -nL ]; then return 1; fi',
  ' if [ "$1" = -I ] && [ "$*" = "-I INPUT 1 ! -i lo -p tcp --syn -j VETRO_TWITCH_AUTO" ]; then [ "$MODE" != startup-failure ] || return 1; touch "$FIXTURE/v6-guard"; fi',
  ' if [ "$1" = -S ] && [ -f "$FIXTURE/v6-guard" ]; then echo "-A INPUT ! -i lo -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -j VETRO_TWITCH_AUTO"; fi',
  ' if [ "$1" = -D ] && [ "$*" = "-D INPUT ! -i lo -p tcp --syn -j VETRO_TWITCH_AUTO" ]; then rm -f "$FIXTURE/v6-guard"; fi',
  ' return 0',
  '}',
  'netstat() { if [ -s "$FIXTURE/pid" ]; then echo "tcp 0 0 0.0.0.0:8123 0.0.0.0:* LISTEN"; fi; }','nohup() { return 0; }'
 ].join('\n');
 source=source.replace('\nacquire_session_lock || exit 0','\n'+mock+'\nacquire_session_lock || exit 0');
 const r=cp.spawnSync('sh',[],{input:source,encoding:'utf8',env:{...process.env,FIXTURE:dir,MODE:mode},timeout:10000});
 const read=n=>{try{return fs.readFileSync(path.join(dir,n),'utf8')}catch{return''}};
 const guardStillInstalled = fs.existsSync(path.join(dir,'v4-guard')) || fs.existsSync(path.join(dir,'v6-guard'));
 const result={status:r.status,stdout:r.stdout,stderr:r.stderr,rules:read('rules'),apps:read('apps'),marker:read('runtime/state.json'),guardStillInstalled};fs.rmSync(dir,{recursive:true,force:true});return result;
}
test('mocked successful preparation publishes state after rule verification',()=>{
 const r=simulate('success');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/ready=1/);assert.match(r.rules,/-C INPUT -p tcp --dport 8123/);assert.equal(JSON.parse(r.marker).port,8123);assert.equal(r.guardStillInstalled,false);
});
test('Twitch is left untouched if the startup firewall cannot protect both families',()=>{
 const r=simulate('startup-failure');assert.notEqual(r.status,0);assert.equal(r.apps,'');assert.equal(r.marker,'');assert.equal(r.guardStillInstalled,false);
});
test('the tile cold-starts directly, reuses a guarded session, and leaves fallback to Vetro on failure', () => {
    const cold = simulate('tile-success');
    assert.equal(cold.status, 0, cold.stderr);
    assert.match(cold.stdout, /ready=1/);
    assert.equal(cold.apps.trim(), '-w -s Jz7aUrV2Q4.Twitch -u 5001');
    assert.match(cold.rules, /-C INPUT -p tcp --dport 8123/);

    const reuse = simulate('tile-reuse');
    assert.equal(reuse.status, 0, reuse.stderr);
    assert.match(reuse.stdout, /reused=1/);
    assert.equal(reuse.apps.trim(), '-s Jz7aUrV2Q4.Twitch -u 5001');
    assert.equal(JSON.parse(reuse.marker).pid, 42);

    const failed = simulate('tile-failure');
    assert.notEqual(failed.status, 0);
    assert.doesNotMatch(failed.apps, /^-s /m);
    assert.equal(failed.marker, '');
});
test('mocked firewall failure closes debug app and falls back normally without publishing state',()=>{
 const r=simulate('failure');assert.notEqual(r.status,0);assert.equal(r.marker,'');assert.match(r.apps,/-s Jz7aUrV2Q4.Twitch -u 5001/);assert.match(r.rules,/-D INPUT -p tcp --dport 8123/);
});
test('foreign firewall chain is left untouched before any app termination',()=>{
 const r=simulate('foreign');assert.equal(r.status,0);assert.match(r.stdout,/foreign_chain/);assert.equal(r.apps,'');assert.equal(r.marker,'');
});
test('cleanup keeps isolation when the inspector is listening or its socket table is unavailable',()=>{
 for(const socketTable of ['echo "tcp 0 0 0.0.0.0:8123 0.0.0.0:* LISTEN"', 'return 1']){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'twitch-cleanup-test-'));fs.writeFileSync(path.join(dir,'owner'),'42 123 8123\n');fs.writeFileSync(path.join(dir,'state.json'),'{}');
 let source=platform.cleanupSessionScript().replace('SESSION_DIR=/run/vetro-twitch-session','SESSION_DIR='+dir).replace('APP_USER_ID=$(id -u owner)','APP_USER_ID=5001').replace('[ "$(stat -c %u "$SESSION_DIR")" = 0 ]','true');
 source=source.replace('\ncleanup_session','\nnetstat() { '+socketTable+'; }\nsleep() { :; }\niptables() { echo touched >> "$SESSION_DIR/rules"; }\ncleanup_session');
 try{
  const r=cp.spawnSync('sh',[],{input:source,encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/cleanup_pending=1/);
  assert.equal(fs.existsSync(path.join(dir,'state.json')),false);assert.equal(fs.existsSync(path.join(dir,'owner')),true);assert.equal(fs.existsSync(path.join(dir,'rules')),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
 }
});
test('normal launch is restored only when the owned app was foreground and the listener has closed',()=>{
 for(const foreground of [true,false]){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'twitch-restore-test-'));fs.writeFileSync(path.join(dir,'owner'),'42 123 8123\n');fs.writeFileSync(path.join(dir,'state.json'),'{}');
  let source=platform.cleanupSessionScript({restoreNormalApp: true}).replace('SESSION_DIR=/run/vetro-twitch-session','SESSION_DIR='+dir).replace('APP_USER_ID=$(id -u owner)','APP_USER_ID=5001').replace('[ "$(stat -c %u "$SESSION_DIR")" = 0 ]','true');
  const mocks='\ntwitch_is_foreground() { return '+(foreground?'0':'1')+'; }\nclose_owned_twitch() { echo closed > "$SESSION_DIR/closed"; }\ninspector_is_listening() { return 1; }\niptables() { :; }\napp_launcher() { echo "$*" > "$SESSION_DIR/reopened"; }\n';
  source=source.replace('\ncleanup_session',mocks+'cleanup_session');
  try{
   const r=cp.spawnSync('sh',[],{input:source,encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);assert.equal(fs.existsSync(path.join(dir,'closed')),true);
   assert.equal(fs.existsSync(path.join(dir,'reopened')),foreground);assert.equal(fs.existsSync(path.join(dir,'state.json')),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
 }
});
test('ready snapshots require the original process identity and all isolation rules',()=>{
 const state={format:1,pid:42,start:'123',port:8123,ready:true};
 for(const identity of ['pid=43\nstart=123\n','pid=42\nstart=124\n']){
  const parsed=platform.parseSessionSnapshot(identity+'state='+JSON.stringify(state));assert.equal(parsed.ownedSession,null);assert.equal(parsed.staleSession,true);
 }
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'twitch-snapshot-test-'));fs.writeFileSync(path.join(dir,'owner'),'42 123 8123\n');fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(state));
 try{
  for(const isolated of [true,false]){
   let source=platform.inspectSessionScript().replace('SESSION_DIR=/run/vetro-twitch-session','SESSION_DIR='+dir).replace('APP_USER_ID=$(id -u owner)','APP_USER_ID=5001').replace('[ "$(stat -c %u "$SESSION_DIR")" = 0 ]','true');
   const mocks='twitch_pid() { echo 42; }\nprocess_start_time() { echo 123; }\ntwitch_is_foreground() { return 0; }\ninspector_is_listening() { return 0; }\nipv6_available() { return 1; }\niptables() { return '+(isolated?0:1)+'; }\n';
   source=source.replace('\ninspect_session','\n'+mocks+'inspect_session');
   const r=cp.spawnSync('sh',[],{input:source,encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);
   const parsed=platform.parseSessionSnapshot(r.stdout);assert.equal(!!parsed.ownedSession,isolated);assert.equal(parsed.isolationMissing,!isolated);
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('a prepared session is confirmed and reported without waiting for the next poll', async () => {
    const vm = require('node:vm');
    const sandbox = { module: { exports: {} }, require: () => platform, Promise, Date, setInterval() { return 1; }, clearInterval() {} };
    vm.runInNewContext(fs.readFileSync('plugins/twitch/session-manager.js', 'utf8'), sandbox);
    let inspections = 0;
    const phases = [];
    const manager = sandbox.module.exports({
        execute: async (cmd) => {
            const script = Buffer.from(cmd.split(' ')[1], 'base64').toString();
            let stdout = 'ready=1\n';
            if (script.endsWith('inspect_session')) {
                stdout = ++inspections === 1
                    ? 'pid=42\nstart=123\nforeground=1\n'
                    : 'pid=43\nstart=124\nforeground=1\nstate={"format":1,"pid":43,"start":"124","port":8123,"ready":true}\n';
            } else if (script.endsWith('cleanup_session')) {
                stdout = 'cleaned=1\n';
            }
            return { exit_code: 0, stdout };
        }
    }, () => phases.push(manager.status().phase));

    manager.start();
    await new Promise(setImmediate);
    assert.equal(inspections, 2);
    assert.deepEqual(phases, ['ready']);
    assert.equal(manager.status().key, '43:124:8123');
    await manager.stop();
});
test('tile launch requests share one attempt and leave the native fallback running after failure', async () => {
    const vm = require('node:vm');
    let tick, native = false;
    const sandbox = { module: { exports: {} }, require: () => platform, Promise, Date,
        setInterval(fn) { tick = fn; return 1; }, clearInterval() {} };
    vm.runInNewContext(fs.readFileSync('plugins/twitch/session-manager.js', 'utf8'), sandbox);
    const prepares = [];
    const manager = sandbox.module.exports({
        execute: async cmd => {
            const script = Buffer.from(cmd.split(' ')[1], 'base64').toString();
            if (script.endsWith('cleanup_session')) return { exit_code: 0, stdout: 'cleaned=1\n' };
            if (script.endsWith('inspect_session')) {
                return { exit_code: 0, stdout: native ? 'pid=43\nstart=124\nforeground=1\n' : 'pid=0\nstart=0\nforeground=0\n' };
            }
            prepares.push(script);
            return { exit_code: 1, stdout: '' };
        }
    });
    manager.start();
    try {
        const first = manager.launch();
        assert.equal(manager.launch(), first);
        assert.equal(await first, false);
        assert.equal(prepares.length, 1);
        assert.match(prepares[0], /OBSERVED_PID=0\nOBSERVED_START=0\nFROM_TILE=1/);

        native = true;
        tick();
        await new Promise(setImmediate);
        assert.equal(manager.status().phase, 'normal-fallback');
        assert.equal(prepares.length, 1);
    } finally {
        await manager.stop();
    }
});
test('stop retries a held root lock and never reports stopped while cleanup stays busy',async()=>{
 const vm=require('node:vm');
 for(const busyForever of [false,true]){
  let cleanups=0;
  const sandbox={module:{exports:{}},require:()=>platform,Promise,Date,setInterval(){return 1},clearInterval(){},setTimeout(fn){Promise.resolve().then(fn)}};
  vm.runInNewContext(fs.readFileSync('plugins/twitch/session-manager.js','utf8'),sandbox);
  const instance=sandbox.module.exports({execute:async(cmd)=>{
   const script=Buffer.from(cmd.split(' ')[1],'base64').toString();
   if(script.endsWith('cleanup_session')){cleanups++;return{exit_code:0,stdout:busyForever||cleanups<2?'busy\n':'cleaned=1\n'}}
   return{exit_code:0,stdout:'pid=0\nstart=0\nforeground=0\n'};
  }});
  instance.start();await instance.stop();assert.equal(cleanups,busyForever?3:2);assert.equal(instance.status().phase,busyForever?'cleanup-failed':'stopped');
 }
});

test('a failed debug launch never brings Twitch back over another foreground app',()=>{
 const r=simulate('background-failure');assert.notEqual(r.status,0);assert.equal(r.marker,'');assert.match(r.apps,/-w -s Jz7aUrV2Q4.Twitch/);assert.doesNotMatch(r.apps,/^-s Jz7aUrV2Q4.Twitch/m);
});
test('inspection reads the process stamp and exact listening port without a user lookup',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'twitch-inspect-readonly-'));
 const state={format:1,pid:42,start:'123',port:8123,ready:true};
 fs.writeFileSync(path.join(dir,'owner'),'42 123 8123\n');fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(state));
 try{
  for(const port of [8123,18123]){
   let source=platform.inspectSessionScript().replace('SESSION_DIR=/run/vetro-twitch-session','SESSION_DIR='+dir).replace('[ "$(stat -c %u "$SESSION_DIR")" = 0 ]','true');
   const mocks='\nid() { return 1; }\ntwitch_pid() { echo 42; }\nprocess_start_time() { echo 123; }\ntwitch_is_foreground() { return 0; }\nnetstat() { echo "tcp 0 0 0.0.0.0:'+port+' 0.0.0.0:* LISTEN"; }\nipv6_available() { return 1; }\niptables() { [ "$1" = -C ]; }\n';
   source=source.replace('\ninspect_session',mocks+'inspect_session');
   const r=cp.spawnSync('sh',[],{input:source,encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);
   const snapshot=platform.parseSessionSnapshot(r.stdout);assert.equal(snapshot.start,'123');assert.equal(!!snapshot.ownedSession,port===8123);assert.equal(snapshot.staleSession,port!==8123);
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('the independent guard retires only the session identity it observed',()=>{
 const prepare=platform.prepareSessionScript(42,'123'),encoded=/^CLEANUP_GUARD_BASE64=([A-Za-z0-9+/=]+)$/m.exec(prepare)[1];
 for(const replaced of [false,true]){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'twitch-cleanup-guard-'));fs.writeFileSync(path.join(dir,'owner'),'42 123 8123\n');fs.writeFileSync(path.join(dir,'state.json'),'{}');
  let source=Buffer.from(encoded,'base64').toString().replace('SESSION_DIR=/run/vetro-twitch-session','SESSION_DIR='+dir).replace('[ "$(stat -c %u "$SESSION_DIR")" = 0 ]','true');
  const mock='\ninspector_is_listening() { '+(replaced?'echo "43 124 8124" > "$SESSION_DIR/owner"; ':'')+'return 1; }\niptables() { echo "$*" >> "$SESSION_DIR/removed-rules"; }\n';
  source=source.replace('\nif [ "${1:-}" = startup ]',mock+'if [ "${1:-}" = startup ]');
  try{
   const r=cp.spawnSync('sh',[],{input:source,encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);
   assert.equal(fs.existsSync(path.join(dir,'state.json')),replaced);assert.equal(fs.existsSync(path.join(dir,'removed-rules')),!replaced);
   if(!replaced)assert.match(fs.readFileSync(path.join(dir,'removed-rules'),'utf8'),/--dport 8123/);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
 }
});
test('the startup guard closes an interrupted debug launch before removing its startup rules', () => {
    const encoded = /^CLEANUP_GUARD_BASE64=([A-Za-z0-9+/=]+)$/m.exec(platform.prepareSessionScript(42, '123'))[1];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-startup-guard-'));
    try {
        fs.writeFileSync(path.join(dir, 'starting'), '99999999 456\n');
        fs.writeFileSync(path.join(dir, 'owner'), '42 123 8123\n');
        fs.writeFileSync(path.join(dir, 'ipv4-chain'), '');
        fs.mkdirSync(path.join(dir, 'lock'));
        fs.writeFileSync(path.join(dir, 'lock', 'pid'), '99999999 456\n');
        const mocks = [
            'id() { echo 5001; }',
            'sleep() { :; }',
            'process_start_time() { if [ "$1" = 42 ]; then echo 123; fi; }',
            'twitch_pid() { echo 42; }',
            'app_launcher() { echo close >> "$SESSION_DIR/actions"; }',
            'netstat() { if [ ! -f "$SESSION_DIR/socket-table-retried" ]; then touch "$SESSION_DIR/socket-table-retried"; echo unknown >> "$SESSION_DIR/actions"; return 2; fi; }',
            'iptables() { case "$1" in -S) echo "-A INPUT ! -i lo -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -j VETRO_TWITCH_AUTO";; -D) echo remove >> "$SESSION_DIR/actions";; esac; }'
        ].join('\n');
        const source = Buffer.from(encoded, 'base64').toString()
            .replace('SESSION_DIR=/run/vetro-twitch-session', 'SESSION_DIR=' + dir)
            .replace('[ "$(stat -c %u "$SESSION_DIR")" = 0 ]', 'true')
            .replace('\nif [ "${1:-}" = startup ]', '\n' + mocks + '\nif [ "${1:-}" = startup ]');
        const result = cp.spawnSync('sh', ['-s', '--', 'startup', '99999999', '456'], { input: source, encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 0, result.stderr);
        assert.match(fs.readFileSync(path.join(dir, 'actions'), 'utf8'), /^close\nunknown\nremove\n/);
        assert.equal(fs.existsSync(path.join(dir, 'starting')), false);
        assert.equal(fs.existsSync(path.join(dir, 'owner')), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
