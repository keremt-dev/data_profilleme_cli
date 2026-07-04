/**
 * Microsoft Access connector using odbc npm package.
 */
import odbc from 'odbc';
import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../utils/logger.js';
import { BaseConnector } from './base-connector.js';
import type { DatabaseConfig } from '../config/types.js';
import type { DbConnection, QueryResult, RowCountResult, TableInfo } from '../profiler/types.js';

export class AccessConnector extends BaseConnector {
  private connectionString: string;

  constructor(config: DatabaseConfig) {
    super(config);
    const dbqPath = path.resolve(config.dbq);
    const driver = config.driver || 'Microsoft Access Driver (*.mdb, *.accdb)';
    const pwd = config.password ? `PWD=${config.password};` : '';
    this.connectionString = `DRIVER={${driver}};DBQ=${dbqPath};${pwd}ExtendedAnsiSQL=1;`;
  }

  async withConnection<T>(fn: (conn: DbConnection) => Promise<T>): Promise<T> {
    const connection = await odbc.connect(this.connectionString);
    try {
      const conn: DbConnection = {
        async query(sqlText: string, params?: unknown[]): Promise<QueryResult> {
          const rows = params && params.length > 0
            ? await connection.query(sqlText, params as (string | number)[])
            : await connection.query(sqlText);
          return { rows: rows as unknown as Record<string, unknown>[] };
        },
      };
      return await fn(conn);
    } finally {
      await connection.close();
    }
  }

  async executeQuery(sqlText: string, params?: unknown): Promise<Record<string, unknown>[] | null> {
    const connection = await odbc.connect(this.connectionString);
    try {
      const rows = params && Array.isArray(params) && params.length > 0
        ? await connection.query(sqlText, params as (string | number)[])
        : await connection.query(sqlText);
      return rows as unknown as Record<string, unknown>[];
    } finally {
      await connection.close();
    }
  }

  async testConnection(): Promise<boolean> {
    const logger = getLogger();
    try {
      const dbqPath = path.resolve(this.config.dbq);
      if (!fs.existsSync(dbqPath)) {
        logger.error(`[${this.config.alias}] Access dosyasi bulunamadi: ${dbqPath}`);
        return false;
      }
      const connection = await odbc.connect(this.connectionString);
      await connection.query('SELECT 1');
      await connection.close();
      logger.info(`[${this.config.alias}] Baglanti basarili: ${dbqPath}`);
      return true;
    } catch (e) {
      logger.error(`[${this.config.alias}] Baglanti hatasi: ${e}`);
      return false;
    }
  }

  async discoverSchemas(): Promise<string[]> {
    return ['default'];
  }

  async discoverTables(_schema: string): Promise<TableInfo[]> {
    const logger = getLogger();
    const connection = await odbc.connect(this.connectionString);
    try {
      const tables = await connection.tables(null, null, null, 'TABLE');
      const result: TableInfo[] = [];
      for (const t of tables as unknown as Record<string, unknown>[]) {
        const tableName = t.TABLE_NAME as string;
        // Skip system tables
        if (tableName.startsWith('MSys') || tableName.startsWith('~')) continue;
        try {
          const countResult = await connection.query(`SELECT COUNT(*) AS cnt FROM [${tableName}]`);
          const rowCount = Number((countResult as unknown as Record<string, unknown>[])[0]?.cnt ?? 0);
          result.push({
            table_name: tableName,
            table_type: 'BASE TABLE',
            estimated_rows: rowCount,
          });
        } catch {
          result.push({
            table_name: tableName,
            table_type: 'BASE TABLE',
            estimated_rows: 0,
          });
        }
      }
      return result;
    } finally {
      await connection.close();
    }
  }

  async getEstimatedRowCount(conn: DbConnection, _schema: string, table: string): Promise<RowCountResult> {
    try {
      const { rows } = await conn.query(`SELECT COUNT(*) AS cnt FROM [${table}]`);
      return { row_count: Number(rows[0]?.cnt ?? 0), estimated: false };
    } catch {
      return { row_count: 0, estimated: true };
    }
  }

  async validateDbType(_conn: DbConnection): Promise<boolean> {
    return true;
  }

  async getTableSize(_conn: DbConnection, _schema: string, _table: string): Promise<number | null> {
    try {
      const dbqPath = path.resolve(this.config.dbq);
      const stats = fs.statSync(dbqPath);
      return stats.size;
    } catch {
      return null;
    }
  }

  isQueryTimeoutError(error: unknown): boolean {
    if (error && typeof error === 'object') {
      const e = error as Record<string, unknown>;
      const msg = String(e.message ?? '');
      return msg.includes('timeout') || msg.includes('TIMEOUT');
    }
    return false;
  }

