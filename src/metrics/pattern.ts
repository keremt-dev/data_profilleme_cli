/**
 * String column pattern analysis.
 */
import { getLogger } from '../utils/logger.js';
import type { SqlLoader } from '../sql/loader.js';
import type { DbConnection } from '../profiler/types.js';

// String types (PostgreSQL + MSSQL + Oracle)
const STRING_TYPES = new Set([
  // PostgreSQL
  'character varying', 'varchar', 'character', 'char', 'text',
  'name', 'citext', 'bpchar',
  // MSSQL
  'nvarchar', 'nchar', 'ntext',
  // Oracle
  'varchar2', 'nvarchar2', 'clob', 'nclob', 'long',
  // HANA
  'nvarchar', 'nchar', 'nclob', 'shorttext', 'alphanum',
  // Access
  'text', 'memo', 'varchar', 'char',
]);

// MSSQL pattern map (LIKE/PATINDEX equivalents of regex)
const MSSQL_PATTERN_MAP: Record<string, string> = {
  email: "PATINDEX('_%@_%._%', val) > 0",
  phone_tr: "(val LIKE '+90[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' OR val LIKE '0[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' OR (LEN(val) = 10 AND PATINDEX('%[^0-9]%', val) = 0))",
  tc_kimlik: "(LEN(val) = 11 AND LEFT(val, 1) <> '0' AND PATINDEX('%[^0-9]%', val) = 0)",
  uuid: "(LEN(val) = 36 AND SUBSTRING(val,9,1) = '-' AND SUBSTRING(val,14,1) = '-' AND SUBSTRING(val,19,1) = '-' AND SUBSTRING(val,24,1) = '-')",
  iso_date: "(LEN(val) >= 10 AND PATINDEX('[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]%', val) = 1)",
  iso_datetime: "(LEN(val) >= 16 AND PATINDEX('[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]%', val) = 1)",
  url: "(val LIKE 'http://%' OR val LIKE 'https://%')",
  json_object: "(LEFT(val, 1) = '{' AND RIGHT(val, 1) = '}')",
  numeric_string: "(PATINDEX('%[^0-9.+-]%', val) = 0 AND LEN(val) > 0)",
  iban: "(LEN(val) = 26 AND LEFT(val,2) = 'TR' AND PATINDEX('%[^0-9]%', SUBSTRING(val,3,24)) = 0)",
  credit_card: "(LEN(REPLACE(REPLACE(val,' ',''),'-','')) BETWEEN 13 AND 19 AND PATINDEX('%[^0-9]%', REPLACE(REPLACE(val,' ',''),'-','')) = 0)",
};

// HANA LIKE_REGEXPR pattern map
const HANA_PATTERN_MAP: Record<string, string> = {
  email: "val LIKE_REGEXPR '.+@.+\\..+'",
  phone_tr: "(val LIKE_REGEXPR '^\\+90[0-9]{10}$' OR val LIKE_REGEXPR '^0[0-9]{10}$' OR (LENGTH(val) = 10 AND val LIKE_REGEXPR '^[0-9]+$'))",
  tc_kimlik: "(LENGTH(val) = 11 AND SUBSTR(val,1,1) != '0' AND val LIKE_REGEXPR '^[0-9]+$')",
  uuid: "val LIKE_REGEXPR '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'",
  iso_date: "val LIKE_REGEXPR '^[0-9]{4}-[0-9]{2}-[0-9]{2}'",
  iso_datetime: "val LIKE_REGEXPR '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}'",
  url: "(val LIKE 'http://%' OR val LIKE 'https://%')",
  json_object: "(SUBSTR(val,1,1) = '{' AND SUBSTR(val,LENGTH(val)) = '}')",
  numeric_string: "(val LIKE_REGEXPR '^[0-9.+-]+$' AND LENGTH(val) > 0)",
  iban: "val LIKE_REGEXPR '^TR[0-9]{24}$'",
  credit_card: "(LENGTH(REPLACE(REPLACE(val,' ',''),'-','')) BETWEEN 13 AND 19 AND REPLACE(REPLACE(val,' ',''),'-','') LIKE_REGEXPR '^[0-9]+$')",
};

