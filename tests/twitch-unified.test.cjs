'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),{EventEmitter}=require('node:events');
function setup(late=false,emoteFailure=false,options={}){
 let config=options.config||{},failSave=false,indicator=false,fallback=false,a=false,chooser=true,foreground=false,pointsForeground=false,pointsIndicator=false,pointsAttached=false,pageOptions='',attachedPageOptions='';
 const calls=[],timers=new Set();let phase={phase:'ready',port:8123,key:'42:123:8123',foreground:true},release,entered,onSessionChange;
 const started=new Promise(r=>entered=r);let f=false,e=false;
 const filter={setFallback(v){fallback=v},setSkipIndicator(v){indicator=v},start(){calls.push('filter-start')},stop:async()=>{f=false;calls.push('filter-stop');if(release)release()},detach:async()=>{f=false;calls.push('filter-detach')},attach:async(p)=>{calls.push('filter-attach:'+p);if(late&&!release){entered();await new Promise(r=>release=r)}f=true},connected:()=>f,status:()=>({attached:f}),details:()=>({attached:f})};
 const emotes={start(){calls.push('emotes-start')},stop:async()=>{e=false;calls.push('emotes-stop')},detach:async()=>{e=false;calls.push('emotes-detach')},attach:async(p)=>{calls.push('emotes-attach:'+p);if(emoteFailure)throw Error('7TV unavailable');e=true},connected:()=>e,status:()=>({attached:e}),details:async()=>({attached:e})};
 const accounts={setChooser(v){chooser=v},setForeground(v){foreground=v},start(){calls.push('accounts-start')},stop:async()=>{a=false;calls.push('accounts-stop')},detach:async()=>{a=false},attach:async()=>{calls.push('accounts-attach');if(options.accountsFailure)throw Error('Account storage unavailable');a=true},connected:()=>a,status:()=>({attached:a,profiles:[]}),action:async(type,id)=>{calls.push('account-action:'+type+':'+id);return{profiles:[]}}};
 const points={setDocumentFeatures(controls,points){pageOptions=String(controls)+String(points)},setPointsActive(v){pointsForeground=v},setIndicator(v){pointsIndicator=v},start(){calls.push('points-start')},
  stop:async()=>{pointsAttached=false;calls.push('points-stop')},detach:async()=>{pointsAttached=false},
  attach:async()=>{pointsAttached=true;attachedPageOptions=pageOptions;calls.push('points-attach')},connected:()=>pointsAttached&&attachedPageOptions===pageOptions,status:()=>({attached:pointsAttached})};
 const session={start(){calls.push('session-start')},stop:async()=>{calls.push('session-stop');if(options.sessionStop)await options.sessionStop()},status:()=>phase,retry(){calls.push('retry')},launch:async()=>{calls.push('session-launch');return true}};
 const context={module:{exports:{}},require(id){if(id==='./session-manager.js')return(_context,onChange)=>{onSessionChange=onChange;return session};if(id==='./filter/index.js')return()=>filter;if(id==='./emotes/index.js')return()=>emotes;if(id==='./accounts/index.js')return()=>accounts;if(id==='./page-actions.js')return{createPageActions:()=>points};return require(id)},Promise,Buffer,Date:class extends Date {static now(){return 1000000}},setInterval(fn){timers.add(fn);return fn},clearInterval(fn){timers.delete(fn)},__dirname:require('node:path').resolve('plugins/twitch')};
 vm.runInNewContext(fs.readFileSync('plugins/twitch/index.js','utf8'),context);
 const create=()=>context.module.exports({config:{get:()=>JSON.parse(JSON.stringify(config)),set:v=>{if(failSave)throw Error('Disk full');config=JSON.parse(JSON.stringify(v))}}});
 const plugin=create();return{plugin,create,calls,timers,started,config:()=>config,accounts:()=>({attached:a,chooser,foreground}),indicator:()=>indicator,fallback:()=>fallback,points:()=>({pointsAttached,pointsForeground,pointsIndicator}),failSave(v){failSave=v},phase(v){phase=v},notifySessionChange(){onSessionChange()},releaseAttachment(){release()},async flush(){for(let i=0;i<8;i++)await new Promise(setImmediate)},tick(){for(const fn of timers)fn()}};
}
test('one plugin starts both features and a single session, attaches without reloading and stops session last',async()=>{
 const x=setup();x.plugin.start();await x.flush();assert.equal(x.plugin.status().connected,true);assert.equal(x.calls.filter(c=>c==='session-start').length,1);
 x.tick();await x.flush();assert.equal(x.calls.filter(c=>c.startsWith('filter-attach')).length,1);
 await x.plugin.stop();assert.equal(x.timers.size,0);assert.equal(x.calls.at(-1),'session-stop');assert.equal(x.plugin.status().connected,false);
});
test('a changed session detaches both modules and reconnects without waiting for the attachment timer',async()=>{
 const x=setup();x.plugin.start();await x.flush();x.phase({phase:'ready',port:8124,key:'43:124:8124'});x.notifySessionChange();await x.flush();
 assert.ok(x.calls.includes('filter-attach:8124'));assert.ok(x.calls.includes('emotes-attach:8124'));
 x.phase({phase:'waiting-for-twitch',port:null,key:null});x.tick();await x.flush();assert.equal(x.plugin.status().connected,false);await x.plugin.stop();
});
test('session changes during attachment are handled using the latest session', async () => {
    const x = setup(true);
    x.plugin.start();
    try {
        await x.started;
        x.phase({ phase: 'ready', port: 8124, key: '43:124:8124' });
        x.notifySessionChange();
        x.phase({ phase: 'ready', port: 8125, key: '44:125:8125' });
        x.notifySessionChange();
        x.releaseAttachment();
        await x.flush();

        assert.deepEqual(x.calls.filter(call => call.startsWith('filter-attach:')), ['filter-attach:8123', 'filter-attach:8125']);
        assert.ok(x.calls.includes('emotes-attach:8125'));
        assert.equal(x.plugin.status().connected, true);
    } finally {
        await x.plugin.stop();
    }
});
test('stopping the page actions removes a late document script before closing the connection', async () => {
    const inspector = require('../plugins/twitch/inspector-client.js');
    const { createPageActions } = require('../plugins/twitch/page-actions.js');
    const originalListing = inspector.listTargets;
    const originalConnect = inspector.connect;
    const calls = [];
    let announce, finishRegistration;
    const registrationStarted = new Promise(resolve => { announce = resolve; });
    inspector.listTargets = async () => [{ type: 'page', url: 'https://samsung.tv.twitch.tv/', webSocketDebuggerUrl: 'local' }];
    inspector.connect = async () => ({
        async call(method, params) {
            calls.push([method, params]);
            if (method === 'Page.addScriptToEvaluateOnNewDocument') {
                announce();
                return new Promise(resolve => { finishRegistration = resolve; });
            }
            return {};
        },
        close() { calls.push(['close']); }
    });
    const pageActions = createPageActions({});
    try {
        pageActions.start();
        const attached = assert.rejects(pageActions.attach(8123), /attachment cancelled/);
        await registrationStarted;
        const stopped = pageActions.stop();
        finishRegistration({ identifier: 'late' });
        await Promise.all([attached, stopped]);

        assert.deepEqual(calls.map(([method]) => method), [
            'Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Page.removeScriptToEvaluateOnNewDocument', 'Runtime.evaluate', 'close'
        ]);
        assert.deepEqual(calls[2][1], { identifier: 'late' });
        assert.equal(pageActions.connected(), false);
    } finally {
        inspector.listTargets = originalListing;
        inspector.connect = originalConnect;
    }
});
test('the Shard only handles its own app tile when an enhancement is enabled', async () => {
    const appId = 'Jz7aUrV2Q4.Twitch';
    const enabled = setup();
    assert.equal(await enabled.plugin.launch(appId), false);
    enabled.plugin.start();
    try {
        assert.equal(await enabled.plugin.launch('another.app'), false);
        assert.equal(await enabled.plugin.launch(appId), true);
        assert.equal(enabled.calls.filter(call => call === 'session-start').length, 1);
        assert.equal(enabled.calls.filter(call => call === 'session-launch').length, 1);
    } finally {
        await enabled.plugin.stop();
    }

    const disabled = setup(false, false, { config: { adFiltering: false, emotes7tv: false, accountManager: false, playerControls: false } });
    disabled.plugin.start();
    try {
        assert.equal(await disabled.plugin.launch(appId), false);
        assert.ok(!disabled.calls.includes('session-launch'));
    } finally {
        await disabled.plugin.stop();
    }
});
test('stop during attachment cancels late activation before session teardown',async()=>{
 const x=setup(true);x.plugin.start();await x.started;await x.plugin.stop();assert.equal(x.plugin.status().connected,false);assert.equal(x.calls.at(-1),'session-stop');assert.equal(x.timers.size,0);
});
test('7TV failure leaves ad filtering connected, backs off retries and stops both modules',async()=>{
 const x=setup(false,true);x.plugin.start();await x.flush();let state=x.plugin.status();
 assert.equal(state.connected,false);assert.equal(state.filter.attached,true);assert.equal(state.emotes.attached,false);assert.match(state.error,/7TV unavailable/);
 const detachCount=x.calls.filter(c=>c==='filter-detach').length;
 x.tick();await x.flush();assert.equal(x.calls.filter(c=>c==='filter-detach').length,detachCount);assert.equal(x.calls.filter(c=>c.startsWith('filter-attach')).length,1);
 await x.plugin.stop();assert.equal(x.calls.at(-1),'session-stop');assert.equal(x.plugin.status().filter.attached,false);
});

