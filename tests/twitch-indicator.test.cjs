'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{JSDOM}=require('jsdom');
function setup(options={}){
 const dom=new JSDOM('<button id="player">Player</button>',{runScripts:'outside-only'}),w=dom.window,calls=[],timers=new Map();let now=1000,nextTimer=0,release;
 w.document.getElementById('player').focus();
 w.setTimeout=fn=>{timers.set(++nextTimer,fn);return nextTimer};w.clearTimeout=id=>timers.delete(id);
 const context={module:{exports:{}},require:id=>id==='./inspector-client.js'?{}:id==='./accounts/page.js'?require('../plugins/twitch/accounts/page.js'):require(id),Promise,Date:{now:()=>now}};
 vm.runInNewContext(fs.readFileSync('plugins/twitch/page-actions.js','utf8'),context);
 const indicator=context.module.exports.createAdSkipIndicator({call:async(method,args)=>{
  assert.equal(method,'Runtime.evaluate');calls.push(args);
  if(options.fail)throw Error('Inspector closed');
  if(options.exception)return{exceptionDetails:{text:'Script error'}};
  w.eval(args.expression);
  if(options.hold&&calls.length===1)await new Promise(r=>release=r);
  return{};
 }});
 return{indicator,w,calls,timers,now(v){now=v},release(){release()},el:()=>w.document.querySelector('[data-vetro-ad-indicator]'),async flush(){for(let i=0;i<8;i++)await new Promise(setImmediate)},close:()=>dom.window.close()};
}
test('indicator is silent by default, shows a noninteractive toast when enabled and removes it after three seconds',async()=>{
 const x=setup();try{
  x.indicator.notify();await x.flush();assert.equal(x.calls.length,0);assert.equal(x.el(),null);
  await x.indicator.setEnabled(true);x.indicator.notify();await x.flush();
  assert.equal(x.el().textContent,'Ad filtered');assert.equal(x.el().getAttribute('role'),'status');assert.equal(x.el().style.position,'fixed');assert.equal(x.el().style.pointerEvents,'none');
  assert.equal(x.w.document.activeElement.id,'player');assert.equal(x.timers.size,1);
  [...x.timers.values()][0]();assert.equal(x.el(),null);assert.equal(x.timers.size,0);assert.equal(x.w.__vetroTwitchAdIndicator,undefined);
  await x.indicator.stop();assert.equal(x.el(),null);
 }finally{x.close()}
});
test('repeated replacements are grouped until a thirty-second quiet gap and never stack overlays',async()=>{
 const x=setup();try{
  await x.indicator.setEnabled(true);x.indicator.notify();await x.flush();assert.equal(x.indicator.status().notifications,1);
  x.now(10000);x.indicator.notify();x.now(35000);x.indicator.notify();await x.flush();assert.equal(x.indicator.status().notifications,1);
  x.now(65000);x.indicator.notify();await x.flush();assert.equal(x.indicator.status().notifications,2);assert.equal(x.w.document.querySelectorAll('[data-vetro-ad-indicator]').length,1);assert.equal(x.timers.size,1);
  await x.indicator.setEnabled(false);assert.equal(x.el(),null);assert.equal(x.timers.size,0);
  await x.indicator.setEnabled(true);x.indicator.notify();await x.flush();assert.equal(x.indicator.status().notifications,3);
  await x.indicator.stop();assert.equal(x.el(),null);assert.equal(x.timers.size,0);
 }finally{x.close()}
});
test('the ad notification uses the page locale or the browser language when the page has no language', async () => {
 const x=setup();try{
  Object.defineProperty(x.w.navigator, 'language', {value: 'it-IT'});
  await x.indicator.setEnabled(true);
  x.indicator.notify();await x.flush();
  assert.equal(x.el().textContent, 'Pubblicità filtrata');
  x.w.document.documentElement.lang='es-MX';x.now(32000);x.indicator.notify();await x.flush();
  assert.equal(x.el().textContent, 'Anuncio filtrado');
 }finally{x.close()}
});
test('disabling before a queued show cancels it; disabling during evaluation removes its late result',async()=>{
 const x=setup({hold:true});try{
  await x.indicator.setEnabled(true);x.indicator.notify();await x.indicator.setEnabled(false);assert.equal(x.calls.length,0);
  await x.indicator.setEnabled(true);x.indicator.notify();await x.flush();assert.ok(x.el());
  const disabled=x.indicator.setEnabled(false);x.release();await disabled;assert.equal(x.el(),null);assert.equal(x.timers.size,0);
  await x.indicator.setEnabled(true);x.indicator.notify();const stopped=x.indicator.stop();await stopped;assert.equal(x.el(),null);
  const count=x.calls.length;x.indicator.notify();await x.indicator.setEnabled(true);await x.flush();assert.equal(x.calls.length,count);
 }finally{x.close()}
});
test('optional indicator failures are contained and reported without rejecting into playback',async()=>{
 for(const options of [{fail:true},{exception:true}]){
  const x=setup(options);try{
   await x.indicator.setEnabled(true);x.indicator.notify();await x.flush();assert.equal(x.indicator.status().errors,1);assert.equal(x.indicator.status().notifications,0);
   await x.indicator.stop();assert.equal(x.el(),null);
  }finally{x.close()}
 }
});
