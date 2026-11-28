'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),inspector=require('../plugins/twitch/inspector-client.js'),sessions=require('../plugins/twitch/accounts/session.js'),storage=require('../plugins/twitch/accounts/store.js');
function cookies(){return storage.names.map(name=>({name,value:name.startsWith('auth-token')?'secret':encodeURIComponent(JSON.stringify({id:'1',login:'first'})),domain:'.twitch.tv',path:'/',secure:true,httpOnly:false,session:false,expires:2000000000,sameSite:'None'}))}
test('account CDP session preserves authentication cookie attributes and leaves unrelated cookies intact',async()=>{
 const oldList=inspector.listTargets,oldConnect=inspector.connect,calls=[];let actual=cookies(),closed=false;
 const foreign={name:'unique_id',value:'device-id',domain:'.twitch.tv',path:'/'};
 inspector.listTargets=async()=>[{type:'page',url:'https://example.tv.twitch.tv/first',webSocketDebuggerUrl:'local'}];
 inspector.connect=async()=>({isOpen:()=>!closed,close(){closed=true},async call(method,args){calls.push([method,args]);if(method==='Page.addScriptToEvaluateOnNewDocument')return{identifier:'accounts-script'};if(method==='Network.getCookies')return{cookies:actual.concat(foreign)};if(method==='Network.deleteCookies'){actual=actual.filter(c=>c.name!==args.name);return{}}if(method==='Network.setCookies'){actual=args.cookies.map(c=>({...c,session:c.expires===undefined}));return{}}return{result:{value:{visible:true}}}}});
 try{
  const session=await sessions.open(8123,()=>{});await session.replace([]);assert.equal(actual.length,0);assert.ok(calls.filter(([m])=>m==='Network.deleteCookies').every(([,p])=>storage.names.includes(p.name)));
  await session.replace(cookies());assert.deepEqual(await session.cookies(),cookies());const set=calls.find(([m])=>m==='Network.setCookies')[1].cookies[0];assert.equal(set.expires,2000000000);assert.equal(set.sameSite,'None');assert.equal(set.secure,true);assert.equal(set.httpOnly,false);
  await session.reload();assert.deepEqual(calls.find(([m])=>m==='Page.navigate')[1],{url:'https://example.tv.twitch.tv/'});await session.close();assert.equal(closed,true);assert.ok(calls.some(([m,p])=>m==='Page.removeScriptToEvaluateOnNewDocument'&&p.identifier==='accounts-script'));
 }finally{inspector.listTargets=oldList;inspector.connect=oldConnect}
});
test('cancelled account attachment removes even late document registration before closing',async()=>{
 const oldList=inspector.listTargets,oldConnect=inspector.connect,calls=[];let current=true;
 inspector.listTargets=async()=>[{type:'page',url:'https://example.tv.twitch.tv/',webSocketDebuggerUrl:'local'}];
 inspector.connect=async()=>({isOpen:()=>true,close(){calls.push('closed')},async call(method){calls.push(method);if(method==='Page.addScriptToEvaluateOnNewDocument'){current=false;return{identifier:'late'}}return{}}});
 try{await assert.rejects(sessions.open(8123,()=>{if(!current)throw Error('Cancelled')}));assert.ok(calls.includes('Page.removeScriptToEvaluateOnNewDocument'));assert.equal(calls.at(-1),'closed')}finally{inspector.listTargets=oldList;inspector.connect=oldConnect}
});

test('token validation contacts only Twitch and does not expose authentication values or remote error bodies',async()=>{
 const https=require('node:https'),{EventEmitter}=require('node:events'),original=https.get;
 try{
  for(const code of [200,401,500]){
   const calls=[];
   https.get=(options,callback)=>{calls.push(options);const request=new EventEmitter();request.destroy=()=>{};process.nextTick(()=>{const response=new EventEmitter();response.statusCode=code;response.destroy=()=>{};callback(response);response.emit('data',code===200?JSON.stringify({user_id:'1',login:'first'}):'private-remote-error-secret');response.emit('end')});return request};
   if(code===500)await assert.rejects(sessions.validate(cookies()),error=>!error.message.includes('private-remote-error-secret'));
   else assert.deepEqual(await sessions.validate(cookies()),code===200?{id:'1',login:'first'}:null);
   assert.equal(calls.length,1);assert.equal(calls[0].hostname,'id.twitch.tv');assert.equal(calls[0].path,'/oauth2/validate');assert.equal(calls[0].headers.Authorization,'OAuth secret');
  }
 }finally{https.get=original}
});
