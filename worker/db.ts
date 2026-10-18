// Structural subset supported by Cloudflare D1 and the SQLite integration adapter.
export interface Statement {
  bind(...values: unknown[]): Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; meta?: { rows_read?:number; duration?:number } }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface Database { prepare(sql: string): Statement; }
// Log D1 billing units per request without parameters or quote data.
export function observeDatabase(database:Database) {
  const usage={statements:0,rowsRead:0,durationMs:0};
  const db:Database={prepare(sql){
    let statement=database.prepare(sql);
    const wrapped:Statement={
      bind(...values){statement=statement.bind(...values);return wrapped;},
      async all<T>(){const result=await statement.all<T>();usage.statements++;
        usage.rowsRead+=result.meta?.rows_read??0;usage.durationMs+=result.meta?.duration??0;return result;},
      async first<T>(){return (await wrapped.all<T>()).results[0]??null;},
    };return wrapped;
  }};
  return {db,usage};
}
export type Row = Record<string, any>;
export async function rows(db: Database, sql: string, args: unknown[] = []): Promise<Row[]> {
  return (await db.prepare(sql).bind(...args).all<Row>()).results;
}
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