// Oracle REGEXP_LIKE pattern map
const ORACLE_PATTERN_MAP: Record<string, string> = {
  email: "REGEXP_LIKE(val, '.+@.+\\..+')",
  phone_tr: "(REGEXP_LIKE(val, '^\\+90[0-9]{10}$') OR REGEXP_LIKE(val, '^0[0-9]{10}$') OR (LENGTH(val) = 10 AND REGEXP_LIKE(val, '^[0-9]+$')))",
  tc_kimlik: "(LENGTH(val) = 11 AND SUBSTR(val,1,1) != '0' AND REGEXP_LIKE(val, '^[0-9]+$'))",
  uuid: "REGEXP_LIKE(val, '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')",
  iso_date: "REGEXP_LIKE(val, '^[0-9]{4}-[0-9]{2}-[0-9]{2}')",
  iso_datetime: "REGEXP_LIKE(val, '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}')",
  url: "(val LIKE 'http://%' OR val LIKE 'https://%')",
  json_object: "(SUBSTR(val,1,1) = '{' AND SUBSTR(val,-1) = '}')",
  numeric_string: "(REGEXP_LIKE(val, '^[0-9.+-]+$') AND LENGTH(val) > 0)",
  iban: "REGEXP_LIKE(val, '^TR[0-9]{24}$')",
  credit_card: "(LENGTH(REPLACE(REPLACE(val,' ',''),'-','')) BETWEEN 13 AND 19 AND REGEXP_LIKE(REPLACE(REPLACE(val,' ',''),'-',''), '^[0-9]+$'))",
};

// Access LIKE pattern map (no regex, no PATINDEX)
// Wildcards: * (any chars), ? (single char), # (single digit)
const ACCESS_PATTERN_MAP: Record<string, string> = {
  email: "val LIKE '*@*.*'",
  phone_tr: "(val LIKE '0##########' OR val LIKE '+90##########')",
  tc_kimlik: "(LEN(val) = 11 AND LEFT(val, 1) <> '0' AND ISNUMERIC(val))",
  iso_date: "(LEN(val) >= 10 AND MID(val,5,1) = '-' AND MID(val,8,1) = '-')",
  url: "(val LIKE 'http://*' OR val LIKE 'https://*')",
  json_object: "(LEFT(val, 1) = '{' AND RIGHT(val, 1) = '}')",
  numeric_string: "(ISNUMERIC(val) AND LEN(val) > 0)",
  iban: "(LEN(val) = 26 AND LEFT(val, 2) = 'TR' AND ISNUMERIC(MID(val, 3)))",
};

export function isStringType(dataType: string): boolean {
  return STRING_TYPES.has(dataType.toLowerCase());
}

export interface PatternResult {
  patterns: Record<string, number>;
  dominant_pattern: string | null;
  unclassified_ratio: number;
  sample_size: number;
}

export class PatternAnalyzer {
  constructor(
    private sql: SqlLoader,
    private patterns: Record<string, string>,
    private maxSample: number,
    private dbType: string,
  ) {}

