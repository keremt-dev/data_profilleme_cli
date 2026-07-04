/**
 * YAML config loader and validator.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as yamlParse } from 'yaml';
import { appConfigSchema } from './schema.js';
import type { AppConfig, DatabaseConfig } from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(configPath: string): AppConfig {
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`Config dosyasi bulunamadi: ${configPath}`);
  }

  const raw = yamlParse(fs.readFileSync(configPath, 'utf-8'));
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('Config dosyasi bos veya gecersiz.');
  }

  const parsed = appConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Config dogrulama hatasi:\n${issues}`);
  }

  const data = parsed.data;

  // Build databases map
  const databases: Record<string, DatabaseConfig> = {};
  for (const [alias, db] of Object.entries(data.databases)) {
    // Access file existence check
    if (db.db_type === 'access' && db.dbq) {
      const resolvedPath = path.resolve(db.dbq);
      if (!fs.existsSync(resolvedPath)) {
        throw new ConfigError(`Access dosyasi bulunamadi: '${resolvedPath}' (databases.${alias}.dbq)`);
      }
    }

    databases[alias] = {
      alias,
      dbType: db.db_type,
      host: db.host,
      port: db.port,
      dbname: db.db_type === 'access' ? path.basename(db.dbq || '') : db.dbname,
      user: db.user,
      password: db.password,
      connectTimeout: db.connect_timeout,
      statementTimeout: db.statement_timeout,
      schemaFilter: db.schema_filter,
      driver: db.driver,
      serviceName: db.service_name,
      poolMax: data.profiling.concurrency,
      bwTableFilter: db.bw_table_filter,
      bwDescriptionLang: db.bw_description_lang,
      dbq: db.dbq,
    };
  }

  return {
    projectName: data.project.name,
    outputDir: data.project.output_dir,
    databases,
    profiling: {
      topNValues: data.profiling.top_n_values,
      sampleThreshold: data.profiling.sample_threshold,
      samplePercent: data.profiling.sample_percent,
      numericPercentiles: data.profiling.numeric_percentiles,
      maxPatternSample: data.profiling.max_pattern_sample,
      outlierIqrMultiplier: data.profiling.outlier_iqr_multiplier,
      concurrency: data.profiling.concurrency,
      qualityWeights: {
        completeness: data.profiling.quality_weights.completeness,
        uniqueness: data.profiling.quality_weights.uniqueness,
        consistency: data.profiling.quality_weights.consistency,
        validity: data.profiling.quality_weights.validity,
      },
      stringPatterns: data.profiling.string_patterns,
      sensitivityThreshold: data.profiling.sensitivity_threshold,
      checkpointInterval: data.profiling.checkpoint_interval,
    },
    mapping: {
      enabled: data.mapping.enabled,
      mappingFile: data.mapping.mapping_file,
    },
    reporting: {
      excelEnabled: data.reporting.excel.enabled,
      excelFilenameTemplate: data.reporting.excel.filename_template,
      htmlEnabled: data.reporting.html.enabled,
      htmlFilenameTemplate: data.reporting.html.filename_template,
      embedAssets: data.reporting.html.embed_assets,
      combinedReport: data.reporting.combined_report,
    },
    logLevel: data.logging.level,
    logFile: data.logging.file,
  };
}
