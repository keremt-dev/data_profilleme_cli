/**
 * Abstract database connector interface.
 */
import type { DatabaseConfig } from '../config/types.js';
import type { DbConnection, QueryResult, RowCountResult, TableInfo } from '../profiler/types.js';

export abstract class BaseConnector {
  constructor(protected config: DatabaseConfig) {}

  abstract withConnection<T>(fn: (conn: DbConnection) => Promise<T>): Promise<T>;
  abstract testConnection(): Promise<boolean>;
  abstract discoverSchemas(): Promise<string[]>;
  abstract discoverTables(schema: string): Promise<TableInfo[]>;
  abstract getEstimatedRowCount(conn: DbConnection, schema: string, table: string): Promise<RowCountResult>;
  abstract validateDbType(conn: DbConnection): Promise<boolean>;
  abstract getTableSize(conn: DbConnection, schema: string, table: string): Promise<number | null>;
  abstract isQueryTimeoutError(error: unknown): boolean;
  abstract executeQuery(sql: string, params?: unknown): Promise<Record<string, unknown>[] | null>;

  /**
   * Bulk column statistics from system catalog (optional).
   * Returns Map<column_name, { distinct_count }>.
   * Override in connectors that support catalog-level stats (e.g. HANA M_CS_COLUMNS).
   */
  async getColumnStatsFromCatalog(
    _conn: DbConnection,
    _schema: string,
    _table: string,
  ): Promise<Map<string, { distinct_count: number }> | null> {
    return null;
  }
}
