export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface PreparedStatement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteAdapter {
  readonly driver: "better-sqlite3" | "node:sqlite" | "bun:sqlite" | "sql.js";
  readonly open: boolean;
  readonly name: string;

  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
  pragma(pragmaStr: string, options?: { simple?: boolean }): unknown;

  /** Returns a function that, when called, runs fn in a DEFERRED transaction */
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;

  /** Runs fn in an IMMEDIATE transaction (takes the write lock right away) */
  immediate(fn: () => void): void;

  /** Backup nativo ou file-copy fallback */
  backup(destination: string): Promise<void>;

  checkpoint(mode?: string): void;
  close(): void;

  readonly raw: unknown;
}
