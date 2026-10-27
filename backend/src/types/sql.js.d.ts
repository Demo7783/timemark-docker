declare module 'sql.js' {
  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export interface QueryExecResult {
    columns: string[];
    values: any[][];
  }

  export interface ParamsObject {
    [key: string]: any;
  }

  export interface Statement {
    bind(params?: any[] | ParamsObject): boolean;
    step(): boolean;
    getAsObject(params?: any): any;
    get(params?: any): any[];
    getColumnNames(): string[];
    free(): boolean;
    reset(): void;
    run(params?: any[] | ParamsObject): void;
  }

  export class Database {
    constructor(data?: ArrayLike<number> | Buffer | null);
    run(sql: string, params?: any[] | ParamsObject): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    getRowsModified(): number;
    export(): Uint8Array;
    close(): void;
    /**
     * 注册自定义 SQL 函数（sql.js 运行时 API，官方 shim 未声明）。
     * 本项目用它实现 PG 兼容的 `REGEXP` 操作符（见 db/index.ts initDatabase）。
     */
    create_function(name: string, func: (...args: any[]) => any): void;
  }

  export default function initSqlJs(config?: any): Promise<SqlJsStatic>;
}