  /**
   * Fetch metadata for all tables via ODBC API (no SQL catalog).
   */
  async getTableMetadataViaOdbc(
    tables: string[],
  ): Promise<Map<string, Record<string, unknown>[]>> {
    const logger = getLogger();
    const metadata = new Map<string, Record<string, unknown>[]>();
    const connection = await odbc.connect(this.connectionString);

    try {
      for (const table of tables) {
        try {
          const columns = await connection.columns(null, null, table, null) as unknown as Record<string, unknown>[];
          let pkColumns: Set<string>;
          try {
            const pks = await connection.primaryKeys(null, null, table) as unknown as Record<string, unknown>[];
            pkColumns = new Set(pks.map((pk) => String(pk.COLUMN_NAME)));
          } catch {
            pkColumns = new Set();
          }

          const colMeta: Record<string, unknown>[] = [];
          for (const col of columns) {
            colMeta.push({
              table_name: table,
              column_name: String(col.COLUMN_NAME),
              ordinal_position: Number(col.ORDINAL_POSITION ?? 0),
              data_type: String(col.TYPE_NAME ?? 'unknown').toLowerCase(),
              character_maximum_length: col.COLUMN_SIZE != null ? Number(col.COLUMN_SIZE) : null,
              numeric_precision: col.DECIMAL_DIGITS != null ? Number(col.DECIMAL_DIGITS) : null,
              is_nullable: col.NULLABLE === 1 ? 'YES' : 'NO',
              is_primary_key: pkColumns.has(String(col.COLUMN_NAME)),
              column_description: null,
            });
          }
          metadata.set(table, colMeta);
        } catch (e) {
          logger.warn(`[${table}] ODBC metadata cekme hatasi: ${e}`);
        }
      }
    } finally {
      await connection.close();
    }

    return metadata;
  }

  /**
   * Fetch sorted numeric column values for Node.js-side percentile/IQR.
   */
  async getSortedColumnValues(
    conn: DbConnection,
    table: string,
    column: string,
  ): Promise<number[]> {
    const quotedColumn = `[${column}]`;
    const quotedTable = `[${table}]`;
    const sql = `SELECT CDbl(${quotedColumn}) AS val FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL ORDER BY ${quotedColumn}`;
    const { rows } = await conn.query(sql);
    return rows.map((r) => Number(r.val));
  }

  /**
   * Calculate percentiles from sorted values using linear interpolation.
   */
  static calculatePercentiles(
    sortedValues: number[],
    percentiles: number[],
  ): Record<string, number | null> {
    const result: Record<string, number | null> = {};
    const n = sortedValues.length;
    if (n === 0) {
      for (const p of percentiles) {
        const key = `p${String(Math.round(p * 100)).padStart(2, '0')}`;
        result[key] = null;
      }
      return result;
    }

    for (const p of percentiles) {
      const key = `p${String(Math.round(p * 100)).padStart(2, '0')}`;
      const idx = p * (n - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi || hi >= n) {
        result[key] = sortedValues[lo];
      } else {
        const frac = idx - lo;
        result[key] = sortedValues[lo] + frac * (sortedValues[hi] - sortedValues[lo]);
      }
    }
    return result;
  }

  /**
   * Calculate IQR-based outlier statistics from sorted values.
   */
  static calculateIqrStats(
    sortedValues: number[],
    multiplier: number,
  ): { q1: number; q3: number; iqr: number; lower_bound: number; upper_bound: number; outlier_count: number; total_non_null: number; outlier_ratio: number } | null {
    const n = sortedValues.length;
    if (n === 0) return null;

    const q1Idx = 0.25 * (n - 1);
    const q3Idx = 0.75 * (n - 1);

    const interpolate = (idx: number) => {
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi || hi >= n) return sortedValues[lo];
      return sortedValues[lo] + (idx - lo) * (sortedValues[hi] - sortedValues[lo]);
    };

    const q1 = interpolate(q1Idx);
    const q3 = interpolate(q3Idx);
    const iqr = q3 - q1;
    const lowerBound = q1 - multiplier * iqr;
    const upperBound = q3 + multiplier * iqr;
    const outlierCount = sortedValues.filter((v) => v < lowerBound || v > upperBound).length;

    return {
      q1,
      q3,
      iqr,
      lower_bound: lowerBound,
      upper_bound: upperBound,
      outlier_count: outlierCount,
      total_non_null: n,
      outlier_ratio: n > 0 ? Math.round((outlierCount / n) * 1e6) / 1e6 : 0,
    };
  }

  async destroy(): Promise<void> {
    // No persistent pool to close for Access
  }
}
