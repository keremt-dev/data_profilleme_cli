/**
 * Main profiling orchestrator.
 */
import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { SingleBar, Presets } from 'cli-progress';
import { getLogger } from '../utils/logger.js';
import type { AppConfig, DatabaseConfig } from '../config/types.js';
import { SqlLoader } from '../sql/loader.js';
import { BasicMetrics } from '../metrics/basic.js';
import { DistributionMetrics, isNumericType, isNonComparableType } from '../metrics/distribution.js';
import { PatternAnalyzer, isStringType } from '../metrics/pattern.js';
import { OutlierDetector } from '../metrics/outlier.js';
import { QualityScorer } from '../metrics/quality.js';
import { SensitivityAnalyzer } from '../metrics/sensitivity.js';
import type { BaseConnector } from '../connectors/base-connector.js';
import type {
  ColumnProfile,
  DatabaseProfile,
  DbConnection,
  IncrementalSummary,
  SchemaProfile,
  TableProfile,
  TableInfo,
  createDefaultColumnProfile,
} from './types.js';
import { createDefaultColumnProfile as makeColProfile, formatSize } from './types.js';
import { CheckpointManager } from './checkpoint-manager.js';

export class Profiler {
  private connector: BaseConnector;
  private sql: SqlLoader;
  private basic: BasicMetrics;
  private distribution: DistributionMetrics;
  private pattern: PatternAnalyzer;
  private outlier: OutlierDetector;
  private quality: QualityScorer;
  private profConfig: AppConfig['profiling'];
  private dbConfig: DatabaseConfig;
  private checkpointManager: CheckpointManager;
  private checkpointInterval: number;
  private outputDir: string;

  constructor(config: AppConfig, dbKey: string, connector: BaseConnector, sqlDir: string) {
    this.dbConfig = config.databases[dbKey];
    this.connector = connector;
    this.sql = new SqlLoader(sqlDir, this.dbConfig.dbType);
    this.basic = new BasicMetrics(this.sql, this.connector);
    this.distribution = new DistributionMetrics(this.sql, this.connector);
    this.pattern = new PatternAnalyzer(
      this.sql,
      config.profiling.stringPatterns,
      config.profiling.maxPatternSample,
      this.dbConfig.dbType,
    );
    this.outlier = new OutlierDetector(this.sql, this.connector);
    this.quality = new QualityScorer(config.profiling.qualityWeights);
    this.profConfig = config.profiling;
    this.checkpointInterval = config.profiling.checkpointInterval;
    this.outputDir = config.outputDir;
    this.checkpointManager = new CheckpointManager(config.outputDir);
  }

