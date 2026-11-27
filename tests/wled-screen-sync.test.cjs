'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname,'..');

test('WLED helper payload verification rejects source mismatch', () => {
    const {verifyPayload} = require('../scripts/build-wled-screen-sync-helper.cjs');
    const rebuilt = Buffer.from('Colour.dll fixture');
    assert.throws(() => verifyPayload(rebuilt, Buffer.from('different').toString('base64')), /SHA-256 mismatch/);
});

test('WLED source has no WLED Freqwave mode and uses runtime files', () => {
    const files = ['index.js','settings.js','Colour.cs','controls.json','panel.html'].map(name => fs.readFileSync(path.join(root,'plugins/wled-screen-sync',name),'utf8'));
    const joined = files.join('\n');
    assert(!/Freqwave|Lighting.?===?.?['"]audio|WLED audio sync/.test(joined));
    assert(!/\/tmp\/ambilight-studio-(rate|preview)/.test(joined));
    assert(joined.includes('runtimeDir'));
    assert(joined.includes('screen-audio'));
});

test('WLED helper has platform and 32-bit native guards', () => {
    const colour = fs.readFileSync(path.join(root,'plugins/wled-screen-sync/Colour.cs'),'utf8');
    const plane = fs.readFileSync(path.join(root,'plugins/wled-screen-sync/VideoPlaneCapture.cs'),'utf8');
    assert.match(colour,/--check-platform/);
    assert.match(colour,/IntPtr\.Size!=4/);
    assert.match(plane,/IntPtr\.Size != 4/);
});

test('video color format is probed before capture and retained after reset', () => {
    const plane = fs.readFileSync(path.join(root,'plugins/wled-screen-sync/VideoPlaneCapture.cs'),'utf8');
    const init = plane.indexOf('public static string Init()');
    const initEnd = plane.indexOf('public static string Reset()',init);
    const capture = plane.indexOf('public static VideoPlaneResult Capture()');
    const probe = plane.indexOf('if (!_cfProbed) ProbeColorFormatOnce();',capture);
    const nativeCapture = plane.indexOf('r.Rc = _call(ReqW, ReqH, _param);',capture);
    assert(init>=0 && initEnd>init && capture>initEnd);
    assert.match(plane.slice(init,initEnd),/if \(_cfProbed\) Marshal\.WriteInt32\(_param, OffColorFormat, ChosenColorFormat\);/);
    assert(probe>capture && probe<nativeCapture);
});

const http = require('node:http');
const events = require('node:events');
const os = require('node:os');
const controller = require('../plugins/wled-screen-sync/controller');

test('controller deadlines, oversized bodies and interrupted responses complete once', async t => {
    const srv=http.createServer((req,res)=>{
        if(req.url==='/large')res.end(Buffer.alloc(65537));
        else if(req.url==='/partial'){res.write('part'); setImmediate(()=>res.destroy());}
    });
    await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
    t.after(()=>srv.close());
    for(const path of ['/large','/partial','/silent']){
        let calls=0;
        const error=await new Promise(resolve=>controller('127.0.0.1',path,150,null,e=>{
            calls++;resolve(e);
        },srv.address().port));
        assert(error instanceof Error);
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(calls,1);
    }
});

function harness(t, initial) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-check-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    let data={...initial}, failRestore=false, rejectPowerOn, rejectInfo;
    const writes=[], commands=[], requests=[], power=new Map();
    t.mock.method(http,'request',(opts,onResponse)=>{
        const req=new events.EventEmitter();
        req.setTimeout=req.destroy=()=>{};
        req.end=body=>queueMicrotask(()=>{
            requests.push(opts);
            const res=new events.EventEmitter();
            res.statusCode=200;
            let result=opts.path==='/json/info'
                ? {brand:opts.host===rejectInfo?'Other':'WLED',ver:'0.15.0',leds:{count:538}}
                : {on:power.get(opts.host)||false,bri:60,seg:[{id:0,fx:77}]};
            if(body){
                const patch=JSON.parse(body); writes.push(patch);
                if(failRestore && patch.on===false)res.statusCode=503;
                const accepted=res.statusCode===200 && !(patch.on===true && opts.host===rejectPowerOn);
                if(accepted && typeof patch.on==='boolean')power.set(opts.host,patch.on);
                result={success:accepted};
            }
            onResponse(res);res.emit('data',Buffer.from(JSON.stringify(result)));res.emit('end');
        });
        return req;
    });
    return {ctx:{dir,config:{get:()=>structuredClone(data),set:v=>{data=structuredClone(v);}},
        execute:async cmd=>{commands.push(cmd);return {exit_code:0,stdout:'inactive'};}},
        writes,commands,requests,power,fail:v=>{failRestore=v;},
        rejectPowerOn:host=>{rejectPowerOn=host;},rejectInfo:host=>{rejectInfo=host;}};
}

test('power snapshot survives lost stop, retries failed restore, never writes segment edits',async t=>{
    const h=harness(t,{Wled:'192.168.2.1'}), create=require('../plugins/wled-screen-sync/settings');
    const instance=()=>create(h.ctx,()=>({}),()=>{});
    await instance().start();
    assert.deepEqual(h.ctx.config.get().savedWledStates,{'192.168.2.1':{on:false}});
    const restart=instance();await restart.start();
    h.fail(true);await assert.rejects(restart.stop(),/503/);
    assert.deepEqual(h.ctx.config.get().savedWledStates,{'192.168.2.1':{on:false}});
    h.fail(false);await restart.stop();
    assert.deepEqual(h.ctx.config.get().savedWledStates,{});
    assert.deepEqual(h.writes,[{on:true},{on:false},{on:false}]);
});

test('a launch acknowledgement does not reset the five-start crash budget',async t=>{
    const h=harness(t,{Wled:'192.168.2.1',Lighting:'tv-audio'});
    const timers=new Map();
    t.mock.method(global,'setInterval',(fn,ms)=>{timers.set(ms,fn);return ms;});
    t.mock.method(global,'clearInterval',ms=>timers.delete(ms));
    let now=50000;
    t.mock.method(Date,'now',()=>now);
    const shard=require('../plugins/wled-screen-sync')(h.ctx);
    await shard.start();
    for(let i=0;i<20;i++){now+=65000;await timers.get(5000)();timers.get(2000)();}
    assert.equal(h.commands.filter(cmd=>cmd.includes('systemd-run')).length,5);
    assert.equal(shard.status().state,'failed');
    assert(!h.commands.some(cmd=>cmd.startsWith('busctl') || cmd.startsWith('systemctl stop')));
    await shard.stop();
});

test('WLED validation failure keeps capture stopped and Start validates again before launch',async t=>{
    const address='192.168.2.1', h=harness(t,{Wled:address});
    h.rejectInfo(address);
    const shard=require('../plugins/wled-screen-sync')(h.ctx);
    t.after(()=>shard.stop());
    await shard.start();
    assert.equal(shard.status().state,'failed');
    assert.match(shard.status().stdout,/Press Start to retry/);
    assert(!h.commands.some(command=>command.includes('systemd-run')));
    assert(!fs.existsSync(path.join(h.ctx.dir,'runtime','capture-heartbeat')));

    let checks=h.requests.filter(request=>request.path==='/json/info').length;
    const refused=await routeCall(shard.route,'POST','capture-action',{action:'start'});
    assert.equal(refused.body.ok,false);
    assert(h.requests.filter(request=>request.path==='/json/info').length>checks);
    assert(!h.commands.some(command=>command.includes('systemd-run')));

    h.rejectInfo(null);
    checks=h.requests.filter(request=>request.path==='/json/info').length;
    const started=await routeCall(shard.route,'POST','capture-action',{action:'start'});
    assert.equal(started.body.ok,true);
    assert(h.requests.filter(request=>request.path==='/json/info').length>checks);
    assert(h.commands.some(command=>command.includes('systemd-run')));
});

test('loopback target does not start the helper or poll HDR',async t=>{
    const h=harness(t,{Wled:'127.0.0.1'});
    const shard=require('../plugins/wled-screen-sync')(h.ctx);
    await shard.start();await shard.stop();
    assert(!h.commands.some(cmd=>cmd.includes('systemd-run')||cmd.startsWith('busctl')));
    assert.equal(h.writes.length,0);
});

function routeCall(fn, method, sub, payload) {
    return new Promise(resolve => {
        const req = new events.EventEmitter();
        req.method = method;
        req.destroy = () => {};
        let code = 200, out = '';
        const res = {
            writeHead(c) { code = c; },
            end(data) { out = data ? data.toString() : ''; resolve({code, body: out ? JSON.parse(out) : null}); }
        };
        fn(req, res, sub);
        if (payload !== undefined) {
            req.emit('data', Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)));
            req.emit('end');
        }
    });
}

