export function memoryCache():Cache {
  const values=new Map<string,Response>();
  return {async match(request:Request){return values.get(request.url)?.clone();},
    async put(request:Request,response:Response){values.set(request.url,response.clone());}} as Cache;
}