  async profileDatabase(
    tableFilter?: Map<string, string[]>,
    previousProfile?: DatabaseProfile,
  ): Promise<DatabaseProfile> {
    const logger = getLogger();
    const dbProfile: DatabaseProfile = {
      db_alias: this.dbConfig.alias,
      db_name: this.dbConfig.dbname,
      host: this.dbConfig.host,
      profiled_at: new Date().toISOString(),
      total_schemas: 0,
      total_tables: 0,
      total_columns: 0,
      total_rows: 0,
      total_size_bytes: 0,
      total_size_display: '0 B',
      schemas: [],
      overall_quality_score: 0,
    };

    // Build previous-profile lookup for incremental mode
    const prevTableMap = new Map<string, TableProfile>();
    if (previousProfile) {
      for (const schema of previousProfile.schemas) {
        for (const table of schema.tables) {
          prevTableMap.set(`${schema.schema_name}.${table.table_name}`, table);
        }
      }
      logger.info(`[${this.dbConfig.alias}] Incremental mod: ${prevTableMap.size} onceki tablo yuklendi.`);
    }

    // Checkpoint resume
    const completedTables = new Set<string>();
    const checkpointData = this.checkpointManager.load(this.dbConfig.alias);
    if (checkpointData) {
      for (const t of checkpointData.completed_tables) {
        completedTables.add(t);
      }
      // Restore partial profile schemas
      for (const schema of checkpointData.partial_profile.schemas) {
        dbProfile.schemas.push(schema);
      }
      logger.info(
        `[${this.dbConfig.alias}] Checkpoint'ten devam ediliyor: ${completedTables.size} tablo atlanacak`,
      );
    }

    // Checkpoint'teki tamamlanmis tablolarin profillerine hizli erisim icin lookup.
    // Resume sirasinda atlanan tablolarin verisini yeni schema objesine geri yuklemek icin kullanilir.
    const checkpointTableMap = new Map<string, TableProfile>();
    if (checkpointData) {
      for (const s of checkpointData.partial_profile.schemas) {
        for (const t of s.tables) {
          checkpointTableMap.set(`${s.schema_name}.${t.table_name}`, t);
        }
      }
    }

    if (!(await this.connector.testConnection())) {
      logger.error(`[${this.dbConfig.alias}] Baglanti kurulamadi, profilleme iptal.`);
      return dbProfile;
    }

    // DB type validation
    const valid = await this.connector.withConnection(async (conn) => {
      return this.connector.validateDbType(conn);
    });
    if (!valid) {
      logger.error(`[${this.dbConfig.alias}] db_type=${this.dbConfig.dbType} ile sunucu uyumsuz, profilleme iptal.`);
      return dbProfile;
    }

    const schemas = await this.connector.discoverSchemas();
    logger.info(`[${this.dbConfig.alias}] ${schemas.length} sema kesfedildi: ${schemas.join(', ')}`);

    // Count total tables for progress bar
    let totalTables = 0;
    const schemaTables = new Map<string, TableInfo[]>();
    for (const schema of schemas) {
      let tables = await this.connector.discoverTables(schema);
      if (tableFilter?.has(schema)) {
        const allowed = tableFilter.get(schema)!;
        tables = tables.filter((t) => allowed.includes(t.table_name));
      }
      schemaTables.set(schema, tables);
      totalTables += tables.length;
    }

    logger.info(`[${this.dbConfig.alias}] Toplam ${totalTables} tablo profillecek.`);

    const pbar = new SingleBar(
      { format: `[${this.dbConfig.alias}] Profilleme |{bar}| {percentage}% | {value}/{total} | {postfix}` },
      Presets.shades_classic,
    );
    pbar.start(totalTables, completedTables.size, { postfix: '' });

    // Graceful shutdown: Ctrl+C checkpoint kaydedip ciksin
    // Windows raw-mode stdin'de SIGINT yerine \x03 byte gelir
    let interrupted = false;
    const doShutdown = () => {
      if (interrupted) return;
      interrupted = true;
      pbar.stop();
      logger.info(`[${this.dbConfig.alias}] Durduruldu, checkpoint kaydediliyor...`);
      this.checkpointManager.save(dbProfile, completedTables);
      logger.info(`[${this.dbConfig.alias}] Checkpoint kaydedildi (${completedTables.size}/${totalTables} tablo). Devam etmek icin tekrar calistirin.`);
      process.exit(0);
    };
    process.on('SIGINT', doShutdown);
    const onData = (data: Buffer) => {
      if (data[0] === 0x03) doShutdown(); // Ctrl+C in raw mode
    };
    process.stdin.on('data', onData);

    for (const schema of schemas) {
      const tables = schemaTables.get(schema) ?? [];

      // Remove previously checkpointed version of this schema (resume case)
      dbProfile.schemas = dbProfile.schemas.filter((s) => s.schema_name !== schema);

      // Push schema early so in-progress tables are visible in checkpoint
      const schemaProf: SchemaProfile = {
        schema_name: schema,
        table_count: tables.length,
        total_rows: 0,
        total_size_bytes: 0,
        total_size_display: '0 B',
        tables: [],
        schema_quality_score: 0,
      };

      // Resume: checkpoint'te tamamlanmis tablolarin profilini yeni schema'ya geri yukle.
      // Bu olmadan atlanan tablolar (profileSchema icinde skip edilir) ciktidan tamamen kaybolur.
      if (completedTables.size > 0) {
        for (const t of tables) {
          const key = `${schema}.${t.table_name}`;
          if (completedTables.has(key)) {
            const prev = checkpointTableMap.get(key);
            if (prev) {
              schemaProf.tables.push(prev);
              schemaProf.total_rows += prev.row_count;
              schemaProf.total_size_bytes += prev.table_size_bytes ?? 0;
            }
          }
        }
      }

      dbProfile.schemas.push(schemaProf);

      await this.profileSchema(schema, tables, pbar, completedTables, schemaProf, dbProfile, prevTableMap);

      // Checkpoint: save after each schema
      this.checkpointManager.save(dbProfile, completedTables);
    }

    process.removeListener('SIGINT', doShutdown);
    process.stdin.removeListener('data', onData);
    pbar.stop();

    // Aggregation
    dbProfile.total_schemas = dbProfile.schemas.length;
    dbProfile.total_tables = dbProfile.schemas.reduce((s, sc) => s + sc.table_count, 0);
    dbProfile.total_columns = dbProfile.schemas.reduce(
      (s, sc) => s + sc.tables.reduce((t, tbl) => t + tbl.column_count, 0),
      0,
    );
    dbProfile.total_rows = dbProfile.schemas.reduce((s, sc) => s + sc.total_rows, 0);
    dbProfile.total_size_bytes = dbProfile.schemas.reduce((s, sc) => s + sc.total_size_bytes, 0);
    dbProfile.total_size_display = formatSize(dbProfile.total_size_bytes);

    const scoredSchemas = dbProfile.schemas.filter((s) => s.schema_quality_score > 0);
    if (scoredSchemas.length > 0) {
      dbProfile.overall_quality_score =
        scoredSchemas.reduce((s, sc) => s + sc.schema_quality_score, 0) / scoredSchemas.length;
    }

    // Incremental summary
    if (previousProfile) {
      const summary: IncrementalSummary = {
        enabled: true,
        baseline_profiled_at: previousProfile.profiled_at,
        tables_changed: 0,
        tables_unchanged: 0,
        tables_new: 0,
      };
      for (const schema of dbProfile.schemas) {
        for (const table of schema.tables) {
          if (table.incremental_status === 'unchanged') summary.tables_unchanged++;
          else if (table.incremental_status === 'new') summary.tables_new++;
          else if (table.incremental_status === 'changed') summary.tables_changed++;
        }
      }
      dbProfile.incremental = summary;
      logger.info(
        `[${this.dbConfig.alias}] Incremental sonuc: ` +
        `${summary.tables_changed} degisen, ${summary.tables_unchanged} degismeyen, ${summary.tables_new} yeni`,
      );
    }

    // Clear checkpoint after successful completion
    this.checkpointManager.clear(this.dbConfig.alias);

    return dbProfile;
  }