test('the unified plugin keeps manual attachment and layout routes private',async()=>{
 const x=setup();
 for(const sub of ['filter/attach','filter/detach','emotes/attach','emotes/detach','emotes/layout','filter/layout'])
  for(const method of ['GET','POST'])assert.equal(x.plugin.route({method},{},sub),false,method+' '+sub);
 for(const sub of ['filter/status','emotes/status']){
  let data;const res={writeHead(code){assert.equal(code,200)},end(body){data=JSON.parse(body)}};
  assert.equal(x.plugin.route({method:'GET'},res,sub),true);await x.flush();assert.equal(data.attached,false);
  assert.equal(x.plugin.route({method:'POST'},{},sub),false);
 }
});

function getSettings(plugin){
 let value;assert.equal(plugin.route({method:'GET'},{writeHead(code){assert.equal(code,200)},end(body){value=JSON.parse(body)}},'settings'),true);return value;
}
function postSettings(plugin,body){
 const req=new EventEmitter();req.method='POST';
 let code,replies=0,value;
 const res={writeHead(v){code=v},end(v){value=JSON.parse(v);replies++}};
 assert.equal(plugin.route(req,res,'settings'),true);
 for(const chunk of (Array.isArray(body)?body:[JSON.stringify(body)]))req.emit('data',chunk);
 req.emit('end');return{code,value,replies};
}
test('settings default to on, persist independently, preserve unrelated config and survive recreation',async()=>{
 const x=setup(false,false,{config:{other:'keep'}});assert.deepEqual(getSettings(x.plugin),{adFiltering:true,adFallback:false,emotes7tv:true,adSkipIndicator:false,accountManager:false,accountChooserOnLaunch:true,channelPoints:false,channelPointsIndicator:false,playerControls:true});
 assert.equal(postSettings(x.plugin,{adFiltering:false}).code,200);
 assert.equal(postSettings(x.plugin,{emotes7tv:false,playerControls:false}).code,200);
 assert.deepEqual(x.config(),{other:'keep',adFiltering:false,adFallback:false,emotes7tv:false,adSkipIndicator:false,accountManager:false,accountChooserOnLaunch:true,channelPoints:false,channelPointsIndicator:false,playerControls:false});
 assert.deepEqual(getSettings(x.create()),{adFiltering:false,adFallback:false,emotes7tv:false,adSkipIndicator:false,accountManager:false,accountChooserOnLaunch:true,channelPoints:false,channelPointsIndicator:false,playerControls:false});
 x.plugin.start();await x.flush();assert.equal(x.calls.length,0);assert.equal(x.plugin.status().connected,false);await x.plugin.stop();assert.equal(x.timers.size,0);
});
test('the experimental backup preference applies without reconnecting the filter', async () => {
    const x = setup();
    x.plugin.start();
    await x.flush();
    try {
        const calls = x.calls.length;
        assert.equal(x.fallback(), false);
        assert.equal(postSettings(x.plugin, { adFallback: true }).code, 200);
        await x.flush();
        assert.equal(x.fallback(), true);
        assert.equal(x.calls.length, calls);
        assert.equal(getSettings(x.create()).adFallback, true);
    } finally {
        await x.plugin.stop();
    }
});
test('each switch removes only its feature; enabling it again keeps the other connection and shared session',async()=>{
 const x=setup();x.plugin.start();await x.flush();
 for(const [key,off,on] of [['emotes7tv','emotes','filter'],['adFiltering','filter','emotes']]){
  const keptAttachments=x.calls.filter(c=>c.startsWith(on+'-attach')).length;
  const keptStops=x.calls.filter(c=>c===on+'-stop'||c===on+'-detach').length;
  assert.equal(postSettings(x.plugin,{[key]:false}).code,200);await x.flush();
  assert.equal(x.plugin.status()[off].attached,false);assert.equal(x.plugin.status()[on].attached,true);assert.equal(x.plugin.status().connected,true);
  assert.equal(x.calls.filter(c=>c===on+'-stop'||c===on+'-detach').length,keptStops);
  postSettings(x.plugin,{[key]:true});await x.flush();
  assert.equal(x.calls.filter(c=>c.startsWith(on+'-attach')).length,keptAttachments);assert.equal(x.plugin.status().connected,true);
 }
 assert.equal(x.calls.filter(c=>c==='session-start').length,1);await x.plugin.stop();
});
test('both off closes the session after feature cleanup and a quick enable waits for root cleanup',async()=>{
 let release,entered;const stopping=new Promise(r=>entered=r);
 const x=setup(false,false,{sessionStop:()=>{entered();return new Promise(r=>release=r)}});
 x.plugin.start();await x.flush();postSettings(x.plugin,{adFiltering:false,emotes7tv:false,playerControls:false});await stopping;
 assert.ok(x.calls.indexOf('filter-stop')<x.calls.indexOf('session-stop'));assert.ok(x.calls.indexOf('emotes-stop')<x.calls.indexOf('session-stop'));
 postSettings(x.plugin,{emotes7tv:true});x.tick();await x.flush();assert.equal(x.calls.filter(c=>c==='session-start').length,1);
 release();await x.flush();assert.equal(x.calls.filter(c=>c==='session-start').length,2);assert.equal(x.plugin.status().emotes.attached,true);assert.equal(x.plugin.status().filter.attached,false);
 const done=x.plugin.stop();await x.flush();release();await done;
});
test('turning a feature off during attachment cancels it and does not leave a late connection',async()=>{
 const x=setup(true);x.plugin.start();await x.started;
 postSettings(x.plugin,{adFiltering:false});await x.flush();
 assert.equal(x.plugin.status().filter.attached,false);assert.equal(x.plugin.status().emotes.attached,true);assert.equal(x.plugin.status().connected,true);
 assert.equal(x.plugin.status().error,null);await x.plugin.stop();
});
test('an immediate stop/restart cannot activate features from the previous lifecycle',async()=>{
 const x=setup();x.plugin.start();const stopping=x.plugin.stop();x.plugin.start();await stopping;await x.flush();
 assert.equal(x.calls.filter(c=>c==='session-start').length,1);assert.equal(x.plugin.status().connected,true);
 await x.plugin.stop();assert.equal(x.timers.size,0);
});
test('invalid, oversized and failed saves leave persistence and live features unchanged',async()=>{
 const x=setup();x.plugin.start();await x.flush();const calls=x.calls.length;
 for(const body of [null,[],{},true,{adFiltering:'false'},{unknown:true},{adFiltering:false,unknown:true},['{bad json'],['x'.repeat(513),'{}'],['é'.repeat(257)]]){
  const response=postSettings(x.plugin,body);assert.ok([400,413].includes(response.code));assert.equal(response.replies,1);
 }
 x.failSave(true);assert.equal(postSettings(x.plugin,{adFiltering:false}).code,500);await x.flush();
 assert.deepEqual(x.config(),{});assert.deepEqual(getSettings(x.plugin),{adFiltering:true,adFallback:false,emotes7tv:true,adSkipIndicator:false,accountManager:false,accountChooserOnLaunch:true,channelPoints:false,channelPointsIndicator:false,playerControls:true});assert.equal(x.calls.length,calls);assert.equal(x.plugin.status().connected,true);
 x.failSave(false);assert.equal(postSettings(x.plugin,[Buffer.from('{"adFiltering":'),Buffer.from('false}')]).code,200);await x.flush();assert.equal(x.plugin.status().filter.attached,false);await x.plugin.stop();
});
test('aborted or errored settings requests never change config',()=>{
 const x=setup();
 for(const event of ['aborted','error']){
  const req=new EventEmitter();req.method='POST';let replies=0;
  x.plugin.route(req,{writeHead(){},end(){replies++}},'settings');req.emit('data','{"adFiltering":false}');req.emit(event);req.emit('end');
  assert.deepEqual(x.config(),{});assert.equal(replies,event==='error'?1:0);
 }
});

