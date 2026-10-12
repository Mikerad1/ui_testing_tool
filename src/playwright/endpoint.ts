import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { browserTypeFor, type BrowserEngine } from '../browser/engine.js';

const MAX_PAYLOAD=10*1024*1024;
const MAX_TOKEN_BYTES=4096;
function secretPath():string{return `/${randomBytes(32).toString('hex')}`;}
function authorized(req:IncomingMessage,token:Buffer):boolean{
 const values=req.headersDistinct?.authorization??(req.headers.authorization?[req.headers.authorization]:[]);
 if(values.length!==1)return false;
 const match=/^Bearer ([^\s]+)$/.exec(values[0]??'');if(!match)return false;
 const provided=Buffer.from(match[1]!);return provided.length===token.length&&timingSafeEqual(provided,token);
}

export async function startAuthenticatedWebSocketProxy(upstreamEndpoint:string,tokenValue:string):Promise<{endpoint:string;close:()=>Promise<void>;hasActiveClient:()=>boolean}> {
 const token=Buffer.from(tokenValue,'utf8');
 if(token.length<32||token.length>MAX_TOKEN_BYTES)throw Error('Endpoint token must be between 32 and 4096 bytes');
 const publicPath=secretPath();
 const proxy=createServer();
 const wss=new WebSocketServer({noServer:true,maxPayload:MAX_PAYLOAD,perMessageDeflate:false});
 let reserved=false,closing=false;
 const downstreams=new Set<WebSocket>(),upstreams=new Set<WebSocket>(),rawSockets=new Set<Duplex>();
 const teardowns=new Set<(forceDownstream:boolean)=>void>();
 const drainedWaiters=new Set<()=>void>();
 proxy.on('connection',socket=>{rawSockets.add(socket);socket.once('close',()=>rawSockets.delete(socket));});
 const sendStatus=(socket:Duplex,status:number,text:string)=>{if(socket.destroyed)return;socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,()=>{if(!socket.destroyed)socket.destroy();});};
 const maybeDrained=()=>{if(teardowns.size===0)for(const resolve of drainedWaiters)resolve();};
 proxy.on('upgrade',(req,socket,head)=>{
   let url:URL;try{url=new URL(req.url??'','http://127.0.0.1');}catch{sendStatus(socket,400,'Bad Request');return;}
  if(url.pathname!==publicPath){sendStatus(socket,404,'Not Found');return;}
  if(!authorized(req,token)){sendStatus(socket,401,'Unauthorized');return;}
  if(closing){sendStatus(socket,503,'Service Unavailable');return;}
  if(reserved){sendStatus(socket,409,'Conflict');return;}
  reserved=true;
  let upstream:WebSocket|undefined,downstream:WebSocket|undefined,upstreamGone=false,downstreamGone=socket.destroyed,tearingDown=false,released=false,forceTimer:NodeJS.Timeout|undefined;
  const releaseWhenClosed=()=>{
   if(released||!upstreamGone||!downstreamGone)return;
   released=true;if(forceTimer)clearTimeout(forceTimer);if(upstream)upstreams.delete(upstream);if(downstream)downstreams.delete(downstream);
   teardowns.delete(teardown);reserved=false;maybeDrained();
  };
  const finishUpstream=()=>{upstreamGone=true;releaseWhenClosed();};
  const tearDownUpstream=()=>{
   if(!upstream){finishUpstream();return;}
   if(upstream.readyState===WebSocket.CLOSED){finishUpstream();return;}
   if(upstream.readyState===WebSocket.OPEN){try{upstream.close(1000,'downstream closed');}catch{upstream.terminate();}}
   else upstream.terminate();
   if(!forceTimer)forceTimer=setTimeout(()=>{if(!upstreamGone)upstream?.terminate();},1000);forceTimer.unref();
  };
  const teardown=(forceDownstream:boolean)=>{
   tearingDown=true;tearDownUpstream();
   if(forceDownstream){if(downstream&&downstream.readyState!==WebSocket.CLOSED)downstream.terminate();else if(!socket.destroyed)socket.destroy();}
   releaseWhenClosed();
  };
  teardowns.add(teardown);
  const fail=(status:number,text:string)=>{if(!downstream&&!socket.destroyed)sendStatus(socket,status,text);teardown(false);};
  socket.once('error',()=>teardown(true));socket.once('close',()=>{downstreamGone=true;if(!tearingDown)teardown(false);else releaseWhenClosed();});
  upstream=new WebSocket(upstreamEndpoint,{maxPayload:MAX_PAYLOAD,perMessageDeflate:false});upstreams.add(upstream);
  upstream.once('error',()=>{if(!downstream)fail(502,'Bad Gateway');else teardown(true);});
  upstream.once('close',finishUpstream);
  upstream.once('open',()=>{
    if(closing||socket.destroyed){teardown(true);return;}
    try{wss.handleUpgrade(req,socket,head,ws=>{
     downstream=ws;downstreams.add(ws);
     ws.on('message',(data,isBinary)=>{if(upstream?.readyState===WebSocket.OPEN)upstream.send(data,{binary:isBinary},error=>{if(error)teardown(true);});});
     upstream!.on('message',(data,isBinary)=>{if(ws.readyState===WebSocket.OPEN)ws.send(data,{binary:isBinary},error=>{if(error)teardown(true);});});
     ws.once('close',()=>{if(!tearingDown)teardown(false);});ws.once('error',()=>teardown(true));
    });}catch{fail(502,'Bad Gateway');}
  });
 });
 try{
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  }catch(error){throw error;}
  const address=proxy.address() as AddressInfo|null;if(!address){throw Error('Could not determine endpoint address');}
 let closed=false;
 return {endpoint:`ws://127.0.0.1:${address.port}${publicPath}`,hasActiveClient:()=>reserved,close:async()=>{
   if(closed)return;closed=true;closing=true;
    for(const cleanup of [...teardowns])cleanup(true);
    for(const socket of rawSockets)if(!socket.destroyed)socket.destroy();
    wss.close();
    await new Promise<void>(resolve=>proxy.close(()=>resolve()));
    if(teardowns.size)await new Promise<void>(resolve=>drainedWaiters.add(resolve));
   }};
}

export async function startPlaywrightEndpoint(tokenValue:string,engine:BrowserEngine|string|undefined='chromium'):Promise<{endpoint:string;close:()=>Promise<void>}> {
 const upstreamPath=secretPath();
 const browserServer=await browserTypeFor(engine).launchServer({host:'127.0.0.1',port:0,wsPath:upstreamPath});
 try{
  const proxy=await startAuthenticatedWebSocketProxy(browserServer.wsEndpoint(),tokenValue);
  return {endpoint:proxy.endpoint,close:async()=>{try{await proxy.close();}finally{await browserServer.close();}}};
 }catch(error){await browserServer.close();throw error;}
}