  private async profileSchema(
    schema: string,
    tables: TableInfo[],
    pbar: SingleBar,
    completedTables: Set<string>,
    schemaProf: SchemaProfile,
    dbProfile: DatabaseProfile,
    prevTableMap?: Map<string, TableProfile>,
  ): Promise<void> {
    const logger = getLogger();
    const concurrency = this.profConfig.concurrency;

    // Prefetch metadata with a single connection
    const metadata = await this.connector.withConnection(async (conn) => {
      return this.fetchSchemaMetadata(conn, schema);
    });

    // Profile tables in parallel with concurrency limit
    const limit = pLimit(concurrency);
    const activeTables = new Set<string>();

    const updatePostfix = () => {
      const names = [...activeTables];
      pbar.update({ postfix: names.length > 0 ? names.join(', ') : '' });
    };

    // Process tables in batches for checkpoint support
    const interval = this.checkpointInterval;
    let tablesSinceCheckpoint = 0;

    const tasks = tables.map((tableInfo) =>
      limit(async () => {
        const tableName = tableInfo.table_name;
        const tableType = tableInfo.table_type;
        const estimated = tableInfo.estimated_rows;
        const prevKey = `${schema}.${tableName}`;

        // Checkpoint resume: skip already completed tables
        // pbar.increment() yapma — startValue'da zaten sayildi
        if (completedTables.has(prevKey)) {
          return null;
        }

        activeTables.add(tableName);
        updatePostfix();

        try {
          let result: TableProfile | null = null;

          // Incremental: check if table changed since baseline
          if (prevTableMap?.has(prevKey)) {
            const prev = prevTableMap.get(prevKey)!;
            const rc = await this.connector.withConnection(async (conn) => {
              return this.basic.getRowCount(conn, schema, tableName);
            });
            const colMeta = metadata.get(tableName) ?? [];

            if (rc.row_count === prev.row_count && colMeta.length === prev.column_count) {
              result = {
                ...prev,
                estimated_rows: estimated,
                incremental_status: 'unchanged',
              };
              logger.info(`[${prevKey}] Degisiklik yok, onceki profil tasindi.`);
            }
          }

          if (!result) {
            result = await this.connector.withConnection(async (conn) => {
              return this.profileTable(conn, schema, tableName, tableType, estimated, metadata, tableInfo.table_description);
            });

            // Mark incremental status
            if (prevTableMap) {
              result.incremental_status = prevTableMap.has(prevKey) ? 'changed' : 'new';
            }
          }

          // Immediately track completed table for checkpoint
          schemaProf.tables.push(result);
          schemaProf.total_rows += result.row_count;
          schemaProf.total_size_bytes += result.table_size_bytes ?? 0;
          completedTables.add(prevKey);
          tablesSinceCheckpoint++;

          if (tablesSinceCheckpoint >= interval) {
            this.checkpointManager.save(dbProfile, completedTables);
            tablesSinceCheckpoint = 0;
          }

          return result;
        } catch (e) {
          logger.error(`[${schema}.${tableName}] Tablo profilleme hatasi: ${e}`);
          return null;
        } finally {
          activeTables.delete(tableName);
          pbar.increment();
          updatePostfix();
        }
      }),
    );

    await Promise.all(tasks);

    schemaProf.total_size_display = formatSize(schemaProf.total_size_bytes);

    // Schema quality (empty tables excluded)
    const scoredTables = schemaProf.tables.filter(
      (t) => t.row_count > 0 && t.table_quality_grade !== 'N/A',
    );
    if (scoredTables.length > 0) {
      schemaProf.schema_quality_score =
        scoredTables.reduce((s, t) => s + t.table_quality_score, 0) / scoredTables.length;
    }

  }