test('a feature toggled off and back on during attachment waits for cleanup before reconnecting',async()=>{
 const x=setup(true);x.plugin.start();await x.started;
 postSettings(x.plugin,{adFiltering:false});postSettings(x.plugin,{adFiltering:true});await x.flush();
 assert.equal(x.plugin.status().connected,true);assert.equal(x.plugin.status().error,null);assert.equal(x.calls.filter(c=>c.startsWith('filter-attach')).length,2);
 assert.equal(x.calls.filter(c=>c==='session-start').length,1);await x.plugin.stop();
});
test('a disabled feature is never started or attached at plugin startup',async()=>{
 const x=setup(false,false,{config:{emotes7tv:false}});x.plugin.start();await x.flush();
 assert.equal(x.plugin.status().connected,true);assert.equal(x.plugin.status().filter.attached,true);assert.equal(x.plugin.status().emotes.attached,false);
 assert.equal(x.calls.some(c=>c==='emotes-start'||c.startsWith('emotes-attach')),false);await x.plugin.stop();
});

test('the indicator preference persists and changes without reconnecting either feature',async()=>{
 const x=setup();assert.equal(x.indicator(),false);x.plugin.start();await x.flush();const calls=x.calls.length;
 postSettings(x.plugin,{adSkipIndicator:true});await x.flush();assert.equal(x.indicator(),true);assert.equal(x.calls.length,calls);assert.equal(x.config().adSkipIndicator,true);
 assert.equal(getSettings(x.create()).adSkipIndicator,true);
 x.failSave(true);assert.equal(postSettings(x.plugin,{adSkipIndicator:false,accountManager:false,accountChooserOnLaunch:true}).code,500);assert.equal(x.indicator(),true);x.failSave(false);
 postSettings(x.plugin,{adFiltering:false,emotes7tv:false,playerControls:false});await x.flush();const stopped=x.calls.length;
 x.tick();await x.flush();assert.equal(x.calls.length,stopped);assert.equal(x.plugin.status().connected,false);await x.plugin.stop();
});

