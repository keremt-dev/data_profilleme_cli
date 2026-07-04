# Access DB Profiling (CLI/npm) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Microsoft Access (.mdb/.accdb) as a 5th dialect to the npm CLI profiling tool, enabling full table/column profiling with quality scoring and reports.

**Architecture:** New `AccessConnector` extending `BaseConnector` with `odbc` npm package + ODBC API for metadata. 9 SQL templates in `sql/access/` using Jet SQL (no CTE, no regex, bracket quoting). Node.js-side percentile and IQR for features Access SQL lacks.

**Tech Stack:** `odbc` npm package (native ODBC binding), Microsoft Access ODBC Driver, Jet SQL

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/config/types.ts` | Modify | Add `'access'` to `DbType`, add `dbq` field |
| `src/config/schema.ts` | Modify | Zod schema: `'access'` enum + conditional validation + `dbq` field |
| `src/config/loader.ts` | Modify | Map `dbq` from YAML, Access file existence check |
| `src/sql/loader.ts` | Modify | Access identifier regex, bracket quoting, `literalParams` support, `accessParams()` |
| `src/connectors/access-connector.ts` | Create | AccessConnector: connection, discovery, metadata via ODBC API, Node.js-side percentile/IQR |
| `src/connectors/factory.ts` | Modify | Add `'access'` routing |
| `sql/access/row_count.sql` | Create | Simple COUNT(*) without schema prefix |
| `sql/access/metadata.sql` | Create | Placeholder (metadata via ODBC API) |
| `sql/access/null_ratio.sql` | Create | NULL ratio, distinct count using Access SQL |
| `sql/access/min_max.sql` | Create | MIN/MAX with CStr() casting |
| `sql/access/top_n_values.sql` | Create | TOP N with literal substitution |
| `sql/access/numeric_stats.sql` | Create | AVG + StDev only (no percentiles in SQL) |
| `sql/access/histogram.sql` | Create | Subquery-based bucketing (no CTE) |
| `sql/access/outlier_detection.sql` | Create | Sorted data extraction for Node.js-side IQR |
| `sql/access/pattern_analysis.sql` | Create | Placeholder (patterns built in Node.js) |
| `src/metrics/pattern.ts` | Modify | Add `ACCESS_PATTERN_MAP` and `buildAccessPatternCases()`, Access analyze branch |
| `src/metrics/distribution.ts` | Modify | Access non-comparable types, Access numeric types, Access top-N/numeric-stats/histogram branches |
| `src/metrics/outlier.ts` | Modify | Access branch for Node.js-side IQR calculation |
| `src/profiler/profiler.ts` | Modify | Access metadata branch in `fetchSchemaMetadata()` |
| `package.json` | Modify | Add `odbc` dependency |

---

### Task 1: Install `odbc` Dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the `odbc` npm package**

```bash
cd /c/kt/tcdd/yolcu_profil/.claude/worktrees/brave-chaplygin/npm-cli
npm install odbc
```

This installs the native ODBC binding. Requires node-gyp and a C++ build chain.

- [ ] **Step 2: Verify install succeeded**

```bash
node -e "const odbc = require('odbc'); console.log('odbc loaded OK');"
```

Expected: `odbc loaded OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add odbc dependency for Access connector"
```

---

### Task 2: Config Types & Schema — Add Access Support

**Files:**
- Modify: `src/config/types.ts:6` (DbType)
- Modify: `src/config/types.ts:8-24` (DatabaseConfig)
- Modify: `src/config/schema.ts:6` (dbTypeEnum)
- Modify: `src/config/schema.ts:8-22` (databaseConfigSchema)
- Modify: `src/config/loader.ts:36-53` (database map construction)

- [ ] **Step 1: Add `'access'` to DbType and `dbq` field to DatabaseConfig**

In `src/config/types.ts`, change line 6:

```typescript
export type DbType = 'postgresql' | 'mssql' | 'oracle' | 'hanabw' | 'access';
```

Add `dbq` field to `DatabaseConfig` interface (after `bwDescriptionLang` on line 23):

```typescript
  bwDescriptionLang: string;
  dbq: string;
}
```

- [ ] **Step 2: Update Zod schema with `'access'` and conditional validation**

In `src/config/schema.ts`, change line 6:

```typescript
const dbTypeEnum = z.enum(['postgresql', 'mssql', 'oracle', 'hanabw', 'access']);
```

In `databaseConfigSchema` (lines 8-22), make `host`, `port`, `user` optional and add `dbq`. Replace the entire schema:

```typescript
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
```

- [ ] **Step 3: Update config loader to map `dbq` field and validate file existence**

In `src/config/loader.ts`, add `import path from 'node:path';` at the top (after line 4), then add `dbq` to the database map construction. Replace lines 36-53 with:

```typescript
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
```

- [ ] **Step 4: Verify build succeeds**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/config/types.ts src/config/schema.ts src/config/loader.ts
git commit -m "feat(config): add Access db_type with dbq field and conditional validation"
```

