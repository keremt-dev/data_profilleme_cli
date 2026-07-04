/**
 * IQR-based outlier detection.
 */
import { getLogger } from '../utils/logger.js';
import type { SqlLoader } from '../sql/loader.js';
import type { BaseConnector } from '../connectors/base-connector.js';
import type { DbConnection } from '../profiler/types.js';

export interface OutlierResult {
  q1: number;
  q3: number;
  iqr: number;
  lower_bound: number;
  upper_bound: number;
  outlier_count: number;
  total_non_null: number;
  outlier_ratio: number;
}

export class OutlierDetector {
  private dbType: string;

  constructor(
    private sql: SqlLoader,
    private connector: BaseConnector,
  ) {
    this.dbType = connector['config'].dbType;
  }

  async detect(
    conn: DbConnection,
    schema: string,
    table: string,
    column: string,
    iqrMultiplier: number = 1.5,
    samplePct?: number | null,
  ): Promise<OutlierResult | null> {
    const logger = getLogger();
    if (this.dbType === 'access') {
      return this.detectAccessOutliers(conn, table, column, iqrMultiplier);
    }
    try {
      let sqlText = this.sql.load('outlier_detection', {
        schema_name: schema,
        table_name: table,
        column_name: column,
      });
      sqlText = sqlText.replaceAll('{sample_clause}', samplePct ? `TABLESAMPLE SYSTEM (${Math.floor(samplePct)})` : '');

      let result;
      if (this.dbType === 'mssql' || this.dbType === 'hanabw') {
        // MSSQL/HANA: ? positional params (multiplier x2)
        result = await conn.query(sqlText, [iqrMultiplier, iqrMultiplier]);
      } else if (this.dbType === 'oracle') {
        // Oracle: :iqr_multiplier named bind -> inlined
        const ora = this.sql.oracleParams(sqlText, { iqr_multiplier: iqrMultiplier });
        result = await conn.query(ora.sql, ora.values);
      } else {
        // PostgreSQL: %(iqr_multiplier)s -> inlined
        const pg = this.sql.pgParams(sqlText, { iqr_multiplier: iqrMultiplier });
        result = await conn.query(pg.sql, pg.values);
      }

      const row = result.rows[0];
      if (!row || row.q1 == null) return null;

      const q1 = Number(row.q1);
      const q3 = Number(row.q3);
      const iqr = Number(row.iqr);
      const lowerBound = Number(row.lower_bound);
      const upperBound = Number(row.upper_bound);
      const outlierCount = Number(row.outlier_count);
      const totalNonNull = Number(row.total_non_null);
      const outlierRatio = totalNonNull > 0
        ? Math.round((outlierCount / totalNonNull) * 1e6) / 1e6
        : 0.0;

      return {
        q1,
        q3,
        iqr,
        lower_bound: lowerBound,
        upper_bound: upperBound,
        outlier_count: outlierCount,
        total_non_null: totalNonNull,
        outlier_ratio: outlierRatio,
      };
    } catch (err) {
      if (this.connector.isQueryTimeoutError(err)) {
        logger.warn(`[${schema}.${table}.${column}] outlier detection timeout`);
      } else {
        logger.warn(`[${schema}.${table}.${column}] outlier detection hatasi: ${err}`);
      }
    }
    return null;
  }

  /**
   * Access outlier detection: fetch sorted values, compute IQR in Node.js.
   */
  private async detectAccessOutliers(
    conn: DbConnection,
    table: string,
    column: string,
    iqrMultiplier: number,
  ): Promise<OutlierResult | null> {
    const logger = getLogger();
    try {
      const { AccessConnector } = await import('../connectors/access-connector.js');
      const accessConn = this.connector as InstanceType<typeof AccessConnector>;
      const sortedValues = await accessConn.getSortedColumnValues(conn, table, column);
      return AccessConnector.calculateIqrStats(sortedValues, iqrMultiplier);
    } catch (err) {
      logger.warn(`[default.${table}.${column}] access outlier detection hatasi: ${err}`);
    }
    return null;
  }
}
