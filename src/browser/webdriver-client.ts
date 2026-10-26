import { DesktopAdapterError } from './desktop-adapter.js';

/** Small bounded W3C transport. It deliberately has no session/window lifecycle helpers. */
export class WebDriverClient {
  constructor(private endpoint:string, private sessionId:string, private timeoutMs=5000, private maxBytes=1_000_000) {}
  setTimeout(timeoutMs:number){this.timeoutMs=timeoutMs;}
  getTimeout(){return this.timeoutMs;}
  async command(method:string,path:string,body?:unknown,requestTimeoutMs=this.timeoutMs,mutation=false):Promise<any>{
    if(!this.allowed(method,path))throw new DesktopAdapterError('CAPABILITY_UNAVAILABLE','WebDriver method/path is outside the attached-session command allowlist');
    const signal=AbortSignal.timeout(Math.ceil(requestTimeoutMs));
    let response:Response;
    try { response=await fetch(`${this.endpoint}/session/${encodeURIComponent(this.sessionId)}${path}`,{method,redirect:'error',signal,headers:body===undefined?undefined:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}); }
    catch { if(signal.aborted&&!mutation)throw new DesktopAdapterError('REQUEST_TIMEOUT','WebDriver request timed out');throw new DesktopAdapterError('ATTACHMENT_UNAVAILABLE','loopback WebDriver request failed, timed out, or redirected'); }
    let text='',bytesRead=0;try{const reader=response.body?.getReader();if(!reader)throw Error();const chunks:Uint8Array[]=[];for(;;){const x=await reader.read();if(x.done)break;bytesRead+=x.value.byteLength;if(bytesRead>this.maxBytes){await reader.cancel();throw Error();}chunks.push(x.value);}text=Buffer.concat(chunks).toString('utf8');}catch(error){if(signal.aborted&&!mutation)throw new DesktopAdapterError('REQUEST_TIMEOUT','WebDriver response timed out');const reason=error instanceof Error?error.name:'unknown error';throw this.uncertain(mutation,`WebDriver response could not be read within bounds (${bytesRead} bytes, ${reason})`);}
    let envelope:any;try{envelope=JSON.parse(text);}catch{throw this.uncertain(mutation,'WebDriver returned malformed or truncated JSON');}
    const value=envelope?.value;
    const successfulScriptResult=method==='POST'&&path==='/execute/sync'&&response.ok;
    if(!successfulScriptResult&&value&&typeof value==='object'&&Object.prototype.hasOwnProperty.call(value,'error')){if(typeof value.error!=='string'||value.error.length===0||!Object.prototype.hasOwnProperty.call(value,'message'))throw this.uncertain(mutation,'WebDriver returned an invalid error envelope');if(value.error==='timeout'&&mutation)throw new DesktopAdapterError('INDETERMINATE_MUTATION','WebDriver reported a timeout after mutation dispatch');if(value.error==='invalid session id')throw new DesktopAdapterError('SESSION_NOT_FOUND','configured WebDriver session is unavailable');if(['unsupported operation','unknown command'].includes(value.error))throw new DesktopAdapterError('CAPABILITY_UNAVAILABLE',`WebDriver command ${path} is unsupported`);const definiteNoAction=['invalid argument','no such alert','no such cookie','no such element','no such frame','no such window','stale element reference','element not interactable','element click intercepted','invalid element state'];if(mutation&&!definiteNoAction.includes(value.error))throw this.uncertain(true,`WebDriver returned ${value.error} after mutation dispatch`);throw new DesktopAdapterError('REMOTE_COMMAND_FAILED',`WebDriver command failed (${value.error})`);}
    if(!response.ok||!envelope||typeof envelope!=='object'||!Object.prototype.hasOwnProperty.call(envelope,'value'))throw this.uncertain(mutation,`WebDriver returned an invalid response (HTTP ${response.status})`);
    return value;
  }
  private uncertain(mutation:boolean,message:string){return new DesktopAdapterError(mutation?'INDETERMINATE_MUTATION':'REMOTE_COMMAND_FAILED',mutation?`${message}; mutation outcome is indeterminate and was not retried`:message);}
  private allowed(method:string,path:string){
    if(method==='GET'&&['/url','/title'].includes(path))return true;
    if(method==='POST'&&['/url','/back','/forward','/elements','/execute/sync','/actions'].includes(path))return true;
    const element=/^\/element\/[A-Za-z0-9._~%+-]+\/(displayed|enabled|text|click|clear|value)$/.exec(path);
    if(!element)return false;
    return method==='GET'?['displayed','enabled','text'].includes(element[1]!):method==='POST'?['click','clear','value'].includes(element[1]!):false;
  }
}