---

### Task 3: SqlLoader — Access Identifier Handling & Literal Params

**Files:**
- Modify: `src/sql/loader.ts:8-9` (identifier regex constants)
- Modify: `src/sql/loader.ts:29-46` (`load()` method)
- Modify: `src/sql/loader.ts:52-60` (`validateIdentifier()` method)
- Add new method: `accessParams()`

- [ ] **Step 1: Add Access identifier regex constant**

In `src/sql/loader.ts`, after line 9 (`const HANA_IDENTIFIER_RE`), add:

```typescript
const ACCESS_IDENTIFIER_RE = /^.+$/;
```

- [ ] **Step 2: Update `validateIdentifier()` for Access bracket quoting**

Replace the `validateIdentifier()` method (lines 52-60) with:

```typescript
  validateIdentifier(name: string): string {
    if (this.dbType === 'access') {
      if (!ACCESS_IDENTIFIER_RE.test(name)) {
        throw new Error(`Gecersiz SQL identifier: '${name}'.`);
      }
      return `[${name}]`;
    }
    const re = this.dbType === 'hanabw' ? HANA_IDENTIFIER_RE : IDENTIFIER_RE;
    if (!re.test(name)) {
      throw new Error(
        `Gecersiz SQL identifier: '${name}'. Sadece harf, rakam ve alt cizgi kabul edilir.`,
      );
    }
    return this.dbType === 'mssql' ? `[${name}]` : `"${name}"`;
  }
```

- [ ] **Step 3: Add `literalParams` support to `load()` method**

Replace the `load()` method (lines 29-46) with:

```typescript
  load(
    templateName: string,
    identifierParams: Record<string, string> = {},
    literalParams: Record<string, string | number> = {},
  ): string {
    if (!this.cache.has(templateName)) {
      const filePath = path.join(this.sqlDir, `${templateName}.sql`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`SQL sablonu bulunamadi: ${filePath}`);
      }
      this.cache.set(templateName, fs.readFileSync(filePath, 'utf-8'));
    }

    let sql = this.cache.get(templateName)!;

    for (const [key, value] of Object.entries(identifierParams)) {
      const quoted = this.validateIdentifier(value);
      sql = sql.replaceAll(`{${key}}`, quoted);
    }

    for (const [key, value] of Object.entries(literalParams)) {
      sql = sql.replaceAll(`{${key}}`, String(value));
    }

    return sql;
  }
```

- [ ] **Step 4: Add `accessParams()` method**

After the `mssqlParams()` method (after line 110), add:

```typescript
  /**
   * Access ? positional params — used directly with odbc.query(sql, values).
   * Unlike MSSQL, no @p1 conversion needed.
   */
  accessParams(sql: string, params: unknown[]): { sql: string; values: unknown[] } {
    return { sql, values: params };
  }
```

- [ ] **Step 5: Verify build succeeds**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/sql/loader.ts
git commit -m "feat(sql-loader): Access identifier validation, bracket quoting, literalParams"
```

---

### Task 4: SQL Templates — Create All 9 Access Templates

**Files:**
- Create: `sql/access/row_count.sql`
- Create: `sql/access/metadata.sql`
- Create: `sql/access/null_ratio.sql`
- Create: `sql/access/min_max.sql`
- Create: `sql/access/top_n_values.sql`
- Create: `sql/access/numeric_stats.sql`
- Create: `sql/access/histogram.sql`
- Create: `sql/access/outlier_detection.sql`
- Create: `sql/access/pattern_analysis.sql`

- [ ] **Step 1: Create `sql/access/` directory**

```bash
mkdir -p sql/access
```

- [ ] **Step 2: Create `sql/access/row_count.sql`**

```sql
-- Satir sayisi
-- Identifier params: {table_name}
SELECT COUNT(*) AS row_count FROM [{table_name}];
```

- [ ] **Step 3: Create `sql/access/metadata.sql`**

```sql
-- Metadata ODBC API ile cekilir, bu template placeholder
SELECT 1 AS placeholder;
```

- [ ] **Step 4: Create `sql/access/null_ratio.sql`**

```sql
-- NULL orani ve distinct sayisi
-- Identifier params: {table_name}, {column_name}
SELECT
    COUNT(*) AS total_count,
    COUNT([{column_name}]) AS non_null_count,
    COUNT(*) - COUNT([{column_name}]) AS null_count,
    IIF(COUNT(*) > 0,
        ROUND((COUNT(*) - COUNT([{column_name}])) / CDbl(COUNT(*)), 6),
        0) AS null_ratio,
    {distinct_count_expr} AS distinct_count,
    IIF(COUNT([{column_name}]) > 0,
        ROUND({distinct_count_expr} / CDbl(COUNT([{column_name}])), 6),
        0) AS distinct_ratio
