/**
 * Basic profiling metrics: row count, NULL ratio, distinct, min/max.
 */
import { getLogger } from '../utils/logger.js';
import type { SqlLoader } from '../sql/loader.js';
import type { BaseConnector } from '../connectors/base-connector.js';
import type { DbConnection, RowCountResult } from '../profiler/types.js';

export class BasicMetrics {
  private dbType: string;

  constructor(
    private sql: SqlLoader,
    private connector: BaseConnector,
  ) {
    this.dbType = connector['config'].dbType;
  }

  async getRowCount(conn: DbConnection, schema: string, table: string): Promise<RowCountResult> {
    const logger = getLogger();
    const identifiers: Record<string, string> = this.dbType === 'access'
      ? { table_name: table }
      : { schema_name: schema, table_name: table };
    const sqlText = this.sql.load('row_count', identifiers);
    try {
      const { rows } = await conn.query(sqlText);
      return { row_count: Number(rows[0]?.row_count ?? 0), estimated: false };
    } catch (err) {
      if (this.connector.isQueryTimeoutError(err)) {
        logger.warn(`[${schema}.${table}] row_count timeout, tahmini kullaniliyor`);
      } else {
        logger.warn(`[${schema}.${table}] row_count hatasi: ${err}`);
      }
      return this.connector.getEstimatedRowCount(conn, schema, table);
    }
  }

  async getColumnBasics(
    conn: DbConnection,
    schema: string,
    table: string,
    column: string,
    rowCount: number,
  ): Promise<Record<string, unknown>> {
    const logger = getLogger();
    const result: Record<string, unknown> = {
      total_count: rowCount,
      non_null_count: 0,
      null_count: rowCount,
      null_ratio: 1.0,
      distinct_count: 0,
      distinct_ratio: 0.0,
      min_value: null,
      max_value: null,
    };

    if (rowCount === 0) return result;

    // NULL ratio + distinct
    try {
      let sqlText: string;
      if (this.dbType === 'access') {
        const distinctExpr = `(SELECT COUNT(*) FROM (SELECT DISTINCT [${column}] FROM [${table}] WHERE [${column}] IS NOT NULL) AS t)`;
        sqlText = this.sql.load('null_ratio', {
          table_name: table,
          column_name: column,
        }, {
          distinct_count_expr: distinctExpr,
        });
      } else {
        sqlText = this.sql.load('null_ratio', {
          schema_name: schema,
          table_name: table,
          column_name: column,
        });
      }
      const { rows } = await conn.query(sqlText);
      const row = rows[0];
      if (row) {
        result.total_count = Number(row.total_count);
        result.non_null_count = Number(row.non_null_count);
        result.null_count = Number(row.null_count);
        result.null_ratio = Number(row.null_ratio);
        result.distinct_count = Number(row.distinct_count);
        result.distinct_ratio = Number(row.distinct_ratio);
      }
    } catch (err) {
      if (this.connector.isQueryTimeoutError(err)) {
        logger.warn(`[${schema}.${table}.${column}] null_ratio timeout`);
      } else {
        logger.warn(`[${schema}.${table}.${column}] null_ratio hatasi: ${err}`);
      }
    }

    // Min/max
    try {
      const mmIdent: Record<string, string> = this.dbType === 'access'
        ? { table_name: table, column_name: column }
        : { schema_name: schema, table_name: table, column_name: column };
      const sqlText = this.sql.load('min_max', mmIdent);
      const { rows } = await conn.query(sqlText);
      const row = rows[0];
      if (row) {
        result.min_value = row.min_value != null ? String(row.min_value) : null;
        result.max_value = row.max_value != null ? String(row.max_value) : null;
      }
    } catch (err) {
      if (this.connector.isQueryTimeoutError(err)) {
        logger.warn(`[${schema}.${table}.${column}] min_max timeout`);
      } else {
        logger.warn(`[${schema}.${table}.${column}] min_max hatasi: ${err}`);
      }
    }

    return result;
  }

  /**
   * Lightweight basics: NULL count only (no DISTINCT).
   * Used when distinct_count comes from system catalog.
   */
  async getColumnBasicsLite(
    conn: DbConnection,
    schema: string,
    table: string,
    column: string,
    rowCount: number,
  ): Promise<Record<string, unknown>> {
    const logger = getLogger();
    const result: Record<string, unknown> = {
      total_count: rowCount,
      non_null_count: 0,
      null_count: rowCount,
      null_ratio: 1.0,
    };

    if (rowCount === 0) return result;

    try {
      const nrIdent: Record<string, string> = this.dbType === 'access'
        ? { table_name: table, column_name: column }
        : { schema_name: schema, table_name: table, column_name: column };
      const sqlText = this.sql.load('null_ratio_lite', nrIdent);
      const { rows } = await conn.query(sqlText);
      const row = rows[0];
      if (row) {
        result.total_count = Number(row.total_count);
        result.non_null_count = Number(row.non_null_count);
        result.null_count = Number(row.null_count);
        result.null_ratio = Number(row.null_ratio);
      }
    } catch (err) {
      if (this.connector.isQueryTimeoutError(err)) {
        logger.warn(`[${schema}.${table}.${column}] null_ratio_lite timeout`);
      } else {
        logger.warn(`[${schema}.${table}.${column}] null_ratio_lite hatasi: ${err}`);
      }
    }

    // Min/max
    try {
      const mmIdent: Record<string, string> = this.dbType === 'access'
        ? { table_name: table, column_name: column }
        : { schema_name: schema, table_name: table, column_name: column };
      const sqlText = this.sql.load('min_max', mmIdent);
      const { rows } = await conn.query(sqlText);
      const row = rows[0];
      if (row) {
        result.min_value = row.min_value != null ? String(row.min_value) : null;
        result.max_value = row.max_value != null ? String(row.max_value) : null;
      }
    } catch (err) {
      if (this.connector.isQueryTimeoutError(err)) {
        logger.warn(`[${schema}.${table}.${column}] min_max timeout`);
      } else {
        logger.warn(`[${schema}.${table}.${column}] min_max hatasi: ${err}`);
      }
    }

    return result;
  }
}
