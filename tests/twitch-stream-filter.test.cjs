'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../plugins/twitch/filter/playlist-filter.js');
const inspector = require('../plugins/twitch/inspector-client.js');
const MASTER = 'https://usher.ttvnw.net/api/channel/hls/example.m3u8?token=original&allow_source=true';
const MEDIA = 'https://video-weaver.example.ttvnw.net/live/main.m3u8';
const BACKUP = 'https://video-weaver.example.ttvnw.net/backup/index.m3u8';
const manifest = url => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1920x1080,FRAME-RATE=60\n' + url;
const clean = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-PROGRAM-DATE-TIME:2026-11-07T00:00:00.000Z\n#EXTINF:2,\nsegment.ts\n';
const advert = clean + '#EXT-X-DATERANGE:ID="ad",CLASS="twitch-stitched-ad",START-DATE="2026-11-07T00:00:00Z"\n';
function fixture(opts = {}) {
    const calls = [];
    const original = async function(address, options) {
        calls.push({ address, options });
        let text;
        if (address === MASTER) text = opts.wrongCodec ? manifest(MEDIA).replace('FRAME-RATE=60', 'FRAME-RATE=60,CODECS="avc1.64002A,mp4a.40.2"') : manifest(MEDIA);
        else if (address === MEDIA) text = opts.preroll ? advert : clean;
        else if (address === 'https://gql.twitch.tv/gql') {
            assert.equal(options.headers.Authorization, undefined);
            assert.equal(JSON.parse(options.body).variables.login, 'example');
            if (opts.fail) throw new Error('offline');
            text = JSON.stringify({data:{streamPlaybackAccessToken:{value:'alternate',signature:'signature'}}});
        } else if (address.startsWith('https://usher.ttvnw.net/')) text = opts.wrongQuality ? manifest(BACKUP).replace('1920x1080', '640x360') : opts.wrongCodec ? manifest(BACKUP).replace('FRAME-RATE=60', 'FRAME-RATE=60,CODECS="hev1.1.6.L123,mp4a.40.2"') : manifest(BACKUP);
        else if (address === BACKUP) {
            if (opts.backupReady) await opts.backupReady;
            text = opts.backupAds ? advert : opts.backup || clean;
        }
        else text = 'unchanged';
        return text;
    };
    const processor = engine.create(original);
    const intercept = async address => processor.replacementFor(address, address === MEDIA ? opts.main || advert : await original(address));
    return { processor, intercept, calls, requestText: original };
}
test('clean live media is unchanged and needs no auxiliary request', async () => {
    const f = fixture({main:clean}); await f.intercept(MASTER); const r = await f.intercept(MEDIA);
    assert.equal(r, null); assert.equal(f.calls.length, 2); f.processor.stop();
});
test('a preroll can switch rendition URLs before the player adopts the media timeline', async () => {
    const f = fixture({ preroll: true, backup: clean.replace('SEQUENCE:100', 'SEQUENCE:4326') });
    const replacement = await f.intercept(MASTER);
    assert.match(replacement, /backup\/index\.m3u8/);
    assert.equal(f.processor.stats.prerollsDetected, 1);
    assert.equal(f.processor.stats.prerollsReplaced, 1);
    assert.equal(f.processor.stats.timelineMismatches, 0);
    f.processor.stop();
});
test('a preroll leaves the original master when clean alternatives would drop a rendition', async () => {
    const f = fixture({ preroll: true });
    const master = manifest(MEDIA) + '\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=2560x1440,FRAME-RATE=60\n' +
        new URL('1440p.m3u8', MEDIA).href;
    assert.equal(await f.processor.replacementFor(MASTER, master), null);
    assert.equal(f.processor.stats.prerollsDetected, 1);
    assert.equal(f.processor.stats.prerollsReplaced, 0);
    f.processor.stop();
});
test('a master refresh cannot replace the timeline after media playback has started', async () => {
    const f = fixture({ preroll: true, backup: clean.replace('SEQUENCE:100', 'SEQUENCE:4326') });
    try {
        const master = await f.intercept(MASTER);
        const alternateMaster = f.calls.find(call => call.address.startsWith('https://usher.ttvnw.net/') && call.address !== MASTER).address;
        await f.processor.replacementFor(BACKUP, clean.replace('SEQUENCE:100', 'SEQUENCE:4326'));
        const requests = f.calls.length;
        assert.equal(await f.processor.replacementFor(MASTER, manifest(MEDIA)), null);
        assert.equal(await f.processor.replacementFor(alternateMaster, master), null);
        assert.equal(f.calls.length, requests);
        assert.equal(f.processor.stats.prerollsReplaced, 1);
    } finally {
        f.processor.stop();
    }
});
test('a pending preroll search stops replacing the master if a media response arrives first', async () => {
    let release, ready;
    const pending = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { ready = resolve; });
    const f = fixture({ preroll: true });
    const processor = engine.create(async (address, options) => {
        const text = await f.requestText(address, options);
        if (address === BACKUP) { ready(); await pending; }
        return text;
    });
    try {
        const replacement = processor.replacementFor(MASTER, manifest(MEDIA));
        await requested;
        assert.equal(await processor.replacementFor(MEDIA, clean), null);
        release();
        assert.equal(await replacement, null);
        assert.equal(processor.stats.prerollsReplaced, 0);
    } finally {
        release();
        processor.stop();
        f.processor.stop();
    }
});
test('marked ads use matching clean backup with absolute segment/key/map URIs', async () => {
    const f = fixture(); await f.intercept(MASTER); const body = await f.intercept(MEDIA);
    assert.match(body,/https:\/\/video-weaver.example.ttvnw.net\/backup\/segment.ts/);
    assert.match(body,/URI="https:\/\/video-weaver.example.ttvnw.net\/backup\/key.bin"/);
    assert.match(body,/URI="https:\/\/video-weaver.example.ttvnw.net\/backup\/init.mp4"/);
    assert.equal(f.processor.stats.replacements,1);
    const alternateMaster = new URL(f.calls.find(call => call.address.startsWith('https://usher.ttvnw.net/') && call.address !== MASTER).address);
    assert.equal(alternateMaster.searchParams.get('token'), 'alternate');
    assert.equal(alternateMaster.searchParams.get('sig'), 'signature');
    assert.equal(alternateMaster.searchParams.get('allow_source'), 'true');
    const tokens = f.calls.filter(c => c.address.endsWith('/gql')).length;
    await f.intercept(MEDIA); assert.equal(f.calls.filter(c => c.address.endsWith('/gql')).length,tokens);
    f.processor.stop();
});
test('failed alternatives return original response, bounded retries and cooldown', async () => {
    const f = fixture({fail:true}); await f.intercept(MASTER); const r = await f.intercept(MEDIA);
    assert.equal(r, null); assert.equal(f.calls.filter(c => c.address.endsWith('/gql')).length,2);
    await f.intercept(MEDIA); assert.equal(f.calls.filter(c => c.address.endsWith('/gql')).length,2); f.processor.stop();
});
test('ad-filled alternatives and incompatible quality or codecs are never substituted', async () => {
    for (const opts of [{backupAds:true},{wrongQuality:true},{wrongCodec:true}]) {
        const f = fixture(opts); await f.intercept(MASTER); const r = await f.intercept(MEDIA);
        assert.equal(r, null); assert.equal(f.processor.stats.replacements,0);
        if (opts.wrongQuality || opts.wrongCodec) assert.ok(!f.calls.some(c => c.address === BACKUP));
        f.processor.stop();
    }
});
test('a substitute must preserve the same segment window, time anchor and discontinuity sequence', async () => {
    const date = '#EXT-X-PROGRAM-DATE-TIME:2026-11-07T00:00:00.000Z\n';
    for (const backup of [clean.replace('SEQUENCE:100', 'SEQUENCE:25'), clean.replace('00:00:00.000Z', '00:00:20.000Z'),
        clean.replace(date, ''), clean.replace(date, '#EXT-X-DISCONTINUITY-SEQUENCE:1\n' + date)]) {
        const f = fixture({ backup });
        await f.intercept(MASTER);
        assert.equal(await f.intercept(MEDIA), null);
        assert.equal(f.processor.stats.replacements, 0);
        f.processor.stop();
    }
    const undated = fixture({ main: advert.replace(date, ''), backup: clean.replace(date, '').replace('segment.ts', new URL('segment.ts', MEDIA).href) });
    await undated.intercept(MASTER);
    await undated.intercept(MEDIA);
    assert.equal(undated.processor.stats.replacements, 1);
    undated.processor.stop();
});
test('unknown manifests, VOD and deceptive domains are passed through', async () => {
    const f = fixture();
    for (const address of ['https://ttvnw.net.evil.test/a.m3u8','https://unrelated.test/a.m3u8','https://usher.ttvnw.net/vod/123.m3u8',MEDIA]) await f.intercept(address);
    assert.equal(f.calls.length,3); assert.equal(f.processor.stats.replacements,0); f.processor.stop();
});
test('concurrent refreshes share a search but still validate their own segment windows', async () => {
    let release;
    const backupReady = new Promise(resolve => { release = resolve; });
    const f = fixture({ backupReady });
    await f.intercept(MASTER);
    const matching = f.processor.replacementFor(MEDIA, advert);
    const changed = f.processor.replacementFor(MEDIA, advert.replace('SEQUENCE:100', 'SEQUENCE:101'));
    release();
    assert.match(await matching, /backup\/segment\.ts/);
    assert.equal(await changed, null);
    assert.equal(f.calls.filter(call => call.address === BACKUP).length, 1);
    f.processor.stop();
});
test('stopping while a replacement is pending preserves original response', async () => {
    const f = fixture(); await f.intercept(MASTER);
    const promise = f.intercept(MEDIA); f.processor.stop();
    assert.equal(await promise, null);
});
test('inspector accepts only local socket paths and hosted Twitch TV pages', () => {
    assert.equal(inspector.isTwitchPage({type:'page',url:'https://pewter-example.tv.twitch.tv/app-shell'}),true);
    for (const url of ['https://tv.twitch.tv.evil.test/','https://www.twitch.tv/','file:///app.html','https://user@tv.twitch.tv/']) assert.equal(inspector.isTwitchPage({type:'page',url}),false);
    assert.equal(inspector.localWebSocketPath('ws://127.0.0.1:7011/devtools/page/abcd',7011),'/devtools/page/abcd');
    for (const address of ['ws://example.test:7011/devtools/page/abc','ws://127.0.0.1:7011/arbitrary','ws://127.0.0.1:7012/devtools/page/abc']) assert.throws(() => inspector.localWebSocketPath(address,7011));
});
test('disable during network registration removes interception and prevents reload', async () => {
    const originalListing=inspector.listTargets, originalConnect=inspector.connect;
    const calls=[]; let release, announce;
    const registered = new Promise(resolve => {announce=resolve});
    const c={on:()=>()=>{},call:async (method,params) => {
        calls.push([method,params]);
        if(method==='Network.setRequestInterception'&&params.patterns.length){announce(); return new Promise(resolve => {release=resolve});}
        return {};
    },close(){calls.push(['close'])}};
    inspector.listTargets=async () => [{type:'page',url:'https://samsung.tv.twitch.tv/',webSocketDebuggerUrl:'local'}];
    inspector.connect=async () => c;
    try {
        const instance=require('../plugins/twitch/filter/index.js')();instance.start();
        const finished=instance.attach(7011).then(()=>true,()=>false);
        await registered; const stopped=instance.stop();release({});
        await stopped;assert.equal(await finished,false);
        assert.ok(calls.some(([m,p]) => m==='Network.setRequestInterception'&&p.patterns.length===0));
        assert.ok(!calls.some(([m]) => m==='Page.reload'));
        assert.ok(calls.some(([m]) => m==='close'));
        assert.equal(instance.status().attached,false);
    } finally {inspector.listTargets=originalListing;inspector.connect=originalConnect;}
});
test('CDP transport validates upgrade and handles fragmented replies and ping', async () => {
    const http=require('node:http'), crypto=require('node:crypto');
    const server=http.createServer();let peer;
    const net=require('node:net'), connect=net.connect;
    // Bind the local fixture to 127.0.0.1; the production client connects to 127.0.0.2.
    net.connect=function(options){assert.equal(options.host,'127.0.0.2');return connect.call(net,Object.assign({},options,{host:'127.0.0.1'}));};
    function outgoing(payload,opcode=1,fin=true){const b=Buffer.from(payload);assert.ok(b.length<126);return Buffer.concat([Buffer.from([(fin?128:0)|opcode,b.length]),b]);}
    server.on('upgrade',(req,socket)=>{
        peer=socket;
        const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
        let input=Buffer.alloc(0);
        socket.on('data',chunk=>{
            input=Buffer.concat([input,chunk]);
            while(input.length>=2){
                const opcode=input[0]&15;let size=input[1]&127,off=2;
                if(size===126){if(input.length<4)return;size=input.readUInt16BE(2);off=4;}
                if(input.length<off+4+size)return;
                const mask=input.subarray(off,off+4),data=input.subarray(off+4,off+4+size);input=input.subarray(off+4+size);
                for(let i=0;i<data.length;i++)data[i]^=mask[i%4];
                if(opcode!==1)continue;
                const msg=JSON.parse(data.toString()),answer=JSON.stringify({id:msg.id,result:{identifier:'fixture'}});
                socket.write(outgoing(answer.slice(0,12),1,false));socket.write(outgoing('ping',9));socket.write(outgoing(answer.slice(12),0,true));
            }
        });
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    let client;
    try{
        const port=server.address().port;client=await inspector.connect('ws://127.0.0.1:'+port+'/devtools/page/fixture',port);
        assert.deepEqual(await client.call('Page.enable'),{identifier:'fixture'});
    }finally{net.connect=connect;if(client)client.close();if(peer)peer.destroy();await new Promise(resolve=>server.close(resolve));}
});
test('Chromium XHR interception processes masters and substitutes a clean ad-free media response',async()=>{
    const network=require('../plugins/twitch/filter/network-interceptor.js');const commands=[];let onEvent;
    const bodies={master:manifest(MEDIA),media:advert};
    const client={on(method,fn){assert.equal(method,'Network.requestIntercepted');onEvent=fn;return()=>{onEvent=null}},async call(method,args){
        commands.push([method,args]);
        if(method==='Network.getResponseBodyForInterception')return {body:bodies[args.interceptionId],base64Encoded:false};return {};
    }};
    const fixtureScope=fixture();
    const filter=network.create(client,fixtureScope.requestText);await filter.start();
    async function emit(id,url){onEvent({interceptionId:id,request:{url},responseStatusCode:200,responseHeaders:{'Access-Control-Allow-Origin':'*','Content-Encoding':'gzip','ETag':'stale'}});for(let i=0;i<6;i++)await new Promise(setImmediate);}
    await emit('master',MASTER);await emit('media',MEDIA);
    const forwarded=commands.filter(([m])=>m==='Network.continueInterceptedRequest');
    assert.equal(forwarded[0][1].rawResponse,undefined);
    const raw=Buffer.from(forwarded[1][1].rawResponse,'base64').toString();
    assert.match(raw,/HTTP\/1.1 200 OK/);assert.match(raw,/Access-Control-Allow-Origin: \*/);assert.doesNotMatch(raw,/Content-Encoding:|ETag:/i);
    assert.match(raw,/backup\/segment.ts/);assert.equal(filter.status().filter.replacements,1);
    await filter.stop();assert.equal(filter.status().inFlight,0);assert.equal(onEvent,null);
});
test('Chromium XHR errors and non-200 responses continue the original request',async()=>{
    const network=require('../plugins/twitch/filter/network-interceptor.js');let handler;const forwarded=[];
    const client={on(m,fn){handler=fn;return()=>{}},async call(m,p){if(m==='Network.getResponseBodyForInterception')throw new Error('body unavailable');if(m==='Network.continueInterceptedRequest')forwarded.push(p);return {}}};
    const filter=network.create(client);await filter.start();
    handler({interceptionId:'bad',request:{url:MEDIA},responseStatusCode:200});
    handler({interceptionId:'offline',request:{url:MEDIA},responseStatusCode:404});
    for(let i=0;i<4;i++)await new Promise(setImmediate);
    assert.equal(forwarded.length,2);assert.ok(forwarded.every(p=>!p.rawResponse));await filter.stop();
});
test('automatic attachment registers only network interception and never reloads the app',async()=>{
    const originalListing=inspector.listTargets,originalConnect=inspector.connect,calls=[];
    inspector.listTargets=async()=>[{type:'page',url:'https://samsung.tv.twitch.tv/',webSocketDebuggerUrl:'local'}];
    inspector.connect=async()=>({on:()=>()=>{},call:async(m,p)=>{calls.push([m,p]);return{}},close(){}});
    try{
        const instance=require('../plugins/twitch/filter/index.js')();instance.start();
        await instance.attach(7011);assert.ok(!calls.some(([m])=>/^Page\./.test(m)));await instance.stop();
        assert.ok(calls.some(([m,p])=>m==='Network.setRequestInterception'&&p.patterns.length===0));
    }finally{inspector.listTargets=originalListing;inspector.connect=originalConnect;}
});

test('replacement notifications require a successful CDP handoff and do not affect request continuation',async()=>{
 const network=require('../plugins/twitch/filter/network-interceptor.js');
 for(const scenario of ['replacement','clean','no-alternative','failed-handoff','stopped-before-ack','throwing-callback']){
  let handler,release,notifications=0;const forwarded=[];
  const bodies={master:manifest(MEDIA),media:scenario==='clean'?clean:advert};
  const client={on(m,fn){handler=fn;return()=>{}},async call(m,p){
   if(m==='Network.getResponseBodyForInterception')return{body:bodies[p.interceptionId]};
   if(m==='Network.continueInterceptedRequest'){
    forwarded.push(p);
    if(p.rawResponse&&scenario==='failed-handoff')throw Error('Handoff failed');
    if(p.rawResponse&&scenario==='stopped-before-ack')await new Promise(r=>release=r);
   }
   return{};
  }};
  const f=fixture({backupAds:scenario==='no-alternative'});
  const filter=network.create(client,f.requestText,()=>{notifications++;if(scenario==='throwing-callback')throw Error('Optional UI error')});
  await filter.start();
  async function emit(id,url){handler({interceptionId:id,request:{url},responseStatusCode:200});for(let i=0;i<8;i++)await new Promise(setImmediate)}
  await emit('master',MASTER);assert.equal(notifications,0);await emit('media',MEDIA);
  if(scenario==='stopped-before-ack'){const stopping=filter.stop();release();await stopping}
  assert.equal(notifications,['replacement','throwing-callback'].includes(scenario)?1:0,scenario);
  assert.equal(forwarded.length,scenario==='failed-handoff'?3:2,scenario);assert.equal(filter.status().inFlight,0,scenario);
  if(scenario==='failed-handoff')assert.deepEqual(forwarded.at(-1),{interceptionId:'media'});
  assert.equal(filter.status().bodyFailures,scenario==='failed-handoff'?1:0,scenario);
  await filter.stop();f.processor.stop();
 }
});