test('wled-probe and settings accept only private WLED targets and preserve explicit side counts', async t => {
    const h = harness(t, {Wled: '127.0.0.1'});
    const create = require('../plugins/wled-screen-sync/settings');
    const route = create(h.ctx, () => ({state: 'active'}), () => {});
    for (const bad of ['127.0.0.1', '0.0.0.0', '169.254.1.1', '224.0.0.1', '255.255.255.255', '192.0.2.1', '172.32.0.1', '192.168.1.01']) {
        const res = await routeCall(route, 'POST', 'wled-probe', {address: bad});
        assert.equal(res.code, 400);
    }
    const badSetting = await routeCall(route, 'POST', 'settings', {Wled: '192.0.2.1'});
    assert.equal(badSetting.code, 400);
    assert.equal(h.requests.length, 0);
    h.rejectInfo('10.0.0.1');
    assert.equal((await routeCall(route, 'POST', 'settings', {Wled: '10.0.0.1'})).code, 400);
    assert.equal((await routeCall(route, 'POST', 'wled-probe', {address: '10.0.0.1'})).code, 400);
    assert(h.requests.every(request=>request.path==='/json/info'));
    assert.equal(h.writes.length, 0);
    const custom = await routeCall(route, 'POST', 'settings', {
        Wled: '192.168.2.50', TopCount: 50, RightCount: 10, BottomCount: 0, LeftCount: 10
    });
    assert.equal(custom.code, 200);
    assert.equal(custom.body.values.TopCount, 50);
    assert.equal(custom.body.values.BottomCount, 0);
    assert.equal(custom.body.values.Leds, 70);
});