FROM [{table_name}];
```

- [ ] **Step 5: Create `sql/access/min_max.sql`**

```sql
-- Min/max degerler
-- Identifier params: {table_name}, {column_name}
SELECT
    CStr(MIN([{column_name}])) AS min_value,
    CStr(MAX([{column_name}])) AS max_value
FROM [{table_name}]
WHERE [{column_name}] IS NOT NULL;
```

- [ ] **Step 6: Create `sql/access/top_n_values.sql`**

```sql
-- En sik N deger
-- Identifier params: {table_name}, {column_name}
-- Literal params: {top_n}, {total_count}
SELECT TOP {top_n}
    CStr([{column_name}]) AS value,
    COUNT(*) AS frequency,
    ROUND(COUNT(*) / CDbl({total_count}), 6) AS pct
FROM [{table_name}]
WHERE [{column_name}] IS NOT NULL
GROUP BY [{column_name}]
ORDER BY COUNT(*) DESC;
```

- [ ] **Step 7: Create `sql/access/numeric_stats.sql`**

```sql
-- Numerik istatistikler: ortalama, stddev
-- Identifier params: {table_name}, {column_name}
-- Not: Percentile hesabi Access SQL'de mumkun degil, Node.js-side yapilir
SELECT
    AVG(CDbl([{column_name}])) AS mean_value,
    STDEV(CDbl([{column_name}])) AS stddev_value
FROM [{table_name}]
WHERE [{column_name}] IS NOT NULL;
```

- [ ] **Step 8: Create `sql/access/histogram.sql`**

```sql
-- Numerik histogram (Access - CTE yok, subquery bazli)
-- Identifier params: {table_name}, {column_name}
-- Literal params: {buckets}
SELECT
    bucket,
    MIN(lower_b) AS lower_bound,
    MAX(upper_b) AS upper_bound,
    COUNT(*) AS freq
