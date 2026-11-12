'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),os=require('node:os'),path=require('node:path');
const storage=require('../plugins/twitch/accounts/store.js');
const avatars=require('../plugins/twitch/public-data.js');
function cookies(id='1',login='first',token='token-'+id){return storage.names.map(name=>({name,value:name.startsWith('auth-token')?token:encodeURIComponent(JSON.stringify({id,login,version:'1'})),domain:'.twitch.tv',path:'/',secure:true,httpOnly:false,session:false,expires:2000000000,sameSite:'None'}))}
function profile(id,login){return{id,login,cookies:cookies(id,login),savedAt:1,state:'ready'}}
function setup(options={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'twitch-accounts-manager-')),dir=path.join(root,'twitch'),store=storage.create(dir),timers=new Set(),published=[],calls=[];
 let clock=100000,actual=options.anonymous?[]:cookies(),live=true,instance=1,action=null,pathName='/',visible=true,ready=options.ready!==false,failure=null,hold=null;
 if(options.saved){let d=store.load();d.initialized=true;d.profiles=options.saved;d.pending=options.pending||null;store.save(d)}
 const session={connected:()=>live,read:async(deep)=>{const p=storage.identity(actual);return{instance:String(instance),ready,renderable:true,visible,path:pathName,profile:p,tokenPresent:!!p,auth:deep?!!p:null,action}},publish:async v=>{published.push(JSON.parse(JSON.stringify(v)));if(action&&v.ack>=action.sequence)action=null},cookies:async()=>JSON.parse(JSON.stringify(actual)),validate:async value=>{calls.push(['validate',storage.identity(value)?.id]);if(options.offline)throw Error('Validation unavailable');const token=value.find(c=>c.name==='auth-token');return token&&!token.value.startsWith('expired')?storage.identity(value):null},replace:async value=>{calls.push(['replace',storage.identity(value)?.id||null]);actual=JSON.parse(JSON.stringify(value));if(hold){const p=hold;hold=null;await p}if(failure==='replace'||failure==='always-replace'){if(failure==='replace')failure=null;throw Error('Replace failed')}},signIn:async()=>{calls.push(['sign-in']);instance++;pathName='/login'},reload:async()=>{calls.push(['reload']);instance++;pathName='/';if(failure==='reload'){failure=null;throw Error('Reload failed')}},close:async()=>{live=false;calls.push(['close'])}};
 const vaultStorage = { ...storage, create(directory) {
  const vault = storage.create(directory);
  return { ...vault, save(next) {
   if (options.beforeSave) options.beforeSave(vault.read(), next);
   return vault.save(next);
  } };
 } };
 const sandbox={module:{exports:{}},require:id=>id==='./store.js'?vaultStorage:id==='./session.js'?{open:async(port,check)=>{check();live=true;return session}}:id==='../public-data.js'?{createAvatarCatalogue:()=>avatars.createAvatarCatalogue({request:options.avatarRequest|| (async()=>({})),stop(){}})}:require(id),Promise,Date:{now:()=>clock},setInterval(fn){timers.add(fn);return fn},clearInterval(fn){timers.delete(fn)},setTimeout(fn){clock+=250;Promise.resolve().then(fn)}};
 vm.runInNewContext(fs.readFileSync('plugins/twitch/accounts/index.js','utf8'),sandbox);
 const manager=sandbox.module.exports({dir});
 return{manager,store:{read:()=>store.load()},published,calls,timers,root,async start(){manager.start();manager.setForeground(true);await manager.attach(8123);await this.flush();await this.tick()},async flush(){for(let i=0;i<20;i++)await new Promise(setImmediate)},async tick(){for(const fn of timers)fn();await this.flush()},nativeLogin(id,login,token){actual=cookies(id,login,token)},identity:()=>storage.identity(actual),path(v){pathName=v},visible(v){visible=v},ready(v){ready=v},fail(v){failure=v},hold(p){hold=p},action(v){action=v},advance(v){clock+=v},async close(){await manager.stop();assert.equal(timers.size,0);fs.rmSync(root,{recursive:true,force:true})}};
}
test('first enable saves the current authenticated account and does not show a one-account startup chooser',async()=>{
 const x=setup();try{await x.start();await x.tick();assert.equal(x.store.read().profiles.length,1);assert.equal(x.manager.status().activeId,'1');assert.equal(x.published.at(-1).visible,false);assert.ok(!JSON.stringify(x.manager.status()).includes('token-1'));assert.ok(!JSON.stringify(x.published).includes('token-1'))}finally{await x.close()}
});
test('automatic capture backs off when Twitch validation is unavailable', async () => {
    const x = setup({ offline: true });
    try {
        await x.start();
        assert.equal(x.calls.filter(call => call[0] === 'validate').length, 1);
        await x.tick();
        assert.equal(x.calls.filter(call => call[0] === 'validate').length, 1);
        x.advance(5001);
        await x.tick();
        assert.equal(x.calls.filter(call => call[0] === 'validate').length, 2);
        assert.equal(x.store.read().profiles.length, 0);
    } finally {
        await x.close();
    }
});
test('the home entry reports the current session and fetches only its avatar while the chooser is closed', async () => {
    const requests = [];
    const avatarUrl = 'https://static-cdn.jtvnw.net/jtv_user_pictures/current-profile_image-300x300.png';
    const x = setup({
        saved: [profile('1', 'first'), profile('2', 'second')],
        async avatarRequest(host, path, body) {
            const ids = Array.from(body.variables.ids);
            requests.push(ids);
            return { data: { users: ids.map(id => ({ id, profileImageURL: avatarUrl })) } };
        }
    });
    try {
        x.manager.setChooser(false);
        x.nativeLogin('3', 'unsaved');
        await x.start();
        await x.tick();
        assert.deepEqual(x.published.at(-1).homeAccount, { login: 'unsaved', avatarUrl });
        assert.deepEqual(requests, [['3']]);
        assert.equal(x.store.read().profiles.length, 2);
        x.path('/settings');
        await x.tick();
        assert.equal(x.published.at(-1).homeAccount, null);
        x.path('/');
        await x.tick();
        await x.manager.action('guest');
        assert.deepEqual(x.published.at(-1).homeAccount, { guest: true });
    } finally {
        await x.close();
    }
});
test('startup/resume chooser needs at least two accounts and respects its option; Settings remains native',async()=>{
 const x=setup({saved:[profile('1','first'),profile('2','second')]});try{
  await x.start();assert.equal(x.published.at(-1).visible,true);assert.equal(x.published.at(-1).mode,'choose');
  await x.manager.action('dismiss');await x.tick();assert.equal(x.published.at(-1).visible,false);
  x.manager.setForeground(false);x.manager.setChooser(false);x.manager.setForeground(true);await x.tick();assert.equal(x.published.at(-1).visible,false);
  x.path('/settings');await x.tick();assert.equal(x.published.at(-1).visible,false);
  x.path('/');x.action({type:'choose',sequence:1});await x.tick();assert.equal(x.published.at(-1).mode,'choose');assert.equal(x.published.at(-1).visible,true);
  await x.manager.action('dismiss');await x.tick();assert.equal(x.published.at(-1).visible,false);
 }finally{await x.close()}
});
test('the startup chooser opens before full page load and validates the active account after dismissal', async () => {
    const avatarUrl = 'https://static-cdn.jtvnw.net/jtv_user_pictures/first-profile_image-300x300.png';
    const avatarRequests = [];
    let resolveAvatars;
    const x = setup({
        ready: false,
        saved: [profile('1', 'first'), profile('2', 'second')],
        avatarRequest(host, path, body) {
            avatarRequests.push([host, path, Array.from(body.variables.ids)]);
            return new Promise(resolve => { resolveAvatars = resolve; });
        }
    });
    try {
        await x.start();
        assert.equal(x.published.at(-1).visible, true);
        assert.equal(x.published.at(-1).profiles[0].active, true);
        assert.equal(x.published.at(-1).profiles[0].avatarUrl, undefined);
        assert.deepEqual(avatarRequests, [['gql.twitch.tv', '/gql', ['1', '2']]]);
        assert.deepEqual(x.calls, []);

        resolveAvatars({ data: { users: [
            { id: '2', profileImageURL: 'https://static-cdn.jtvnw.net.example.org/jtv_user_pictures/second.png' },
            { id: '1', profileImageURL: avatarUrl }
        ] } });
        await x.flush();
        await x.tick();
        assert.equal(x.published.at(-1).profiles[0].avatarUrl, avatarUrl);
        assert.equal(x.published.at(-1).profiles[1].avatarUrl, undefined);
        assert.equal(x.manager.status().profiles[0].avatarUrl, undefined);
        assert.equal(avatarRequests.length, 1);

        x.action({ type: 'dismiss', sequence: 1 });
        await x.tick();
        assert.equal(x.published.at(-1).visible, false);
        assert.deepEqual(x.calls, []);

        x.ready(true);
        await x.tick();
        assert.deepEqual(x.calls, [['validate', '1']]);
    } finally {
        await x.close();
    }
});
test('switch saves the previous session, verifies the target and clears its rollback journal',async()=>{
 const x=setup({saved:[profile('1','first'),profile('2','second')]});try{await x.start();await x.manager.action('switch','2');assert.equal(x.identity().id,'2');assert.equal(x.manager.status().activeId,'2');assert.equal(x.store.read().pending,null);assert.equal(x.published.at(-1).visible,false);assert.ok(!JSON.stringify(x.manager.status()).includes('token-2'))}finally{await x.close()}
});
test('Guest reloads Twitch signed out and keeps all saved accounts available', async () => {
    const x = setup({ saved: [profile('1', 'first'), profile('2', 'second')] });
    try {
        await x.start();
        const saved = x.store.read().profiles;
        x.action({ type: 'guest', sequence: 1 });
        await x.tick();
        assert.equal(x.identity(), null);
        assert.equal(x.store.read().pending, null);
        assert.deepEqual(x.store.read().profiles, saved);
        assert.equal(x.manager.status().activeId, null);
        assert.equal(x.published.at(-1).guest, true);
        assert.equal(x.published.at(-1).visible, false);
        assert.equal(x.calls.filter(call => call[0] === 'reload').length, 1);

        await x.manager.action('guest');
        assert.equal(x.calls.filter(call => call[0] === 'reload').length, 1);
        await x.manager.action('add');
        await x.manager.action('cancel');
        assert.equal(x.identity(), null);
        assert.equal(x.published.at(-1).guest, true);
        assert.deepEqual(x.store.read().profiles, saved);
        await x.manager.action('switch', '2');
        assert.equal(x.identity().id, '2');
        assert.equal(x.published.at(-1).guest, false);
    } finally {
        await x.close();
    }
});
test('a failed Guest reload restores the signed-in session', async () => {
    const x = setup({ saved: [profile('1', 'first'), profile('2', 'second')] });
    try {
        await x.start();
        x.fail('reload');
        await assert.rejects(x.manager.action('guest'), /Reload failed/);
        assert.equal(x.identity().id, '1');
        assert.equal(x.store.read().pending, null);
        assert.equal(x.published.at(-1).visible, true);
        assert.equal(x.published.at(-1).guest, false);
    } finally {
        await x.close();
    }
});
test('adding uses native sign-in, automatically saves the new account and leaves both sessions reusable',async()=>{
 const x=setup();try{await x.start();await x.manager.action('add');assert.equal(x.identity(),null);assert.equal(x.store.read().pending.kind,'add');assert.equal(x.manager.status().adding,true);
  x.nativeLogin('2','second');await x.tick();assert.equal(x.manager.status().adding,false);assert.deepEqual(x.store.read().profiles.map(p=>p.id),['1','2']);assert.equal(x.store.read().pending,null);await x.manager.action('switch','1');assert.equal(x.identity().id,'1');
 }finally{await x.close()}
});
test('cancelling native sign-in and disabling during sign-in restore the previous session',async()=>{
 const x=setup();try{await x.start();await x.manager.action('add');await x.manager.action('cancel');assert.equal(x.identity().id,'1');assert.equal(x.store.read().pending,null);
  await x.manager.action('add');await x.manager.stop();assert.equal(x.identity().id,'1');assert.equal(x.store.read().pending,null);assert.equal(x.timers.size,0);
  assert.deepEqual(x.calls.slice(-3), [['replace', '1'], ['reload'], ['close']]);
 }finally{await x.close()}
});
test('a failed sign-in commit keeps the previous journal and allows cancellation', async () => {
    const x = setup({ beforeSave(previous, next) {
        if (previous.pending && !next.pending && next.profiles.length === 2) throw Error('Could not write vault');
    } });
    try {
        await x.start();
        await x.manager.action('add');
        x.nativeLogin('2', 'second');
        await x.tick();
        assert.equal(x.manager.status().busy, false);
        assert.match(x.manager.status().error, /Could not write vault/);
        assert.equal(x.store.read().pending.kind, 'add');
        assert.equal(x.store.read().profiles.length, 1);
        await x.manager.action('cancel');
        assert.equal(x.identity().id, '1');
        assert.equal(x.store.read().pending, null);
    } finally {
        await x.close();
    }
});
test('a partial cookie change or failed navigation rolls back before reporting failure',async()=>{
 for(const failure of ['replace','reload']){
  const x=setup({saved:[profile('1','first'),profile('2','second')]});try{await x.start();x.fail(failure);await assert.rejects(x.manager.action('switch','2'));assert.equal(x.identity().id,'1');assert.equal(x.store.read().pending,null)}finally{await x.close()}
 }
});
test('expired target tokens do not disturb the current account and selecting again starts reconnection',async()=>{
 const expired=profile('2','second');expired.cookies=cookies('2','second','expired-token');const x=setup({saved:[profile('1','first'),expired]});try{
  await x.start();await assert.rejects(x.manager.action('switch','2'),/sign in again/);assert.equal(x.identity().id,'1');assert.equal(x.store.read().profiles[1].state,'sign-in-required');
  await x.manager.action('switch','2');assert.equal(x.identity(),null);x.nativeLogin('3','wrong');await x.tick();assert.equal(x.identity().id,'1');assert.equal(x.store.read().profiles.some(p=>p.id==='3'),false);
 }finally{await x.close()}
});
test('interrupted on-disk transactions are recovered on attachment before accepting new changes',async()=>{
 const x=setup({saved:[profile('1','first'),profile('2','second')],pending:{kind:'switch',previousCookies:cookies(),targetId:'2',startedAt:1}});try{x.nativeLogin('2','second');await x.start();assert.equal(x.identity().id,'1');assert.equal(x.store.read().pending,null)}finally{await x.close()}
});
test('background operations are refused, forgetting does not sign out or silently re-save an account',async()=>{
 const x=setup();try{await x.start();x.manager.setForeground(false);await assert.rejects(x.manager.action('add'),/Open Twitch/);assert.equal(x.identity().id,'1');await x.manager.action('forget','1');assert.equal(x.identity().id,'1');x.manager.setForeground(true);await x.tick();assert.equal(x.store.read().profiles.length,0);assert.equal(x.manager.status().canCapture,true);assert.equal(x.published.at(-1).visible,false)}finally{await x.close()}
});
test('switching away or adding an account does not save a forgotten active profile again', async () => {
    for (const operation of ['switch', 'add']) {
        const x = setup({ saved: [profile('1', 'first'), profile('2', 'second')] });
        try {
            await x.start();
            await x.manager.action('forget', '1');
            await x.manager.action(operation, operation === 'switch' ? '2' : undefined);
            assert.deepEqual(x.store.read().profiles.map(profile => profile.id), ['2']);
            if (operation === 'add') {
                await x.manager.action('cancel');
                assert.equal(x.identity().id, '1');
                assert.deepEqual(x.store.read().profiles.map(profile => profile.id), ['2']);
            }
        } finally {
            await x.close();
        }
    }
});
test('stop during a live mutation waits for rollback and leaves no late account change',async()=>{
 const x=setup({saved:[profile('1','first'),profile('2','second')]});try{await x.start();let release;const hold=new Promise(r=>release=r);x.hold(hold);
  const changed=x.manager.action('switch','2');await x.flush();assert.equal(x.identity().id,'2');const stopped=x.manager.stop();release();await assert.rejects(changed);await stopped;assert.equal(x.identity().id,'1');assert.equal(x.store.read().pending,null);assert.equal(x.timers.size,0);
 }finally{await x.close()}
});

