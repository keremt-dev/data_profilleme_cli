/**
 * SQL template loader with identifier escaping.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DbType } from '../config/types.js';

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const HANA_IDENTIFIER_RE = /^[a-zA-Z_/][a-zA-Z0-9_/]*$/;
const ACCESS_IDENTIFIER_RE = /^.+$/;

export class SqlLoader {
  private sqlDir: string;
  private dbType: DbType;
  private cache = new Map<string, string>();

  constructor(sqlDir: string, dbType: DbType) {
    this.sqlDir = path.join(sqlDir, dbType);
    this.dbType = dbType;

    if (!fs.existsSync(this.sqlDir)) {
      throw new Error(`SQL sablon dizini bulunamadi: ${this.sqlDir}`);
    }
  }

  /**
   * Load SQL template and substitute identifier params.
   * Value params (%(name)s for pg, ? for mssql) are left untouched.
   */
  load(
    templateName: string,
    identifierParams: Record<string, string> = {},
    literalParams: Record<string, string | number> = {},
  ): string {
    if (!this.cache.has(templateName)) {
      const filePath = path.join(this.sqlDir, `${templateName}.sql`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`SQL sablonu bulunamadi: ${filePath}`);
      }
      this.cache.set(templateName, fs.readFileSync(filePath, 'utf-8'));
    }

    let sql = this.cache.get(templateName)!;

    for (const [key, value] of Object.entries(identifierParams)) {
      const quoted = this.validateIdentifier(value);
      sql = sql.replaceAll(`{${key}}`, quoted);
    }

    for (const [key, value] of Object.entries(literalParams)) {
      sql = sql.replaceAll(`{${key}}`, String(value));
    }

    return sql;
  }

  /**
   * Validate and quote SQL identifier.
   * PostgreSQL/Oracle: "name", MSSQL: [name]
   */
  validateIdentifier(name: string): string {
    if (this.dbType === 'access') {
      if (!ACCESS_IDENTIFIER_RE.test(name)) {
        throw new Error(`Gecersiz SQL identifier: '${name}'.`);
      }
      return `[${name}]`;
    }
    const re = this.dbType === 'hanabw' ? HANA_IDENTIFIER_RE : IDENTIFIER_RE;
    if (!re.test(name)) {
      throw new Error(
        `Gecersiz SQL identifier: '${name}'. Sadece harf, rakam ve alt cizgi kabul edilir.`,
      );
    }
    return this.dbType === 'mssql' ? `[${name}]` : `"${name}"`;
  }

  /**
   * Convert Oracle :param_name binds — inline all values.
   * Oracle named binds originate from validated config or internal counters,
   * so inline substitution is safe.
   */
  oracleParams(sql: string, params: Record<string, unknown>): { sql: string; values: unknown[] } {
    const transformed = sql.replace(/:(\w+)/g, (_match, name: string) => {
      const val = params[name];
      if (val == null) return 'NULL';
      if (typeof val === 'number') return String(val);
      const safe = String(val).replace(/'/g, "''");
      return `'${safe}'`;
    });
    return { sql: transformed, values: [] };
  }

  /**
   * Convert PostgreSQL %(name)s params to $1, $2 positional params.
   * Returns transformed SQL and ordered param values.
   */
  pgParams(sql: string, params: Record<string, unknown>): { sql: string; values: unknown[] } {
    // Inline all value params — pg prepared statements often fail to infer
    // types for information_schema and complex CTE queries.
    // All values originate from validated config or internal counters, so
    // inline substitution is safe.
    const transformed = sql.replace(/%\((\w+)\)s(::text)?/g, (_match, name: string) => {
      const val = params[name];
      if (val == null) return 'NULL';
      if (typeof val === 'number') return String(val);
      const safe = String(val).replace(/'/g, "''");
      return `'${safe}'`;
    });
    return { sql: transformed, values: [] };
  }

  /**
   * Convert MSSQL ? positional params to @p1, @p2 named params.
   * Returns transformed SQL and named param entries.
   */
  mssqlParams(sql: string, params: unknown[]): { sql: string; inputs: Array<{ name: string; value: unknown }> } {
    let idx = 0;
    const inputs: Array<{ name: string; value: unknown }> = [];
    const transformed = sql.replace(/\?/g, () => {
      idx++;
      inputs.push({ name: `p${idx}`, value: params[idx - 1] });
      return `@p${idx}`;
    });
    return { sql: transformed, inputs };
  }

  /**
   * Access ? positional params — used directly with odbc.query(sql, values).
   * Unlike MSSQL, no @p1 conversion needed.
   */
  accessParams(sql: string, params: unknown[]): { sql: string; values: unknown[] } {
    return { sql, values: params };
  }
}
