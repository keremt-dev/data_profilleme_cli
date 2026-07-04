/**
 * App configuration types.
 */
import type { SensitivityLevel } from '../metrics/sensitivity.js';

export type DbType = 'postgresql' | 'mssql' | 'oracle' | 'hanabw' | 'access';

export interface DatabaseConfig {
  alias: string;
  dbType: DbType;
  host: string;
  port: number;
  dbname: string;
  user: string;
  password: string;
  connectTimeout: number;
  statementTimeout: number;
  schemaFilter: string | string[];
  driver: string;
  serviceName: string;
  poolMax: number;
  bwTableFilter: string[];
  bwDescriptionLang: string;
  dbq: string;
}

export interface QualityWeights {
  completeness: number;
  uniqueness: number;
  consistency: number;
  validity: number;
}

export interface ProfilingConfig {
  topNValues: number;
  sampleThreshold: number;
  samplePercent: number;
  numericPercentiles: number[];
  maxPatternSample: number;
  outlierIqrMultiplier: number;
  concurrency: number;
  qualityWeights: QualityWeights;
  stringPatterns: Record<string, string>;
  sensitivityThreshold: SensitivityLevel;
  checkpointInterval: number;
}

export interface MappingConfig {
  enabled: boolean;
  mappingFile: string;
}

export interface ReportingConfig {
  excelEnabled: boolean;
  excelFilenameTemplate: string;
  htmlEnabled: boolean;
  htmlFilenameTemplate: string;
  embedAssets: boolean;
  combinedReport: boolean;
}

export interface AppConfig {
  projectName: string;
  outputDir: string;
  databases: Record<string, DatabaseConfig>;
  profiling: ProfilingConfig;
  mapping: MappingConfig;
  reporting: ReportingConfig;
  logLevel: string;
  logFile: string;
}
