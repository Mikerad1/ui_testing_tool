import {watch as fsWatch, type FSWatcher} from 'node:fs';
import path from 'node:path';

export type KnowledgeWatchEvent=(eventType:string,filename:string|Buffer|null)=>void;
export type KnowledgeWatchHandle={close():void;on?:(event:'error',listener:(error:unknown)=>void)=>unknown};
export type KnowledgeWatcherFactory=(root:string,listener:KnowledgeWatchEvent)=>KnowledgeWatchHandle;
export type KnowledgeWatcherOptions={debounceMs?:number;factory?:KnowledgeWatcherFactory;onError?:(message:string)=>void};

const defaultFactory:KnowledgeWatcherFactory=(root,listener)=>fsWatch(root,{recursive:true},listener) as FSWatcher;
function relevant(eventType:string,filename:string|Buffer|null){if(eventType!=='rename'&&eventType!=='change')return false;if(filename===null)return true;const name=Buffer.isBuffer(filename)?filename.toString():filename;if(!name||name==='.'||name==='..')return true;if(/(^|[\\/])(?:~|\.#)|(?:\.tmp|\.bak|\.backup|\.swp|~)$/i.test(name))return false;return /\.ya?ml$/i.test(name);}

/** Debounced full-tree reconcile trigger. Events are hints, never incremental updates. */
export class KnowledgeWatcher {
  private handle:KnowledgeWatchHandle;private timer:NodeJS.Timeout|undefined;private active:Promise<void>|undefined;private pending=false;private closed=false;private readonly debounceMs:number;
  constructor(root:string,private reload:()=>Promise<void>,private options:KnowledgeWatcherOptions={}){this.debounceMs=options.debounceMs??150;if(!Number.isInteger(this.debounceMs)||this.debounceMs<1||this.debounceMs>60_000)throw Error('Knowledge watcher debounce must be 1..60000 ms');const factory=options.factory??defaultFactory;this.handle=factory(root,(type,name)=>this.onEvent(type,name));this.handle.on?.('error',()=>{try{this.options.onError?.('Knowledge watcher encountered a filesystem error.');}catch{}});}
  private onEvent(type:string,filename:string|Buffer|null){if(this.closed||!relevant(type,filename))return;this.pending=true;if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=undefined;this.flush();},this.debounceMs);this.timer.unref?.();}
  private flush(){if(this.closed||!this.pending)return;if(this.active)return;this.pending=false;const task=Promise.resolve().then(()=>this.reload()).catch(()=>{try{this.options.onError?.('Knowledge reload failed; the last valid graph remains active.');}catch{}}).then(()=>{if(this.active===task)this.active=undefined;if(!this.closed&&this.pending&&!this.timer)this.flush();});this.active=task;}
  async close(){if(this.closed)return;this.closed=true;this.pending=false;if(this.timer){clearTimeout(this.timer);this.timer=undefined;}try{this.handle.close();}catch{try{this.options.onError?.('Knowledge watcher could not close cleanly.');}catch{}}await this.active?.catch(()=>undefined);}
}

export function startKnowledgeWatcher(root:string,reload:()=>Promise<void>,options:KnowledgeWatcherOptions={}){return new KnowledgeWatcher(path.resolve(root),reload,options);}