test('active sessions are validated again hourly and expired sessions require a new sign-in',async()=>{
 const x=setup();try{await x.start();const checked=x.calls.filter(c=>c[0]==='validate').length;x.nativeLogin('1','first','expired-token');
  await x.tick();assert.equal(x.calls.filter(c=>c[0]==='validate').length,checked);
  x.advance(3600001);await x.tick();assert.equal(x.calls.filter(c=>c[0]==='validate').length,checked+1);assert.equal(x.store.read().profiles[0].state,'sign-in-required');assert.match(x.manager.status().error,/sign in again/);assert.equal(x.calls.some(c=>c[0]==='replace'),false);
 }finally{await x.close()}
});
test('an anonymous first launch never opens a chooser, and the manual chooser can add the first account',async()=>{
 const x=setup({anonymous:true});try{await x.start();assert.equal(x.published.at(-1).visible,false);assert.equal(x.store.read().profiles.length,0);x.action({type:'choose',sequence:1});await x.tick();assert.equal(x.published.at(-1).mode,'choose');assert.equal(x.published.at(-1).visible,true);await x.manager.action('add');x.nativeLogin('2','second');await x.tick();assert.equal(x.store.read().profiles.length,1)}finally{await x.close()}
});

test('failed rollback retains the encrypted journal and a later attachment recovers it',async()=>{
 const x=setup({saved:[profile('1','first'),profile('2','second')]});try{
  await x.start();x.fail('always-replace');await assert.rejects(x.manager.action('switch','2'),/recovery is pending/);assert.equal(x.store.read().pending.kind,'switch');
  await x.manager.stop();assert.equal(x.store.read().pending.kind,'switch');x.fail(null);await x.start();assert.equal(x.identity().id,'1');assert.equal(x.store.read().pending,null);
 }finally{await x.close()}
});
