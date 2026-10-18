// Structural subset supported by Cloudflare D1 and the SQLite integration adapter.
export interface Statement {
  bind(...values: unknown[]): Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface Database { prepare(sql: string): Statement; }
export type Row = Record<string, any>;
export async function rows(db: Database, sql: string, args: unknown[] = []): Promise<Row[]> {
  return (await db.prepare(sql).bind(...args).all<Row>()).results;
}
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
