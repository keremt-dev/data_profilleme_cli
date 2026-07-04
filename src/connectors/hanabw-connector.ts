/**
 * SAP HANA BW connector using hdb (pure JS driver).
 */
import hdb, { type Client as HdbClient } from 'hdb';
import { getLogger } from '../utils/logger.js';
import { BaseConnector } from './base-connector.js';
import type { DatabaseConfig } from '../config/types.js';
import type { DbConnection, QueryResult, RowCountResult, TableInfo } from '../profiler/types.js';

const SYSTEM_SCHEMAS = new Set([
  'SYS', 'SYSTEM', '_SYS_AFL', '_SYS_BI', '_SYS_BIC', '_SYS_EPM',
  '_SYS_PLAN_STABILITY', '_SYS_REPO', '_SYS_RT', '_SYS_SECURITY',
  '_SYS_SQL_ANALYZER', '_SYS_STATISTICS', '_SYS_TASK', '_SYS_XS',
  '_SYS_DATA_ANONYMIZATION',
]);

const LANG_MAP: Record<string, string> = { TR: 'T', EN: 'E', DE: 'D' };

function createHdbClient(config: DatabaseConfig): HdbClient {
  return hdb.createClient({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
  });
}

function connectClient(client: HdbClient): Promise<void> {
  return new Promise((resolve, reject) => {
    client.connect((err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function execSql(client: HdbClient, sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    if (params && params.length > 0) {
      // Use prepare+execute for parameterized queries (hdb exec doesn't bind reliably)
      client.prepare(sql, (err, statement) => {
        if (err) return reject(err);
        statement.exec(params, (err2, rows) => {
          statement.drop();
          if (err2) reject(err2);
          else resolve(rows ?? []);
        });
      });
    } else {
      client.exec(sql, (err: Error | null, rows: Record<string, unknown>[]) => {
        if (err) reject(err);
        else resolve(rows ?? []);
      });
    }
  });
}

function disconnectClient(client: HdbClient): Promise<void> {
  return new Promise((resolve) => {
    client.disconnect(() => resolve());
  });
}

export class HanaBwConnector extends BaseConnector {
  private bwTableFilter: string[];
  private sapLang: string;

  constructor(config: DatabaseConfig) {
    super(config);
    this.bwTableFilter = config.bwTableFilter ?? ['/BIC/A', '/BIC/F'];
    this.sapLang = LANG_MAP[config.bwDescriptionLang?.toUpperCase() ?? 'TR'] ?? 'T';
  }

  async withConnection<T>(fn: (conn: DbConnection) => Promise<T>): Promise<T> {
    const client = createHdbClient(this.config);
    await connectClient(client);
    try {
      await execSql(client, 'SET TRANSACTION READ ONLY');
      await execSql(client, `SET 'statement_timeout' = '${this.config.statementTimeout}'`);

      const conn: DbConnection = {
        async query(sql: string, params?: unknown[]): Promise<QueryResult> {
          const rows = await execSql(client, sql, params);
          // hdb returns lowercase column names by default in exec
          const normalized = rows.map((row) => {
            const obj: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(row)) {
              obj[k.toLowerCase()] = v;
            }
            return obj;
          });
          return { rows: normalized };
        },
      };
      return await fn(conn);
    } finally {
      await disconnectClient(client);
    }
  }

  async executeQuery(sql: string, params?: unknown): Promise<Record<string, unknown>[] | null> {
    const client = createHdbClient(this.config);
    try {
      await connectClient(client);
      await execSql(client, 'SET TRANSACTION READ ONLY');
      const rows = await execSql(client, sql, params as unknown[] | undefined);
      return rows.map((row) => {
        const obj: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          obj[k.toLowerCase()] = v;
        }
        return obj;
      });
    } catch {
      return null;
    } finally {
      await disconnectClient(client);
    }
  }

  async testConnection(): Promise<boolean> {
    const logger = getLogger();
    try {
      const client = createHdbClient(this.config);
      await connectClient(client);
      await execSql(client, 'SELECT 1 FROM DUMMY');
      await disconnectClient(client);
      logger.info(`[${this.config.alias}] Baglanti basarili: ${this.config.host}:${this.config.port}`);
      return true;
    } catch (e) {
      logger.error(`[${this.config.alias}] Baglanti hatasi: ${e}`);
      return false;
    }
  }

  async discoverSchemas(): Promise<string[]> {
    const sql = `
      SELECT SCHEMA_NAME
      FROM SYS.SCHEMAS
      WHERE HAS_PRIVILEGES = 'TRUE'
      ORDER BY SCHEMA_NAME
    `;
    const rows = await this.executeQuery(sql) ?? [];
    const allSchemas = rows
      .map((r) => String(r.schema_name))
      .filter((s) => !SYSTEM_SCHEMAS.has(s) && !s.startsWith('_SYS_'));

    const sf = this.config.schemaFilter;
    if (sf === '*') return allSchemas;
    if (Array.isArray(sf)) {
      const upper = new Set(sf.map((s) => s.toUpperCase()));
      return allSchemas.filter((s) => upper.has(s.toUpperCase()));
    }
    if (typeof sf === 'string') {
      return allSchemas.filter((s) => s.toUpperCase() === sf.toUpperCase());
    }
    return allSchemas;
  }

  async discoverTables(schema: string): Promise<TableInfo[]> {
    const sql = `
      SELECT
        t.TABLE_NAME AS table_name,
        'BASE TABLE' AS table_type,
        COALESCE(m.RECORD_COUNT, 0) AS estimated_rows
      FROM TABLES t
      LEFT JOIN M_TABLES m
        ON t.SCHEMA_NAME = m.SCHEMA_NAME AND t.TABLE_NAME = m.TABLE_NAME
      WHERE t.SCHEMA_NAME = ?
      ORDER BY t.TABLE_NAME
    `;
    let rows = await this.executeQuery(sql, [schema]) ?? [];

    // BW table filter
    if (this.bwTableFilter.length > 0) {
      rows = rows.filter((r) => {
        const name = String(r.table_name);
        return this.bwTableFilter.some((prefix) => name.startsWith(prefix));
      });
    }

    // BW tablo aciklamalarini yukle (RSDCUBET + RSDODSOT)
    const descriptions = await this.loadBwTableDescriptions(schema);

    return rows.map((r) => {
      const name = String(r.table_name);
      const bwName = HanaBwConnector.extractBwObjectName(name);
      return {
        table_name: name,
        table_type: String(r.table_type),
        estimated_rows: Number(r.estimated_rows ?? 0),
        table_description: bwName ? (descriptions.get(bwName) ?? undefined) : undefined,
      };
    });
  }

  async getEstimatedRowCount(conn: DbConnection, schema: string, table: string): Promise<RowCountResult> {
    const sql = `
      SELECT COALESCE(RECORD_COUNT, 0) AS estimated_rows
      FROM M_TABLES
      WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?
    `;
    try {
      const { rows } = await conn.query(sql, [schema, table]);
      return { row_count: Number(rows[0]?.estimated_rows ?? 0), estimated: true };
    } catch {
      return { row_count: 0, estimated: true };
    }
  }

  async validateDbType(conn: DbConnection): Promise<boolean> {
    const logger = getLogger();
    try {
      const { rows } = await conn.query('SELECT VERSION FROM M_DATABASE');
      const version = String(rows[0]?.version ?? '');
      logger.info(`[${this.config.alias}] HANA version: ${version}`);
      return true;
    } catch (e) {
      logger.warn(`[${this.config.alias}] db_type dogrulama hatasi: ${e}`);
      return true;
    }
  }

  async getTableSize(conn: DbConnection, schema: string, table: string): Promise<number | null> {
    const sql = `
      SELECT COALESCE(SUM(DISK_SIZE), 0) AS size_bytes
      FROM M_TABLE_PERSISTENCE_STATISTICS
      WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?
    `;
    try {
      const { rows } = await conn.query(sql, [schema, table]);
      const size = Number(rows[0]?.size_bytes ?? 0);
      return size > 0 ? size : null;
    } catch {
      return null;
    }
  }

  isQueryTimeoutError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'code' in error) {
      // HANA error codes: 139 (statement cancelled), 328 (timeout)
      const code = (error as { code: number | string }).code;
      return code === 139 || code === 328 || code === '139' || code === '328';
    }
    return false;
  }

  getSapLangCode(): string {
    return this.sapLang;
  }

  getBwTableFilter(): string[] {
    return this.bwTableFilter;
  }

  /**
   * Bulk column statistics from HANA column store system view.
   * M_CS_COLUMNS provides pre-computed DISTINCT_COUNT per column.
   */
  async getColumnStatsFromCatalog(
    conn: DbConnection,
    schema: string,
    table: string,
  ): Promise<Map<string, { distinct_count: number }> | null> {
    const logger = getLogger();
    try {
      const sql = `
        SELECT COLUMN_NAME, SUM(DISTINCT_COUNT) AS distinct_count
        FROM SYS.M_CS_COLUMNS
        WHERE SCHEMA_NAME = ? AND TABLE_NAME = ? AND COUNT > 0
        GROUP BY COLUMN_NAME
      `;
      const { rows } = await conn.query(sql, [schema, table]);
      const stats = new Map<string, { distinct_count: number }>();
      for (const r of rows) {
        stats.set(String(r.column_name), {
          distinct_count: Number(r.distinct_count ?? 0),
        });
      }
      logger.debug(`[${schema}.${table}] M_CS_COLUMNS: ${stats.size} kolon istatistigi alindi`);
      return stats;
    } catch (e) {
      logger.warn(`[${schema}.${table}] M_CS_COLUMNS okunamadi, fallback: ${e}`);
      return null;
    }
  }

  /**
   * Extract BW InfoProvider name from table name.
   * DSO active:  /BIC/A<ODSOBJECT>00 → ODSOBJECT
   * DSO cl:      /BIC/A<ODSOBJECT>40 → ODSOBJECT
   * InfoCube:    /BIC/F<INFOCUBE>    → INFOCUBE
   */
  static extractBwObjectName(tableName: string): string | null {
    if (tableName.startsWith('/BIC/A') && tableName.length > 8) {
      return tableName.slice(6, -2);
    }
    if (tableName.startsWith('/BIC/F') && tableName.length > 6) {
      return tableName.slice(6);
    }
    return null;
  }

  /**
   * Load BW table descriptions from RSDCUBET (InfoCube) and RSDODSOT (DSO).
   */
  async loadBwTableDescriptions(schema: string): Promise<Map<string, string>> {
    const bwSchema = schema.toUpperCase() === 'SAPABAP1' ? schema : 'SAPABAP1';
    const descriptions = new Map<string, string>();

    // InfoCube descriptions
    const sqlCube = `
      SELECT INFOCUBE, TXTLG
      FROM "${bwSchema}".RSDCUBET
      WHERE OBJVERS = 'A' AND LANGU = ?
    `;
    const cubeRows = await this.executeQuery(sqlCube, [this.sapLang]) ?? [];
    for (const r of cubeRows) {
      descriptions.set(String(r.infocube), String(r.txtlg));
    }

    // DSO descriptions
    const sqlDso = `
      SELECT ODSOBJECT, TXTLG
      FROM "${bwSchema}".RSDODSOT
      WHERE OBJVERS = 'A' AND LANGU = ?
    `;
    const dsoRows = await this.executeQuery(sqlDso, [this.sapLang]) ?? [];
    for (const r of dsoRows) {
      descriptions.set(String(r.odsobject), String(r.txtlg));
    }

    return descriptions;
  }
}
