/**
 * Zod config validation schemas.
 */
import { z } from 'zod';

const dbTypeEnum = z.enum(['postgresql', 'mssql', 'oracle', 'hanabw', 'access']);

const databaseConfigSchema = z.object({
  db_type: dbTypeEnum.default('postgresql'),
  host: z.string().default(''),
  port: z.coerce.number().int().default(0),
  dbname: z.string().default(''),
  user: z.string().default(''),
  password: z.string(),
  connect_timeout: z.coerce.number().int().positive().default(15),
  statement_timeout: z.coerce.number().int().positive().default(300000),
  schema_filter: z.union([z.string(), z.array(z.string())]).default('*'),
  driver: z.string().default(''),
  service_name: z.string().default(''),
  bw_table_filter: z.array(z.string()).default(['/BIC/A', '/BIC/F']),
  bw_description_lang: z.string().default('TR'),
  dbq: z.string().default(''),
}).superRefine((data, ctx) => {
  if (data.db_type === 'access') {
    if (!data.dbq) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Access icin dbq (dosya yolu) zorunlu', path: ['dbq'] });
    }
    if (!data.driver) {
      data.driver = 'Microsoft Access Driver (*.mdb, *.accdb)';
    }
  } else {
    if (!data.host) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'host zorunlu', path: ['host'] });
    }
    if (data.db_type !== 'hanabw' && !data.dbname) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'dbname zorunlu', path: ['dbname'] });
    }
    if (!data.user) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'user zorunlu', path: ['user'] });
    }
    if (!data.port) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'port zorunlu', path: ['port'] });
    }
    if (data.db_type === 'mssql' && !data.driver) {
      data.driver = 'ODBC Driver 17 for SQL Server';
    }
  }
});

const qualityWeightsSchema = z.object({
  completeness: z.number().default(0.35),
  uniqueness: z.number().default(0.20),
  consistency: z.number().default(0.25),
  validity: z.number().default(0.20),
}).default({});

const profilingConfigSchema = z.object({
  top_n_values: z.coerce.number().int().positive().default(20),
  sample_threshold: z.coerce.number().int().positive().default(5_000_000),
  sample_percent: z.coerce.number().int().positive().default(10),
  numeric_percentiles: z.array(z.number()).default([0.01, 0.05, 0.25, 0.50, 0.75, 0.95, 0.99]),
  max_pattern_sample: z.coerce.number().int().positive().default(100_000),
  outlier_iqr_multiplier: z.number().positive().default(1.5),
  concurrency: z.coerce.number().int().min(1).max(20).default(3),
  quality_weights: qualityWeightsSchema,
  string_patterns: z.record(z.string()).default({
    email: '.+@.+\\..+',
    phone_tr: '^(\\+90|0)[0-9]{10}$',
    tc_kimlik: '^[1-9][0-9]{10}$',
    iban: '^TR[0-9]{24}$',
    credit_card: '^[0-9]{13,19}$',
  }),
  sensitivity_threshold: z.enum(['none', 'low', 'medium', 'high']).default('low'),
  checkpoint_interval: z.coerce.number().int().min(10).default(100),
}).default({});

const mappingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mapping_file: z.string().default(''),
}).default({});

const excelConfigSchema = z.object({
  enabled: z.boolean().default(true),
  filename_template: z.string().default('profil_{db_alias}_{timestamp}.xlsx'),
}).default({});

const htmlConfigSchema = z.object({
  enabled: z.boolean().default(true),
  filename_template: z.string().default('profil_{db_alias}_{timestamp}.html'),
  embed_assets: z.boolean().default(true),
}).default({});

const reportingConfigSchema = z.object({
  excel: excelConfigSchema,
  html: htmlConfigSchema,
  combined_report: z.boolean().default(true),
}).default({});

const projectConfigSchema = z.object({
  name: z.string().default('Profilleme'),
  output_dir: z.string().default('./output'),
}).default({});

const loggingConfigSchema = z.object({
  level: z.string().default('INFO'),
  file: z.string().default('./output/profil.log'),
}).default({});

export const appConfigSchema = z.object({
  project: projectConfigSchema,
  databases: z.record(databaseConfigSchema).refine(
    (dbs) => Object.keys(dbs).length > 0,
    { message: 'En az bir veritabani tanimlanmali (databases bolumu).' },
  ),
  profiling: profilingConfigSchema,
  mapping: mappingConfigSchema,
  reporting: reportingConfigSchema,
  logging: loggingConfigSchema,
});

export type RawAppConfig = z.infer<typeof appConfigSchema>;
