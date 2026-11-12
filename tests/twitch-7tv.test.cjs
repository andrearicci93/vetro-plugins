'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const catalogue=require('../plugins/twitch/public-data.js');

test('catalogue selects declared WebP files and respects active zero-width flags',()=>{
 const data={emotes:[{name:'Alias',flags:1,data:{host:{url:'//cdn.7tv.app/emote/01ID',files:[{name:'2x.avif'},{name:'1x.webp'},{name:'2x.webp'}]}}},{name:'Bad',data:{host:{url:'//evil.test/emote/01ID',files:[{name:'2x.webp'}]}}}]};
 assert.deepEqual(catalogue.normalizeEmotes(data),[{name:'Alias',url:'https://cdn.7tv.app/emote/01ID/2x.webp',zeroWidth:true}]);
});
test('public lookup uses no account auth, caches data and handles missing channel emotes',async()=>{
 const calls=[],provider=catalogue.createEmoteCatalogue(async(host,path,body)=>{
  calls.push({host,path,body});if(host==='gql.twitch.tv')return{data:{user:{id:'12345'}}};return{};
 });
 assert.deepEqual(await provider.global(),[]);await provider.global();assert.equal(calls.length,1);
 assert.deepEqual(await provider.channel('example'),[]);await provider.channel('example');assert.equal(calls.length,3);
 assert.equal(calls[1].body.variables.login,'example');assert.equal(calls[2].path,'/v3/users/twitch/12345');provider.stop();
});
test('cancelled inspector attachment removes even late document registration',async()=>{
 const inspector=require('../plugins/twitch/inspector-client.js'),list=inspector.listTargets,connect=inspector.connect;
 let announce,release;const ready=new Promise(resolve=>announce=resolve),calls=[];
 inspector.listTargets=async()=>[{type:'page',url:'https://samsung.tv.twitch.tv/',webSocketDebuggerUrl:'local'}];
 inspector.connect=async()=>({call:async(m,p)=>{calls.push([m,p]);if(m==='Page.addScriptToEvaluateOnNewDocument'){announce();return new Promise(resolve=>release=resolve)}return{}},close(){calls.push(['close'])}});
 try{
  const plugin=require('../plugins/twitch/emotes/index.js')();plugin.start();
  const done=plugin.attach(7011).then(()=>true,()=>false);
  await ready;const stop=plugin.stop();release({identifier:'late'});await stop;assert.equal(await done,false);
  assert.ok(calls.some(([m,p])=>m==='Page.removeScriptToEvaluateOnNewDocument'&&p.identifier==='late'));
  assert.equal(plugin.status().attached,false);
 }finally{inspector.listTargets=list;inspector.connect=connect}
});
test('malformed catalogue items are ignored and stopped providers cannot issue requests',async()=>{
 assert.deepEqual(catalogue.normalizeEmotes({emotes:{unexpected:true}}),[]);
 assert.deepEqual(catalogue.normalizeEmotes({emotes:[null,{}, {name:'bad',data:{host:{url:'//cdn.7tv.app/emote/01ID',files:[null]}}}]}),[]);
 let calls=0;const provider=catalogue.createEmoteCatalogue(async()=>{calls++;return{}});provider.stop();await assert.rejects(provider.global(),/Stopped/);assert.equal(calls,0);
});
test('a channel named global does not reuse the global emote catalogue cache',async()=>{
 const calls=[],provider=catalogue.createEmoteCatalogue(async(h,p)=>{calls.push([h,p]);return h==='gql.twitch.tv'?{data:{user:{id:'12345'}}}:{};});
 await provider.global();await provider.channel('global');assert.equal(calls.length,3);provider.stop();
});
