import type { Database } from './db';

export function isReadQuotaError(error: unknown): boolean {
  for(let depth=0;error && depth<5;depth++){
    if(typeof error==='object' && 'message' in error && /exceeded.*D1.*daily row read limit|D1_READ_QUOTA_EXCEEDED/i.test(String(error.message)))return true;
    error=typeof error==='object' && 'cause' in error ? error.cause : null;
  }
  return false;
}
export const nextQuotaReset=(now=Date.now())=>new Date(now).setUTCHours(24,0,0,0);
const quotaByDatabase=new WeakMap<Database,number>();
export function cacheForWorker():Cache|undefined{return (globalThis as typeof globalThis & {caches?:CacheStorage & {default?:Cache}}).caches?.default;}
export class QueryCache {
  constructor(private db:Database,private origin:string,private cache?:Cache){}
  private key(path:string){return new Request(`${this.origin}/__quote_cache_v2/${path}`);}
  private async lookup<T>(key:Request):Promise<T|undefined> {
    try {
      const response=await this.cache?.match(key);
      if(response && Number(response.headers.get('X-Expires-At'))>Date.now())return await response.json() as T;
    }catch{console.warn('Query cache read unavailable');}
  }
  private async put(key:Request,body:unknown,ttl:number){
    try{
      await this.cache?.put(key,new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json',
        'Cache-Control':`public,max-age=${ttl}`,'X-Expires-At':String(Date.now()+ttl*1000)}}));
    }catch{console.warn('Query cache write unavailable');}
  }
  async assertQuotaAvailable(){
    const local=quotaByDatabase.get(this.db)??0;if(local>Date.now())throw new Error('D1_READ_QUOTA_EXCEEDED');
    const until=await this.lookup<number>(this.key('quota'));
    if(until && until>Date.now()){quotaByDatabase.set(this.db,until);throw new Error('D1_READ_QUOTA_EXCEEDED');}
  }
  async markQuotaExceeded(){
    const until=nextQuotaReset();quotaByDatabase.set(this.db,until);
    await this.put(this.key('quota'),until,Math.ceil((until-Date.now())/1000));
  }
  async read<T>(path:string,ttl:number,load:()=>Promise<T>):Promise<{body:T;hit:boolean}>{
    if(ttl<=0){await this.assertQuotaAvailable();return {body:await load(),hit:false};}
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(path)))).map(b=>b.toString(16).padStart(2,'0')).join('');
    const key=this.key(digest);const cached=await this.lookup<T>(key);
    if(cached!==undefined)return {body:cached,hit:true};
    await this.assertQuotaAvailable();
    const body=await load();
    await this.put(key,body,ttl);
    return {body,hit:false};
  }
}