FROM (
    SELECT
        IIF(sub.max_val = sub.min_val, 1,
            INT((CDbl([{column_name}]) - sub.min_val)
                / IIF(sub.max_val - sub.min_val = 0, 1, sub.max_val - sub.min_val)
                * {buckets}) + 1
        ) AS bucket,
        sub.min_val + (IIF(sub.max_val = sub.min_val, 1,
            INT((CDbl([{column_name}]) - sub.min_val)
                / IIF(sub.max_val - sub.min_val = 0, 1, sub.max_val - sub.min_val)
                * {buckets})
        )) * (sub.max_val - sub.min_val) / {buckets} AS lower_b,
        sub.min_val + (IIF(sub.max_val = sub.min_val, 1,
            INT((CDbl([{column_name}]) - sub.min_val)
                / IIF(sub.max_val - sub.min_val = 0, 1, sub.max_val - sub.min_val)
                * {buckets})
        ) + 1) * (sub.max_val - sub.min_val) / {buckets} AS upper_b
    FROM [{table_name}],
        (SELECT MIN(CDbl([{column_name}])) AS min_val,
                MAX(CDbl([{column_name}])) AS max_val
         FROM [{table_name}]
         WHERE [{column_name}] IS NOT NULL) AS sub
    WHERE [{column_name}] IS NOT NULL
) AS bucketed
WHERE bucket BETWEEN 1 AND {buckets}
GROUP BY bucket
ORDER BY bucket;
```

- [ ] **Step 9: Create `sql/access/outlier_detection.sql`**

```sql
-- Outlier tespiti icin siralanmis veri cekimi
-- Identifier params: {table_name}, {column_name}
-- Not: IQR hesabi Node.js-side yapilir
SELECT CDbl([{column_name}]) AS val
FROM [{table_name}]
WHERE [{column_name}] IS NOT NULL
ORDER BY [{column_name}];
```

- [ ] **Step 10: Create `sql/access/pattern_analysis.sql`**

```sql
-- Pattern analizi Node.js tarafinda olusturulur (LIKE)
-- Access wildcard: * (herhangi karakter dizisi), ? (tek karakter), # (tek rakam)
SELECT 1 AS placeholder;
```

- [ ] **Step 11: Commit**

```bash
git add sql/access/
git commit -m "feat(sql): add 9 Access SQL templates for Jet SQL dialect"
```

---

### Task 5: AccessConnector — Core Connection & Discovery

**Files:**
- Create: `src/connectors/access-connector.ts`

- [ ] **Step 1: Create AccessConnector with connection, test, discovery, and metadata methods**

Create `src/connectors/access-connector.ts`:

```typescript
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
            ? await connection.query(sqlText, params as odbc.Parameter[])
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
        ? await connection.query(sqlText, params as odbc.Parameter[])
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
      for (const t of tables) {
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
    // Access doesn't have a version query — file existence was already checked
    return true;
  }

  async getTableSize(_conn: DbConnection, _schema: string, _table: string): Promise<number | null> {
    // Access is file-based — per-table size not available
    // Return total file size as approximate
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
          const columns = await connection.columns(null, null, table, null);
          let pkColumns: Set<string>;
          try {
            const pks = await connection.primaryKeys(null, null, table);
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
```

- [ ] **Step 2: Verify build succeeds**

```bash
npx tsc --noEmit
```

Expected: No errors (or only odbc typing issues which may need `@types/odbc` or type assertion).

- [ ] **Step 3: Commit**

```bash
git add src/connectors/access-connector.ts
git commit -m "feat: add AccessConnector with ODBC connection, discovery, metadata, and Node.js-side stats"
```

---

### Task 6: ConnectorFactory — Add Access Routing

**Files:**
- Modify: `src/connectors/factory.ts:1-22`

- [ ] **Step 1: Add AccessConnector import and routing**

In `src/connectors/factory.ts`, add the import after line 9:

```typescript
import { AccessConnector } from './access-connector.js';
```

Add Access routing in the `createConnector` function, after line 11 (before the `mssql` check):

```typescript
  if (config.dbType === 'access') {
    return new AccessConnector(config);
  }
```

- [ ] **Step 2: Verify build succeeds**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/connectors/factory.ts
git commit -m "feat(factory): add Access connector routing"
```

---

### Task 7: Metrics — Pattern Analyzer Access Support

**Files:**
- Modify: `src/metrics/pattern.ts:9-19` (STRING_TYPES)
- Modify: `src/metrics/pattern.ts:85-198` (analyze method — add Access branch)
- Modify: `src/metrics/pattern.ts:200-204` (buildPatternCases dispatch)
- Add: Access pattern map constant and builder method

- [ ] **Step 1: Add Access string types**

In `src/metrics/pattern.ts`, add Access types to the `STRING_TYPES` set (after line 18):

```typescript
  // Access
  'text', 'memo', 'varchar', 'char',
```

- [ ] **Step 2: Add Access pattern map constant**

After `ORACLE_PATTERN_MAP` (after line 64), add:

```typescript
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
```

- [ ] **Step 3: Add Access branch in `analyze()` method**

In the `analyze()` method, add Access branch after the HANA branch (after line 140):

```typescript
    } else if (this.dbType === 'access') {
      // Access: CStr() casting, TOP for sample, no schema prefix
      sqlText = `
        SELECT
          COUNT(*) AS sample_size,
          ${patternCases}
        FROM (
          SELECT TOP ${this.maxSample}
            CStr([${column}]) AS val
          FROM [${table}]
          WHERE [${column}] IS NOT NULL
        ) AS sub;
      `;
```

Note: In the Access branch, identifier quoting uses raw `[brackets]` since the identifiers come from validated table/column names. The `quotedSchema`/`quotedTable` variables include the double-quote or bracket wrapping from `validateIdentifier()`, but Access doesn't use schema prefix. So we use `[${table}]` and `[${column}]` directly to keep it simple.

Actually, to stay consistent with the existing pattern, use the already-validated variables but skip the schema:

```typescript
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
```

- [ ] **Step 4: Add `buildAccessPatternCases()` method and update dispatch**

Update `buildPatternCases()` dispatch (line 200-204):

```typescript
  private buildPatternCases(): string {
    if (this.dbType === 'access') return this.buildAccessPatternCases();
    if (this.dbType === 'mssql') return this.buildMssqlPatternCases();
    if (this.dbType === 'oracle') return this.buildOraclePatternCases();
    if (this.dbType === 'hanabw') return this.buildHanaPatternCases();
    return this.buildPgPatternCases();
  }
```

Add the new builder method after `buildHanaPatternCases()`:

```typescript
  private buildAccessPatternCases(): string {
    const cases: string[] = [];
    for (const name of Object.keys(this.patterns)) {
      const expr = ACCESS_PATTERN_MAP[name] ?? '1=0';
      cases.push(`SUM(IIF(${expr}, 1, 0)) AS pattern_${name}`);
    }
    return cases.join(',\n                ');
  }
```

- [ ] **Step 5: Verify build succeeds**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/metrics/pattern.ts
git commit -m "feat(pattern): add Access LIKE-based pattern analysis"
```

---

### Task 8: Metrics — Distribution Access Support

**Files:**
- Modify: `src/metrics/distribution.ts:9-22` (NUMERIC_TYPES)
- Modify: `src/metrics/distribution.ts:32-55` (non-comparable types)
- Modify: `src/metrics/distribution.ts:67-117` (getTopN — add Access branch)
- Modify: `src/metrics/distribution.ts:119-157` (getNumericStats — add Access branch)
- Modify: `src/metrics/distribution.ts:159-193` (getHistogram — add Access branch)

- [ ] **Step 1: Add Access numeric types to NUMERIC_TYPES set**

In `src/metrics/distribution.ts`, add Access types after the HANA section (after line 21):

```typescript
  // Access
  'byte', 'long', 'single', 'double', 'currency',
```

Note: `integer`, `decimal`, `numeric`, `float`, `tinyint`, `smallint`, `bigint` are already in the set from other dialects.

- [ ] **Step 2: Add Access non-comparable types**

After `HANA_NON_COMPARABLE` (after line 46), add:

```typescript
const ACCESS_NON_COMPARABLE = new Set([
  'oleobject', 'ole object', 'memo', 'hyperlink',
]);
```

Update `isNonComparableType()` function (line 49-55) — add Access branch before the final return:

```typescript
export function isNonComparableType(dataType: string, dbType: string): boolean {
  const dt = dataType.toLowerCase();
  if (dbType === 'mssql') return MSSQL_NON_COMPARABLE.has(dt);
  if (dbType === 'oracle') return ORACLE_NON_COMPARABLE.has(dt);
  if (dbType === 'hanabw') return HANA_NON_COMPARABLE.has(dt);
  if (dbType === 'access') return ACCESS_NON_COMPARABLE.has(dt);
  return false;
}
```

- [ ] **Step 3: Add Access branch in `getTopN()`**

In the `getTopN()` method, add Access branch after the HANA branch (after line 93). Access uses literal `{top_n}` and `{total_count}` substitution instead of parameterized queries:

```typescript
      } else if (this.dbType === 'access') {
        // Access: literal top_n and total_count already in template via literalParams
        const accessSql = this.sql.load('top_n_values', {
          table_name: table,
          column_name: column,
        }, {
          top_n: topN,
          total_count: rowCount,
        });
        result = await conn.query(accessSql);
```

Also remove the duplicate `sqlText` load at the top of the method — for Access we need to load with literalParams, so the Access branch does its own load. Wrap the existing load (lines 80-84) in a condition:

Replace lines 80-84:

```typescript
      let sqlText: string;
      if (this.dbType !== 'access') {
        sqlText = this.sql.load('top_n_values', {
          schema_name: schema,
          table_name: table,
          column_name: column,
        });
        sqlText = sqlText.replaceAll('{sample_clause}', samplePct ? `TABLESAMPLE SYSTEM (${Math.floor(samplePct)})` : '');
      }
```

And in the Access branch, use a fresh load as shown above.

- [ ] **Step 4: Add Access branch in `getNumericStats()`**

In `getNumericStats()`, add Access branch that also does Node.js-side percentile calculation. After loading the template and executing the SQL for mean/stddev, the Access branch also fetches sorted values for percentiles.

Add this after the existing try block, but before the catch. Actually, the simplest approach: add a special Access branch at the start of the method.

Replace `getNumericStats()` (lines 119-157) entirely:

```typescript
  async getNumericStats(
    conn: DbConnection,
    schema: string,
    table: string,
    column: string,
    samplePct?: number | null,
  ): Promise<Record<string, number | null> | null> {
    const logger = getLogger();

    if (this.dbType === 'access') {
      return this.getAccessNumericStats(conn, table, column);
    }

    try {
      let sqlText = this.sql.load('numeric_stats', {
        schema_name: schema,
        table_name: table,
        column_name: column,
      });
      sqlText = sqlText.replaceAll('{sample_clause}', samplePct ? `TABLESAMPLE SYSTEM (${Math.floor(samplePct)})` : '');
      const { rows } = await conn.query(sqlText);
      const row = rows[0];
      if (row && row.mean_value != null) {
        return {
          mean: row.mean_value != null ? Number(row.mean_value) : null,
          stddev: row.stddev_value != null ? Number(row.stddev_value) : null,
          p01: row.p01 != null ? Number(row.p01) : null,
          p05: row.p05 != null ? Number(row.p05) : null,
          p25: row.p25 != null ? Number(row.p25) : null,
          p50: row.p50 != null ? Number(row.p50) : null,
          p75: row.p75 != null ? Number(row.p75) : null,
          p95: row.p95 != null ? Number(row.p95) : null,
          p99: row.p99 != null ? Number(row.p99) : null,
        };
      }
    } catch (err) {
      if (this.connector.isQueryTimeoutError(err)) {
        logger.warn(`[${schema}.${table}.${column}] numeric_stats timeout`);
      } else {
        logger.warn(`[${schema}.${table}.${column}] numeric_stats hatasi: ${err}`);
      }
    }
    return null;
  }

  /**
   * Access numeric stats: SQL for mean/stddev, Node.js-side percentiles.
   */
  private async getAccessNumericStats(
    conn: DbConnection,
    table: string,
    column: string,
  ): Promise<Record<string, number | null> | null> {
    const logger = getLogger();
    try {
      // Mean + stddev from SQL
      const sqlText = this.sql.load('numeric_stats', {
        table_name: table,
        column_name: column,
      });
      const { rows } = await conn.query(sqlText);
      const row = rows[0];
      const mean = row?.mean_value != null ? Number(row.mean_value) : null;
      const stddev = row?.stddev_value != null ? Number(row.stddev_value) : null;

      // Percentiles from sorted data (Node.js-side)
      const { AccessConnector } = await import('../connectors/access-connector.js');
      const accessConn = this.connector as InstanceType<typeof AccessConnector>;
      const sortedValues = await accessConn.getSortedColumnValues(conn, table, column);
      const percentiles = AccessConnector.calculatePercentiles(
        sortedValues,
        [0.01, 0.05, 0.25, 0.50, 0.75, 0.95, 0.99],
      );

      return {
        mean,
        stddev,
        ...percentiles,
      };
    } catch (err) {
      logger.warn(`[default.${table}.${column}] access numeric_stats hatasi: ${err}`);
    }
    return null;
  }
```

- [ ] **Step 5: Add Access branch in `getHistogram()`**

In the `getHistogram()` method, Access templates already use `{buckets}` literal substitution (same pattern as MSSQL). But Access templates don't have `{schema_name}` or `{sample_clause}`. Add Access branch:

Replace the getHistogram method to handle Access separately:

```typescript
  async getHistogram(
    conn: DbConnection,
    schema: string,
    table: string,
    column: string,
    buckets: number = 20,
    samplePct?: number | null,
  ): Promise<HistogramBucket[] | null> {
    const logger = getLogger();
    try {
      let sqlText: string;
      if (this.dbType === 'access') {
        sqlText = this.sql.load('histogram', {
          table_name: table,
          column_name: column,
        }, {
          buckets: Math.floor(buckets),
        });
      } else {
        sqlText = this.sql.load('histogram', {
          schema_name: schema,
          table_name: table,
          column_name: column,
        });
        sqlText = sqlText.replaceAll('{buckets}', String(Math.floor(buckets)));
        sqlText = sqlText.replaceAll('{sample_clause}', samplePct ? `TABLESAMPLE SYSTEM (${Math.floor(samplePct)})` : '');
      }

      const { rows } = await conn.query(sqlText);
      return rows.map((r) => ({
        bucket: Number(r.bucket),
        lower_bound: Number(r.lower_bound ?? 0),
        upper_bound: Number(r.upper_bound ?? 0),
        frequency: Number(r.freq ?? r.frequency ?? 0),
      }));
    } catch (err) {
      if (this.connector.isQueryTimeoutError(err)) {
        logger.warn(`[${schema}.${table}.${column}] histogram timeout`);
      } else {
        logger.warn(`[${schema}.${table}.${column}] histogram hatasi: ${err}`);
      }
    }
    return null;
  }
```

- [ ] **Step 6: Verify build succeeds**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/metrics/distribution.ts
git commit -m "feat(distribution): add Access non-comparable types, numeric stats with Node.js-side percentiles"
```

---

### Task 9: Metrics — Outlier Detector Access Support

**Files:**
- Modify: `src/metrics/outlier.ts:30-93` (detect method — add Access branch)

- [ ] **Step 1: Add Access branch for Node.js-side IQR calculation**

In the `detect()` method, add Access branch at the beginning (after `const logger` line), before the SQL loading:

```typescript
    if (this.dbType === 'access') {
      return this.detectAccessOutliers(conn, table, column, iqrMultiplier);
    }
```

Add the private method after the existing `detect()` method:

```typescript
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
```

- [ ] **Step 2: Verify build succeeds**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/metrics/outlier.ts
git commit -m "feat(outlier): add Access Node.js-side IQR outlier detection"
```

---

### Task 10: Profiler — Access Metadata Branch

**Files:**
- Modify: `src/profiler/profiler.ts:380-426` (fetchSchemaMetadata — add Access branch)

- [ ] **Step 1: Add Access branch in `fetchSchemaMetadata()`**

In the `fetchSchemaMetadata()` method, add Access branch at the start (after `const metadata = new Map...` on line 386), before the existing try block:

```typescript
    // Access: metadata via ODBC API, not SQL
    if (this.dbConfig.dbType === 'access') {
      const { AccessConnector } = await import('../connectors/access-connector.js');
      const accessConn = this.connector as InstanceType<typeof AccessConnector>;
      // Get table names from the schema metadata request
      // The caller passes schema but Access ignores it
      return metadata; // Will be populated via getTableMetadataViaOdbc in profileSchema
    }
```

Wait — we need to think about this more carefully. The `fetchSchemaMetadata()` method loads a SQL template and runs it. For Access, the metadata comes from ODBC API, not SQL. Let me check how `metadata` is used after being returned.

Looking at the profiler flow: `fetchSchemaMetadata` returns `Map<tableName, columnRows[]>`. Then in `profileTable`, each table's columns come from `metadata.get(tableName)`. The column rows have fields like `column_name`, `data_type`, `ordinal_position`, etc.

For Access, we need the `getTableMetadataViaOdbc()` to populate this same map structure. But `fetchSchemaMetadata` is called once per schema with all tables. Let me integrate properly.

Replace the approach: In `fetchSchemaMetadata()`, add Access branch that calls `getTableMetadataViaOdbc()`:

In `src/profiler/profiler.ts`, in the `fetchSchemaMetadata()` method, add this right after `const metadata = new Map...` (line 386), before the existing `try`:

```typescript
    // Access: metadata via ODBC API (no SQL catalog)
    if (this.dbConfig.dbType === 'access') {
      try {
        const { AccessConnector } = await import('../connectors/access-connector.js');
        const accessConn = this.connector as InstanceType<typeof AccessConnector>;
        return await accessConn.getTableMetadataViaOdbc(
          Array.from((await this.connector.discoverTables(schema)).map((t) => t.table_name)),
        );
      } catch (e) {
        logger.warn(`[${schema}] Access metadata cekme hatasi: ${e}`);
        return metadata;
      }
    }
```

Hmm, but `discoverTables` was already called before — the profiler already has the table list. Let me check how `fetchSchemaMetadata` is called.

Actually, looking at the profiler more carefully, `fetchSchemaMetadata` is called inside `profileSchema` with just `(conn, schema)` — no table list parameter. The returned map is then used by looking up table names from the already-discovered table list.

So the cleanest approach: pass the known table list. But that changes the method signature. Instead, let's just discover tables again (it's cached/cheap for Access) or accept the redundancy.

Better approach — just call `getTableMetadataViaOdbc` directly with a list of tables we can get from `discoverTables`:

```typescript
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
```

- [ ] **Step 2: Verify build succeeds**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/profiler/profiler.ts
git commit -m "feat(profiler): add Access metadata fetch via ODBC API"
```

---

### Task 11: BasicMetrics — Access Schema-less Templates

**Files:**
- Modify: `src/metrics/basic.ts:15-28` (getRowCount)
- Modify: `src/metrics/basic.ts:31-99` (getColumnBasics)

The `BasicMetrics` class loads SQL templates with `schema_name` identifier. For Access, templates don't have `{schema_name}`. We need to conditionally skip it.

- [ ] **Step 1: Update `getRowCount()` to handle Access (no schema)**

In `src/metrics/basic.ts`, replace line 17:

```typescript
    const sqlText = this.sql.load('row_count', { schema_name: schema, table_name: table });
```

with:

```typescript
    const dbType = this.connector['config'].dbType;
    const identifiers = dbType === 'access'
      ? { table_name: table }
      : { schema_name: schema, table_name: table };
    const sqlText = this.sql.load('row_count', identifiers);
```

- [ ] **Step 2: Update `getColumnBasics()` to handle Access (no schema, literal params for distinct_count_expr)**

In `src/metrics/basic.ts`, replace the null_ratio load (lines 54-58):

```typescript
      const dbType = this.connector['config'].dbType;
      let sqlText: string;
      if (dbType === 'access') {
        // Access null_ratio uses {distinct_count_expr} literal param
        const distinctExpr = `COUNT(DISTINCT [${column}])`;
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
```

Replace the min_max load (lines 79-83):

```typescript
      const mmIdentifiers = dbType === 'access'
        ? { table_name: table, column_name: column }
        : { schema_name: schema, table_name: table, column_name: column };
      const sqlText = this.sql.load('min_max', mmIdentifiers);
```

Note: The `dbType` variable is already defined above in the null_ratio section. Move the `const dbType` line to the top of the method body so it's accessible everywhere.

Actually, let's restructure. Add `private dbType: string;` as a class field and set it in the constructor, similar to how `DistributionMetrics` does it:

Add field after the constructor:

```typescript
export class BasicMetrics {
  private dbType: string;

  constructor(
    private sql: SqlLoader,
    private connector: BaseConnector,
  ) {
    this.dbType = connector['config'].dbType;
  }
```

Then use `this.dbType` throughout.

For `getRowCount()`:

```typescript
    const identifiers = this.dbType === 'access'
      ? { table_name: table }
      : { schema_name: schema, table_name: table };
    const sqlText = this.sql.load('row_count', identifiers);
```

For `getColumnBasics()` null_ratio section:

```typescript
      let sqlText: string;
      if (this.dbType === 'access') {
        const distinctExpr = `COUNT(DISTINCT [${column}])`;
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
```

For `getColumnBasics()` min_max section:

```typescript
      const mmIdent = this.dbType === 'access'
        ? { table_name: table, column_name: column }
        : { schema_name: schema, table_name: table, column_name: column };
      const sqlText = this.sql.load('min_max', mmIdent);
```

Also apply the same pattern to `getColumnBasicsLite()` (lines 105-167):

For null_ratio_lite: Access won't use this method (no catalog stats), but to be safe:

```typescript
      const identifiers = this.dbType === 'access'
        ? { table_name: table, column_name: column }
        : { schema_name: schema, table_name: table, column_name: column };
      const sqlText = this.sql.load('null_ratio_lite', identifiers);
```

And for its min_max section, same pattern.

- [ ] **Step 3: Verify build succeeds**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/metrics/basic.ts
git commit -m "feat(basic-metrics): add Access schema-less template loading with distinct_count_expr"
```

---

### Task 12: Build Verification & Integration Test

**Files:**
- None modified (verification only)

- [ ] **Step 1: Full build check**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 2: Build dist**

```bash
npm run build
```

Expected: Clean build with dist/ output.

- [ ] **Step 3: Verify CLI starts**

```bash
node dist/cli.js --help
```

Expected: Help output shows the CLI options.

- [ ] **Step 4: Verify Access config parsing**

Create a temporary test config:

```bash
cat > /tmp/test-access-config.yaml << 'EOF'
project:
  name: "Access Test"
  output_dir: "./output"
databases:
  test_access:
    db_type: "access"
    dbq: "C:/nonexistent/test.mdb"
    password: ""
profiling:
  concurrency: 1
logging:
  level: "DEBUG"
EOF
```

```bash
node -e "
const { loadConfig } = require('./dist/config/loader.js');
try {
  loadConfig('/tmp/test-access-config.yaml');
} catch(e) {
  console.log('Expected error:', e.message);
  if (e.message.includes('Access dosyasi bulunamadi')) {
    console.log('OK: Access file validation works');
  }
}
"
```

Expected: Error message about Access file not found — confirming the validation works.

- [ ] **Step 5: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: address build issues from Access integration"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Install `odbc` dependency | package.json |
| 2 | Config types, Zod schema, loader | types.ts, schema.ts, loader.ts |
| 3 | SqlLoader: Access identifiers, literal params | loader.ts |
| 4 | 9 SQL templates for Access Jet SQL | sql/access/*.sql |
| 5 | AccessConnector: connection, discovery, metadata, percentile/IQR | access-connector.ts |
| 6 | ConnectorFactory: Access routing | factory.ts |
| 7 | PatternAnalyzer: Access LIKE patterns | pattern.ts |
| 8 | DistributionMetrics: Access types, top-N, numeric stats, histogram | distribution.ts |
| 9 | OutlierDetector: Access Node.js-side IQR | outlier.ts |
| 10 | Profiler: Access metadata via ODBC API | profiler.ts |
| 11 | BasicMetrics: Access schema-less templates | basic.ts |
| 12 | Build verification & integration test | (verification only) |