test('automatic channel points can run independently and only follow a ready foreground session', async () => {
    const x = setup(false, false, { config: { adFiltering: false, emotes7tv: false, playerControls: false, channelPointsIndicator: true } });
    x.plugin.start();
    try {
        await x.flush();
        assert.ok(!x.calls.includes('session-start'));
        assert.equal(postSettings(x.plugin, { channelPoints: true }).code, 200);
        await x.flush();
        assert.equal(x.plugin.status().connected, true);
        assert.deepEqual(x.points(), { pointsAttached: true, pointsForeground: true, pointsIndicator: true });
        x.phase({ phase: 'ready', port: 8123, key: '42:123:8123', foreground: false });
        x.notifySessionChange();
        await x.flush();
        assert.equal(x.points().pointsForeground, false);
        assert.equal(x.points().pointsAttached, true);

        assert.equal(postSettings(x.plugin, { channelPointsIndicator: false }).code, 200);
        await x.flush();
        assert.equal(x.points().pointsIndicator, false);
        assert.equal(x.calls.filter(call => call === 'points-attach').length, 1);
        assert.ok(!x.calls.includes('filter-start') && !x.calls.includes('emotes-start'));

        assert.equal(postSettings(x.plugin, { playerControls: true }).code, 200);
        await x.flush();
        assert.equal(x.calls.filter(call => call === 'points-attach').length, 2);
        assert.equal(postSettings(x.plugin, { channelPoints: false }).code, 200);
        await x.flush();
        assert.equal(x.points().pointsForeground, false);
        assert.equal(x.calls.filter(call => call === 'points-attach').length, 3);
        assert.equal(x.plugin.status().connected, true);
    } finally {
        await x.plugin.stop();
    }
});

