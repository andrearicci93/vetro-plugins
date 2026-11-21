'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const page=require('../plugins/twitch/emotes/chat-renderer.js'),catalogue=require('../plugins/twitch/public-data.js');
const URL='https://cdn.7tv.app/emote/01TEST/2x.webp';
function fixture(text='Hello Clap'){
 const dom=new JSDOM('<main><aside><div data-a-target="chat-line-message-body"></div></aside></main>',{url:'https://samsung.tv.twitch.tv/example',runScripts:'outside-only'});
 const w=dom.window,body=w.document.querySelector('[data-a-target]'),anchor=w.document.createTextNode(text);body.appendChild(anchor);w.eval(page.source);
 const api=w.__vetro7TV;return{dom,w,body,anchor,api,close(){if(w.__vetro7TV)w.__vetro7TV.stop();w.close()}};
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,140));
test('renders exact emote tokens while retaining original React text node and native images',()=>{
 const f=fixture('Clap Clap! xClap <b>Clap</b>');try{
  const native=f.w.document.createElement('img');native.alt='Kappa';f.body.appendChild(native);
  f.api.set([{name:'Clap',url:URL}]);assert.equal(f.body.querySelectorAll('img[data-vetro-7tv]').length,1);
  assert.equal(f.anchor.parentNode,f.body);assert.equal(f.anchor.nodeValue,'');assert.equal(f.body.querySelector('img:not([data-vetro-7tv])'),native);
  assert.equal(f.body.querySelector('b'),null);f.api.stop();assert.equal(f.anchor.nodeValue,'Clap Clap! xClap <b>Clap</b>');assert.equal(f.body.querySelectorAll('img[data-vetro-7tv]').length,0);
 }finally{f.close()}
});
test('does not replace usernames, links, buttons, unknown text or untrusted image URLs',()=>{
 const f=fixture('Clap');try{
  f.body.insertAdjacentHTML('beforeend','<a>Clap</a><span role="button">Clap</span><span data-a-target="chat-message-username">Clap</span>');
  f.api.set([{name:'Clap',url:'https://evil.test/2x.webp'}]);assert.equal(f.body.querySelectorAll('img').length,0);
  f.api.set([{name:'Clap',url:URL}]);assert.equal(f.body.querySelectorAll('img').length,1);assert.equal(f.body.querySelector('a').textContent,'Clap');assert.equal(f.body.querySelector('[role]').textContent,'Clap');
 }finally{f.close()}
});
test('new messages and React updates are rendered without losing the newest text on stop',async()=>{
 const f=fixture('Clap');try{
  f.api.set([{name:'Clap',url:URL}]);f.anchor.nodeValue='Updated Clap';await wait();
  assert.equal(f.body.querySelectorAll('img[data-vetro-7tv]').length,1);
  f.api.stop();assert.equal(f.anchor.nodeValue,'Updated Clap');
 }finally{f.close()}
});
test('broken emote image restores its token and is not retried in a mutation loop',async()=>{
 const f=fixture('Clap');try{
  f.api.set([{name:'Clap',url:URL}]);f.body.querySelector('img').dispatchEvent(new f.w.Event('error'));await wait();await wait();
  assert.equal(f.body.querySelectorAll('img').length,0);assert.equal(f.body.textContent,'Clap');assert.equal(f.api.status().imageErrors,1);
 }finally{f.close()}
});
test('channel catalogue overrides global aliases and clearing restores text',()=>{
 const f=fixture('Clap');try{
  f.api.set([{name:'Clap',url:URL},{name:'Clap',url:URL.replace('01TEST','02CHANNEL')}]);assert.match(f.body.querySelector('img').src,/02CHANNEL/);
  f.api.set([]);assert.equal(f.anchor.nodeValue,'Clap');assert.equal(f.body.querySelectorAll('img').length,0);
  assert.equal(f.api.channel(),'example');f.w.history.pushState({},'','/search');assert.equal(f.api.channel(),null);
 }finally{f.close()}
});
test('zero-width channel emotes overlay the preceding emote',()=>{
 const f=fixture('Clap Overlay');try{
  f.api.set([{name:'Clap',url:URL},{name:'Overlay',url:URL.replace('01TEST','02OVERLAY'),zeroWidth:true}]);
  const imgs=f.body.querySelectorAll('img');assert.equal(imgs.length,2);assert.equal(imgs[0].parentNode,imgs[1].parentNode);assert.equal(imgs[1].style.position,'absolute');
 }finally{f.close()}
});
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
test('TV fallback replaces only the message span, not the coloured username',()=>{
 const dom=new JSDOM('<main><aside><div class="r-1xq2hnv"><div><span class="username">Clap</span><span class="body">Clap</span></div></div></aside></main>',{url:'https://samsung.tv.twitch.tv/example',runScripts:'outside-only'});
 try{
  dom.window.eval(page.source);dom.window.__vetro7TV.set([{name:'Clap',url:URL}]);
  assert.equal(dom.window.document.querySelector('.username').textContent,'Clap');assert.equal(dom.window.document.querySelector('.username img'),null);
  assert.equal(dom.window.document.querySelectorAll('.body img').length,1);dom.window.__vetro7TV.stop();
 }finally{dom.window.close()}
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
test('a stale catalogue cannot overwrite the emotes of a different channel',()=>{
 const f=fixture('Clap');try{
  f.api.set([{name:'Clap',url:URL}]);assert.equal(f.api.set([{name:'Clap',url:URL.replace('01TEST','WRONG')}],'another'),false);
  assert.match(f.body.querySelector('img').src,/01TEST/);
 }finally{f.close()}
});
test('every rendered occurrence of a failed image restores its token',async()=>{
 const f=fixture('Clap');try{
  const second=f.w.document.createTextNode('Clap');f.body.appendChild(second);
  f.api.set([{name:'Clap',url:URL}]);const images=Array.from(f.body.querySelectorAll('img'));assert.equal(images.length,2);
  images.forEach(img=>img.dispatchEvent(new f.w.Event('error')));await wait();
  assert.equal(f.body.querySelectorAll('img').length,0);assert.equal(f.anchor.nodeValue,'Clap');assert.equal(second.nodeValue,'Clap');assert.equal(f.api.status().imageErrors,1);
 }finally{f.close()}
});
