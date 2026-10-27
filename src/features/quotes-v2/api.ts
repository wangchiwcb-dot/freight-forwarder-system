export async function quotationApi<T>(path: string, body?: unknown): Promise<T> {
  try {
    const response = await fetch(`/api/v2${path}`, {
      signal: AbortSignal.timeout(45000),
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json) throw new Error(json?.error?.message ?? '报价服务暂不可用，请检查连接后重试');
    return json as T;
  } catch (error) {
    if (error instanceof Error && ['TimeoutError','AbortError'].includes(error.name)) throw new Error('服务器连接超时，已保留填写的资料，请检查连接后重试');
    if (error instanceof TypeError) throw new Error('无法连接报价服务，请检查服务器连接后重试');
    throw error;
  }
}

export const countryNames: Record<string, string> = { US: '美国', CA: '加拿大', MX: '墨西哥', GB: '英国', DE: '德国', FR: '法国', IT: '意大利', ES: '西班牙', PL: '波兰', CZ: '捷克', AU: '澳大利亚', BR: '巴西', EU: '欧洲（国家待核）', OTHER: '其他（国家待核）' };
export const todayInChina = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export const cargoOptions = [
  { value: 'built_in_battery', label: '内置电池' }, { value: 'pure_battery', label: '纯电池' },
  { value: 'magnetic', label: '带磁' }, { value: 'liquid', label: '液体' }, { value: 'powder', label: '粉末' },
];

// Public IP access can use HTTP, where randomUUID is not exposed by browsers.
export function newId():string {
  if(typeof crypto.randomUUID==='function') return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  return Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
}