test('account management keeps the shared session alive on its own and receives foreground and chooser preferences',async()=>{
 const x=setup(false,false,{config:{adFiltering:false,emotes7tv:false,accountManager:true,playerControls:false}});x.plugin.start();await x.flush();
 assert.equal(x.plugin.status().connected,true);assert.equal(x.accounts().foreground,true);assert.equal(x.accounts().chooser,true);assert.equal(x.calls.filter(c=>c==='session-start').length,1);
 postSettings(x.plugin,{accountChooserOnLaunch:false});await x.flush();assert.equal(x.accounts().chooser,false);assert.equal(x.calls.filter(c=>c==='accounts-attach').length,1);
 postSettings(x.plugin,{accountManager:false});await x.flush();assert.equal(x.calls.at(-1),'session-stop');await x.plugin.stop();
});
test('account manager failure leaves filtering and emotes attached and can be disabled independently',async()=>{
 const x=setup(false,false,{config:{accountManager:true},accountsFailure:true});x.plugin.start();await x.flush();
 assert.equal(x.plugin.status().filter.attached,true);assert.equal(x.plugin.status().emotes.attached,true);assert.equal(x.plugin.status().accounts.attached,false);
 postSettings(x.plugin,{accountManager:false});await x.flush();assert.equal(x.plugin.status().connected,true);assert.equal(x.calls.filter(c=>c.startsWith('filter-attach')).length,1);await x.plugin.stop();
});
function accountRequest(plugin,body){
 return new Promise(resolve=>{const req=new EventEmitter();req.method='POST';let code;
  plugin.route(req,{writeHead(v){code=v},end(text){resolve({code,value:JSON.parse(text)})}},'accounts');
  req.emit('data',typeof body==='string'?body:JSON.stringify(body));req.emit('end');
 });
}
test('account HTTP controls reject unknown actions, ports, credentials, invalid IDs and oversized bodies',async()=>{
 const x=setup();
 for(const body of [null,[],{},'{bad',{action:'exec',cmd:'no'},{action:'switch',id:'1;bad'},{action:'switch'},{action:'add',cookies:[]},'x'.repeat(257)])assert.ok([400,413].includes((await accountRequest(x.plugin,body)).code));
 assert.equal((await accountRequest(x.plugin,{action:'add'})).code,409);
 postSettings(x.plugin,{accountManager:true});x.plugin.start();await x.flush();assert.equal((await accountRequest(x.plugin,{action:'switch',id:'2'})).code,200);assert.ok(x.calls.includes('account-action:switch:2'));await x.plugin.stop();
});