test('unreachable prior WLED controller does not lock out target switching and stale preview is cleared', async t => {
    const h = harness(t, {Wled: '192.168.2.1', savedWledStates: {'192.168.2.1': {on: false}}});
    h.fail(true);
    const create = require('../plugins/wled-screen-sync/settings');
    let liveState = {state: 'stopped'};
    const route = create(h.ctx, () => liveState, () => {});
    const sw = await routeCall(route, 'POST', 'settings', {Wled: '127.0.0.1'});
    assert.equal(sw.code, 200);
    assert.equal(h.ctx.config.get().Wled, '127.0.0.1');
    assert.deepEqual(h.ctx.config.get().savedWledStates, {'192.168.2.1': {on: false}});

    fs.mkdirSync(path.join(h.ctx.dir, 'runtime'), {recursive: true});
    const previewPath = path.join(h.ctx.dir, 'runtime', 'preview.b64');
    fs.writeFileSync(previewPath, Buffer.alloc(144, 0xaa).toString('base64'));
    const stoppedPrev = await routeCall(route, 'GET', 'preview');
    assert.equal(stoppedPrev.body.rgb, '');
    liveState = {state: 'active'};
    const oldTime = new Date(Date.now() - 10000);
    fs.utimesSync(previewPath, oldTime, oldTime);
    const stalePrev = await routeCall(route, 'GET', 'preview');
    assert.equal(stalePrev.body.rgb, '');
});

test('brightness changes never write controller state', async t => {
    const address='192.168.2.1';
    const h=harness(t,{Wled:address});
    h.power.set(address,true);
    const route=require('../plugins/wled-screen-sync/settings')(h.ctx,()=>({}));
    await route.start();
    const result=await routeCall(route,'POST','settings',{Brightness:40});
    assert.equal(result.code,200);
    assert.equal(h.ctx.config.get().Brightness,40);
    await route.stop();
    assert.deepEqual(h.writes,[]);
});

test('a rejected replacement leaves the original powered on and keeps its snapshot', async t => {
    const previous='192.168.2.1', next='192.168.2.2';
    const h=harness(t,{Wled:previous});
    h.rejectPowerOn(next);
    const route=require('../plugins/wled-screen-sync/settings')(h.ctx,()=>({}));
    await route.start();
    const result=await routeCall(route,'POST','settings',{Wled:next});
    assert.equal(result.code,400);
    assert.equal(h.ctx.config.get().Wled,previous);
    assert.equal(h.power.get(previous),true);
    assert.equal(h.power.get(next),false);
    assert.deepEqual(h.ctx.config.get().savedWledStates,{[previous]:{on:false}});
});

test('capture stop and restart failures revoke the heartbeat and report failure', async t => {
    const h=harness(t,{Wled:'192.168.2.1',Lighting:'tv-audio'});
    let timedOut=false;
    h.ctx.execute=async cmd=>{
        h.commands.push(cmd);
        if(cmd.startsWith('systemctl stop'))return {exit_code:timedOut?0:1,timed_out:timedOut};
        return {exit_code:0,stdout:'active'};
    };
    const shard=require('../plugins/wled-screen-sync')(h.ctx);
    t.after(()=>shard.stop());
    await shard.start();
    const heartbeat=path.join(h.ctx.dir,'runtime','capture-heartbeat');
    assert(fs.existsSync(heartbeat));
    const restart=await routeCall(shard.route,'POST','capture-action',{action:'restart'});
    assert.equal(restart.code,500);
    assert.equal(shard.status().state,'stop-failed');
    assert(!fs.existsSync(heartbeat));
    assert(!h.commands.some(command=>command.includes('systemd-run')));
    assert.equal((await routeCall(shard.route,'POST','capture-action',{action:'start'})).body.ok,true);
    assert(fs.existsSync(heartbeat));
    timedOut=true;
    const stop=await routeCall(shard.route,'POST','capture-action',{action:'stop'});
    assert.equal(stop.code,500);
    assert.match(stop.body.error,/timed out/);
    assert(!fs.existsSync(heartbeat));
});