  private async fetchSchemaMetadata(
    conn: DbConnection,
    schema: string,
  ): Promise<Map<string, Record<string, unknown>[]>> {
    const logger = getLogger();
    const sqlText = this.sql.load('metadata');
    const metadata = new Map<string, Record<string, unknown>[]>();

    // Access: metadata via ODBC API (no SQL catalog)
    if (this.dbConfig.dbType === 'access') {
      try {
        const { AccessConnector } = await import('../connectors/access-connector.js');
        const accessConn = this.connector as InstanceType<typeof AccessConnector>;
        const tables = await this.connector.discoverTables(schema);
        return await accessConn.getTableMetadataViaOdbc(tables.map((t) => t.table_name));
      } catch (e) {
        logger.warn(`[${schema}] Access metadata cekme hatasi: ${e}`);
        return metadata;
      }
    }

    try {
      let result;
      if (this.dbConfig.dbType === 'mssql') {
        result = await conn.query(sqlText, [schema]);
      } else if (this.dbConfig.dbType === 'oracle') {
        // Oracle: :schema_name -> inlined. Schema validated via discoverSchemas().
        const safeName = schema.replace(/'/g, "''");
        const inlined = sqlText.replace(/:schema_name/g, `'${safeName}'`);
        result = await conn.query(inlined);
      } else if (this.dbConfig.dbType === 'hanabw') {
        // HANA BW: RSDIOBJT always in SAPABAP1 schema, params: [lang_code, schema_name]
        const { HanaBwConnector } = await import('../connectors/hanabw-connector.js');
        const connector = this.connector as InstanceType<typeof HanaBwConnector>;
        const sapLang = connector.getSapLangCode();
        const rsdiobjSchema = schema.toUpperCase() === 'SAPABAP1' ? schema : 'SAPABAP1';
        const inlined = sqlText.replaceAll('RSDIOBJT', `"${rsdiobjSchema}"."RSDIOBJT"`);
        result = await conn.query(inlined, [sapLang, schema]);
      } else {
        // information_schema queries fail with parameterised $1 on complex
        // subqueries (pg cannot infer sql_identifier type).  Schema name is
        // already validated via discoverSchemas(), so inline is safe.
        const safeName = schema.replace(/'/g, "''");
        const inlined = sqlText.replace(/%\(\w+\)s(::text)?/g, `'${safeName}'`);
        result = await conn.query(inlined);
      }

      for (const row of result.rows) {
        const tname = String(row.table_name);
        if (!metadata.has(tname)) {
          metadata.set(tname, []);
        }
        metadata.get(tname)!.push(row);
      }
    } catch (e) {
      logger.warn(`[${schema}] Metadata cekme hatasi: ${e}`);
    }

    return metadata;
  }

  private async profileTable(
    conn: DbConnection,
    schema: string,
    table: string,
    tableType: string,
    estimatedRows: number,
    metadata: Map<string, Record<string, unknown>[]>,
    tableDescription?: string | null,
  ): Promise<TableProfile> {
    const startTime = Date.now();

    // Row count & table size
    const rc = await this.basic.getRowCount(conn, schema, table);
    const rowCount = rc.row_count;
    const rowEstimated = rc.estimated;
    const tableSizeBytes = await this.connector.getTableSize(conn, schema, table);

    // Sampling decision
    const sampled = rowCount > this.profConfig.sampleThreshold;
    const samplePct = sampled ? this.profConfig.samplePercent : null;

    // Column metadata
    const colMeta = metadata.get(table) ?? [];
    const tableDesc = tableDescription
      ?? (colMeta[0]?.table_description != null ? String(colMeta[0].table_description) : null);
    if (colMeta.length === 0) {
      return {
        schema_name: schema,
        table_name: table,
        table_type: tableType,
        description: null,
        row_count: rowCount,
        estimated_rows: estimatedRows,
        row_count_estimated: rowEstimated,
        column_count: 0,
        columns: [],
        profiled_at: new Date().toISOString(),
        profile_duration_sec: (Date.now() - startTime) / 1000,
        sampled,
        sample_percent: samplePct,
        table_size_bytes: tableSizeBytes,
        table_size_display: formatSize(tableSizeBytes),
        table_quality_score: 0,
        table_quality_grade: 'N/A',
        dwh_mapped: false,
        dwh_target_tables: [],
      };
    }

    const columns: ColumnProfile[] = [];
    const logger = getLogger();

    for (const cm of colMeta) {
      try {
        const colProf = await this.profileColumn(conn, schema, table, cm, rowCount);
        columns.push(colProf);
      } catch (e) {
        logger.warn(`[${schema}.${table}.${cm.column_name ?? '?'}] Kolon profilleme hatasi: ${e}`);
      }
    }

    // Table quality
    let tqScore = 0;
    let tqGrade = 'N/A';
    if (rowCount > 0) {
      const scoredCols = columns.filter((c) => c.quality_score > 0);
      if (scoredCols.length > 0) {
        tqScore = scoredCols.reduce((s, c) => s + c.quality_score, 0) / scoredCols.length;
        tqGrade = QualityScorer.grade(tqScore);
      }
    }

    return {
      schema_name: schema,
      table_name: table,
      table_type: tableType,
      description: tableDesc,
      row_count: rowCount,
      estimated_rows: estimatedRows,
      row_count_estimated: rowEstimated,
      column_count: columns.length,
      columns,
      profiled_at: new Date().toISOString(),
      profile_duration_sec: Math.round((Date.now() - startTime) / 10) / 100,
      sampled,
      sample_percent: samplePct,
      table_size_bytes: tableSizeBytes,
      table_size_display: formatSize(tableSizeBytes),
      table_quality_score: tqScore,
      table_quality_grade: tqGrade,
      dwh_mapped: false,
      dwh_target_tables: [],
    };
  }

  private async profileColumn(
    conn: DbConnection,
    schema: string,
    table: string,
    colMeta: Record<string, unknown>,
    rowCount: number,
  ): Promise<ColumnProfile> {
    const colName = String(colMeta.column_name);
    const dataType = String(colMeta.data_type);

    const colProf = makeColProfile(colMeta);

    if (rowCount === 0) {
      colProf.quality_flags.push('empty_table');
      colProf.quality_grade = 'N/A';
      return colProf;
    }

    // MSSQL non-comparable types: skip basic/topN/pattern metrics
    if (isNonComparableType(dataType, this.dbConfig.dbType)) {
      colProf.quality_flags.push('non_comparable_type');
      colProf.quality_grade = 'N/A';
      return colProf;
    }

    // Basic metrics
    const basics = await this.basic.getColumnBasics(conn, schema, table, colName, rowCount);
    colProf.null_count = Number(basics.null_count);
    colProf.null_ratio = Number(basics.null_ratio);
    colProf.distinct_count = Number(basics.distinct_count);
    colProf.distinct_ratio = Number(basics.distinct_ratio);
    colProf.min_value = basics.min_value != null ? String(basics.min_value) : null;
    colProf.max_value = basics.max_value != null ? String(basics.max_value) : null;

    // Top N values
    colProf.top_n_values = await this.distribution.getTopN(
      conn, schema, table, colName,
      this.profConfig.topNValues, rowCount,
    );

    // Numeric specific
    if (isNumericType(dataType)) {
      const stats = await this.distribution.getNumericStats(conn, schema, table, colName);
      if (stats) {
        colProf.mean = stats.mean ?? null;
        colProf.stddev = stats.stddev ?? null;
        colProf.percentiles = {};
        for (const [k, v] of Object.entries(stats)) {
          if (k.startsWith('p') && v != null) {
            colProf.percentiles[k] = v;
          }
        }
      }

      colProf.histogram = await this.distribution.getHistogram(conn, schema, table, colName);

      // Outlier detection
      const outlierResult = await this.outlier.detect(
        conn, schema, table, colName,
        this.profConfig.outlierIqrMultiplier,
      );
      if (outlierResult) {
        colProf.outlier_count = outlierResult.outlier_count;
        colProf.outlier_ratio = outlierResult.outlier_ratio;
        colProf.outlier_bounds = {
          lower: outlierResult.lower_bound,
          upper: outlierResult.upper_bound,
          q1: outlierResult.q1,
          q3: outlierResult.q3,
          iqr: outlierResult.iqr,
        };
      }
    }

    // String pattern analysis
    if (isStringType(dataType)) {
      const patternResult = await this.pattern.analyze(conn, schema, table, colName, rowCount);
      if (patternResult) {
        colProf.detected_patterns = patternResult.patterns;
        colProf.dominant_pattern = patternResult.dominant_pattern;
      }
    }

    // Quality scoring
    const { score, grade, flags } = this.quality.scoreColumn(colProf);
    colProf.quality_score = score;
    colProf.quality_grade = grade;
    colProf.quality_flags = flags;

    // Sensitivity analysis
    colProf.sensitivity = SensitivityAnalyzer.analyze(colProf);

    if (colProf.sensitivity?.level === 'high' && !colProf.quality_flags.includes('suspected_pii')) {
      colProf.quality_flags.push('suspected_pii');
    }

    return colProf;
  }

  saveIntermediate(profile: DatabaseProfile, outputDir: string): string {
    fs.mkdirSync(outputDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1_$2');
    const filename = `profil_${profile.db_alias}_${timestamp}.json`;
    const filepath = path.join(outputDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(profile, null, 2), 'utf-8');

    const logger = getLogger();
    logger.info(`Ara sonuc kaydedildi: ${filepath}`);
    return filepath;
  }
}