  async analyze(
    conn: DbConnection,
    schema: string,
    table: string,
    column: string,
    rowCount: number,
  ): Promise<PatternResult | null> {
    const logger = getLogger();
    if (rowCount === 0 || Object.keys(this.patterns).length === 0) return null;

    const patternCases = this.buildPatternCases();
    if (!patternCases) return null;

    const quotedSchema = this.sql.validateIdentifier(schema);
    const quotedTable = this.sql.validateIdentifier(table);
    const quotedColumn = this.sql.validateIdentifier(column);

    let sqlText: string;
    let params: unknown[] | undefined;

    if (this.dbType === 'mssql') {
      sqlText = `
        SELECT
          COUNT(*) AS sample_size,
          ${patternCases}
        FROM (
          SELECT TOP (${this.maxSample})
            CAST(${quotedColumn} AS NVARCHAR(MAX)) AS val
          FROM ${quotedSchema}.${quotedTable}
          WHERE ${quotedColumn} IS NOT NULL
        ) sub;
      `;
    } else if (this.dbType === 'oracle') {
      sqlText = `
        SELECT
          COUNT(*) AS sample_size,
          ${patternCases}
        FROM (
          SELECT CAST(${quotedColumn} AS VARCHAR2(4000)) AS val
          FROM ${quotedSchema}.${quotedTable}
          WHERE ${quotedColumn} IS NOT NULL
          FETCH FIRST ${this.maxSample} ROWS ONLY
        ) sub
      `;
    } else if (this.dbType === 'hanabw') {
      sqlText = `
        SELECT
          COUNT(*) AS sample_size,
          ${patternCases}
        FROM (
          SELECT CAST(${quotedColumn} AS NVARCHAR(5000)) AS val
          FROM ${quotedSchema}.${quotedTable}
          WHERE ${quotedColumn} IS NOT NULL
          LIMIT ${this.maxSample}
        ) sub
      `;
    } else if (this.dbType === 'access') {
      sqlText = `
        SELECT
          COUNT(*) AS sample_size,
          ${patternCases}
        FROM (
          SELECT TOP ${this.maxSample}
            CStr(${quotedColumn}) AS val
          FROM ${quotedTable}
          WHERE ${quotedColumn} IS NOT NULL
        ) AS sub;
      `;
    } else {
      sqlText = `
        SELECT
          COUNT(*) AS sample_size,
          ${patternCases}
        FROM (
          SELECT ${quotedColumn}::text AS val
          FROM ${quotedSchema}.${quotedTable}
          WHERE ${quotedColumn} IS NOT NULL
          LIMIT $1
        ) sub;
      `;
      params = [this.maxSample];
    }

    try {
      const { rows } = await conn.query(sqlText, params);
      const row = rows[0];
      if (!row) return null;

      const sampleSize = Number(row.sample_size);
      if (sampleSize === 0) return null;

      const patternsResult: Record<string, number> = {};
      const patternNames = Object.keys(this.patterns);
      for (const name of patternNames) {
        const matchCount = Number(row[`pattern_${name}`] ?? 0);
        const ratio = Math.round((matchCount / sampleSize) * 1e6) / 1e6;
        if (ratio > 0) {
          patternsResult[name] = ratio;
        }
      }

      let dominant: string | null = null;
      if (Object.keys(patternsResult).length > 0) {
        dominant = Object.entries(patternsResult).reduce(
          (a, b) => (b[1] > a[1] ? b : a),
        )[0];
      }

      const totalClassified = Object.values(patternsResult).reduce(
        (sum, v) => sum + Math.min(v, 1.0),
        0,
      );
      const unclassified = Math.max(0, 1.0 - totalClassified);

      return {
        patterns: patternsResult,
        dominant_pattern: dominant,
        unclassified_ratio: Math.round(unclassified * 1e6) / 1e6,
        sample_size: sampleSize,
      };
    } catch (err) {
      logger.warn(`[${schema}.${table}.${column}] pattern analysis hatasi: ${err}`);
    }

    return null;
  }

  private buildPatternCases(): string {
    if (this.dbType === 'access') return this.buildAccessPatternCases();
    if (this.dbType === 'mssql') return this.buildMssqlPatternCases();
    if (this.dbType === 'oracle') return this.buildOraclePatternCases();
    if (this.dbType === 'hanabw') return this.buildHanaPatternCases();
    return this.buildPgPatternCases();
  }

  private buildPgPatternCases(): string {
    const cases: string[] = [];
    for (const [name, regex] of Object.entries(this.patterns)) {
      const escaped = regex.replace(/'/g, "''");
      cases.push(`SUM(CASE WHEN val ~ '${escaped}' THEN 1 ELSE 0 END) AS pattern_${name}`);
    }
    return cases.join(',\n                ');
  }

  private buildMssqlPatternCases(): string {
    const cases: string[] = [];
    for (const name of Object.keys(this.patterns)) {
      const expr = MSSQL_PATTERN_MAP[name] ?? '1=0';
      cases.push(`SUM(CASE WHEN ${expr} THEN 1 ELSE 0 END) AS pattern_${name}`);
    }
    return cases.join(',\n                ');
  }

  private buildOraclePatternCases(): string {
    const cases: string[] = [];
    for (const name of Object.keys(this.patterns)) {
      const expr = ORACLE_PATTERN_MAP[name] ?? '1=0';
      cases.push(`SUM(CASE WHEN ${expr} THEN 1 ELSE 0 END) AS pattern_${name}`);
    }
    return cases.join(',\n                ');
  }

  private buildHanaPatternCases(): string {
    const cases: string[] = [];
    for (const name of Object.keys(this.patterns)) {
      const expr = HANA_PATTERN_MAP[name] ?? '1=0';
      cases.push(`SUM(CASE WHEN ${expr} THEN 1 ELSE 0 END) AS pattern_${name}`);
    }
    return cases.join(',\n                ');
  }

  private buildAccessPatternCases(): string {
    const cases: string[] = [];
    for (const name of Object.keys(this.patterns)) {
      const expr = ACCESS_PATTERN_MAP[name] ?? '1=0';
      cases.push(`SUM(IIF(${expr}, 1, 0)) AS pattern_${name}`);
    }
    return cases.join(',\n                ');
  }
}
