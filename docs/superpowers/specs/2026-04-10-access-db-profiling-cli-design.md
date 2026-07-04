# Microsoft Access Veritabani Profilleme Destegi (CLI / npm)

**Tarih:** 2026-04-10
**Durum:** Onaylandi
**Kapsam:** Mevcut npm CLI profilleme aracina Access (.mdb/.accdb) dosya destegi eklenmesi

---

## 1. Amac

Projeye 5. dialect olarak Microsoft Access eklenerek .mdb ve .accdb dosyalarinin profillemesini saglamak. Mevcut TypeScript mimarisi (BaseConnector, SQL templates, SqlLoader, Profiler pipeline) korunarak minimal degisiklikle tam entegrasyon.

## 2. Kararlar

| Karar | Secim | Gerekce |
|-------|-------|---------|
| Yaklasim | Tam dialect entegrasyonu (Yaklasim A) | Mevcut mimariye tam uyum, sifir kod tekrari |
| ODBC driver | `odbc` npm paketi | pyodbc'nin Node.js karsiligi, ODBC API destegi, cross-platform potansiyel |
| Config formati | Dosya yolu bazli (`dbq` alani) | Access dosya-bazli, host/port anlamsiz |
| SQL template | Tam set (9 dosya, `sql/access/`) | Tutarlilik, diger dialect'lerle ayni pattern |
| Pattern analizi | LIKE-bazli (MSSQL benzeri) | Access regex desteklemiyor |
| Percentile/IQR | Node.js-side hesaplama | Access SQL'de percentile/IQR mumkun degil |
| Coklu dosya | Config'de birden fazla tanimlanabilir | Mevcut factory/pipeline zaten destekler |

## 3. Config Yapisi

### 3.1 Type Degisiklikleri

```typescript
// src/config/types.ts
export type DbType = 'postgresql' | 'mssql' | 'oracle' | 'hanabw' | 'access';

export interface DatabaseConfig {
  // Mevcut alanlar korunur
  dbq: string;  // YENI: Access dosya yolu (.mdb veya .accdb)
}
```

### 3.2 Zod Schema Degisiklikleri

```typescript
// src/config/schema.ts
const dbTypeEnum = z.enum(['postgresql', 'mssql', 'oracle', 'hanabw', 'access']);

const databaseConfigSchema = z.object({
  // Mevcut alanlar korunur, host/port/user optional olur
  host: z.string().default(''),
  port: z.coerce.number().int().default(0),
  user: z.string().default(''),
  // YENI
  dbq: z.string().default(''),
}).superRefine((data, ctx) => {
  if (data.db_type === 'access') {
    if (!data.dbq) {
      ctx.addIssue({ code: 'custom', message: 'Access icin dbq (dosya yolu) zorunlu', path: ['dbq'] });
    }
  } else {
    if (!data.host) ctx.addIssue({ code: 'custom', message: 'host zorunlu', path: ['host'] });
    if (!data.port) ctx.addIssue({ code: 'custom', message: 'port zorunlu', path: ['port'] });
    if (!data.user) ctx.addIssue({ code: 'custom', message: 'user zorunlu', path: ['user'] });
  }
});
```

### 3.3 config.yaml Formati

```yaml
databases:
  ankara_access:
    db_type: "access"
    dbq: "C:/kt/tcdd/yolcu_profil/Ankara Access.mdb"
    password: ""
    driver: "Microsoft Access Driver (*.mdb, *.accdb)"
```

### 3.4 Config Dogrulama

- `db_type == "access"` icin sadece `dbq` zorunlu
- `host`, `port`, `user` opsiyonel (bos birakilabilir)
- `password` opsiyonel (parola korumali dosyalar icin)
- `dbq` dosyasinin fiziksel olarak var olup olmadigi kontrol edilir (config loader'da)
- `schema_filter` yoksayilir (Access'te schema yok)

## 4. AccessConnector

### 4.1 Dosya

`src/connectors/access-connector.ts` — `BaseConnector` abstract class'ini implemente eder.

### 4.2 Connection String

```
DRIVER={Microsoft Access Driver (*.mdb, *.accdb)};
DBQ=C:\path\to\file.mdb;
PWD=optional_password;
ExtendedAnsiSQL=1;
```

`ExtendedAnsiSQL=1` ayari SQL-92 uyumlulugunu arttirir (MSSQL benzeri syntax destegi).

### 4.3 BaseConnector Implementasyonu

| Method | Access Implementasyonu |
|--------|----------------------|
| `withConnection<T>(fn)` | `odbc.connect(connStr)` → `fn(conn)` → `conn.close()` |
| `testConnection()` | `SELECT 1` calistir |
| `discoverSchemas()` | Sabit `["default"]` doner |
| `discoverTables("default")` | `conn.tables()` ODBC API (tableType='TABLE') |
| `getEstimatedRowCount()` | `SELECT COUNT(*) FROM [tablo]` (istatistik tablosu yok) |
| `validateDbType()` | Basit `SELECT 1` kontrolu |
| `getTableSize()` | `null` doner (dosya-bazli, tablo boyutu alinamaz) |
| `isQueryTimeoutError()` | `odbc` hata kodu kontrolu |
| `executeQuery()` | `conn.query(sql, params)` |

### 4.4 Metadata Cekim Yontemi

Access'te `sys.*` catalog view'lari yoktur. Metadata ODBC API ile cekilir:

```typescript
async getTableMetadataViaOdbc(
  conn: OdbcConnection,
  tables: string[],
): Promise<Map<string, ColumnMetadata[]>> {
  const result = new Map<string, ColumnMetadata[]>();
  for (const table of tables) {
    const columns = await conn.columns(null, null, table, null);
    const pks = await conn.primaryKeys(null, null, table);
    const pkSet = new Set(pks.map(pk => pk.COLUMN_NAME));

    result.set(table, columns.map(col => ({
      table_schema: 'default',
      table_name: table,
      column_name: col.COLUMN_NAME,
      ordinal_position: col.ORDINAL_POSITION,
      data_type: col.TYPE_NAME,
      character_maximum_length: col.COLUMN_SIZE,
      numeric_precision: col.DECIMAL_DIGITS,
      is_nullable: col.NULLABLE === 1 ? 'YES' : 'NO',
      is_primary_key: pkSet.has(col.COLUMN_NAME),
      is_foreign_key: false,
    })));
  }
  return result;
}
```

### 4.5 Node.js-Side Hesaplama Methodlari

```typescript
/**
 * Siralanmis kolon degerleri cekip Node.js'te percentile hesapla.
 */
async getSortedColumnValues(
  conn: OdbcConnection,
  table: string,
  column: string,
): Promise<number[]> {
  const sql = `SELECT CDbl([${column}]) AS val FROM [${table}] WHERE [${column}] IS NOT NULL ORDER BY [${column}]`;
  const rows = await conn.query(sql);
  return rows.map(r => Number(r.val));
}

/**
 * Siralanmis veriden percentile hesapla.
 */
static calculatePercentiles(
  sortedValues: number[],
  percentiles: number[],
): Record<string, number> {
  // Linear interpolation ile percentile hesaplama
}

/**
 * Siralanmis veriden IQR ve outlier istatistikleri hesapla.
 */
static calculateIqrStats(
  sortedValues: number[],
  multiplier: number,
): { q1: number; q3: number; iqr: number; lower_bound: number; upper_bound: number; outlier_count: number; outlier_ratio: number }
```

### 4.6 Connection Pooling

`odbc` paketi connection pool destekler (`odbc.pool(connStr)`). Ancak Access dosya-bazli oldugu icin ve genellikle tek kullanici eristigi icin pool boyutu 1-2 ile sinirlandirilir. `poolMax` config degeri kullanilir.

## 5. SQL Templates (`sql/access/`)

### 5.1 Genel Kurallar

- Schema prefix yok: `[{table_name}]` (not `{schema_name}.[{table_name}]`)
- Identifier quoting: `[bracket]` (MSSQL ile ayni)
- CTE (WITH) kullanilmaz — subquery bazli
- Wildcard: `*` (herhangi karakter dizisi), `?` (tek karakter)
- Type casting: `CStr()`, `CDbl()`, `CInt()` (not `CAST(... AS ...)`)
- `FLOOR()` yok → `INT()` kullanilir
- `TOP N` syntax (MSSQL ile ayni)
- `CASE WHEN` yerine `IIF()` tercih edilir

### 5.2 Template Detaylari

#### `row_count.sql`
```sql
SELECT COUNT(*) AS row_count FROM [{table_name}];
```

#### `metadata.sql`
```sql
-- Metadata ODBC API ile cekilir, bu template placeholder
SELECT 1;
```

#### `null_ratio.sql`
```sql
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

> Not: `{distinct_count_expr}` bir SQL fragment'idir ve `literalParams` ile template'e yerlestirilir.
> AccessConnector ilk baglantida `COUNT(DISTINCT ...)` destegini test eder.
> Destekleniyorsa: `COUNT(DISTINCT [{column_name}])` kullanilir.
> Desteklenmiyorsa subquery fallback: `(SELECT COUNT(*) FROM (SELECT DISTINCT [{column_name}] FROM [{table_name}] WHERE [{column_name}] IS NOT NULL))`
> Bu fragment, `load()` cagirisinda `literalParams: { distinct_count_expr: fragment }` olarak gonderilir.

#### `top_n_values.sql`
```sql
SELECT TOP {top_n}
    CStr([{column_name}]) AS value,
    COUNT(*) AS frequency,
    ROUND(COUNT(*) / CDbl({total_count}), 6) AS pct
FROM [{table_name}]
WHERE [{column_name}] IS NOT NULL
GROUP BY [{column_name}]
ORDER BY COUNT(*) DESC;
```

> Not: Access'te `TOP` deger parametresi `?` ile gonderilemiyor, `{top_n}` literal substitution kullanilacak. `{total_count}` da literal.

#### `numeric_stats.sql`
```sql
SELECT
    AVG(CDbl([{column_name}])) AS mean_value,
    STDEV(CDbl([{column_name}])) AS stddev_value
FROM [{table_name}]
WHERE [{column_name}] IS NOT NULL;
```

> Percentile hesabi Access SQL'de mumkun degil. Node.js-side hesaplanir:
> `getSortedColumnValues()` ile siralanmis veri cekilip `calculatePercentiles()` ile hesaplanir.

#### `histogram.sql`
```sql
SELECT
    bucket,
    MIN(lower_b) AS lower_bound,
    MAX(upper_b) AS upper_bound,
    COUNT(*) AS freq
FROM (
    SELECT
        IIF(max_val = min_val, 1,
            INT((CDbl([{column_name}]) - sub.min_val)
                / IIF(sub.max_val - sub.min_val = 0, 1, sub.max_val - sub.min_val)
                * {buckets}) + 1
        ) AS bucket,
        sub.min_val AS lower_b,
        sub.max_val AS upper_b
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

#### `outlier_detection.sql`
```sql
-- Outlier tespiti Node.js-side yapilir (percentile hesabi gerekli)
-- Bu template siralanmis veri cekmek icin kullanilir
SELECT CDbl([{column_name}]) AS val
FROM [{table_name}]
WHERE [{column_name}] IS NOT NULL
ORDER BY [{column_name}];
```

> Node.js'te IQR hesaplanir: Q1 = p25, Q3 = p75, IQR = Q3-Q1, bounds = Q1-1.5*IQR / Q3+1.5*IQR

#### `pattern_analysis.sql`
```sql
-- Pattern SQL, Node.js tarafinda olusturulur (LIKE).
-- Access wildcard: * (herhangi karakter dizisi), ? (tek karakter)
SELECT 1;
```

> PatternAnalyzer, Access icin LIKE pattern'lerini olusturur:
> - Email: `LIKE '*@*.*'`
> - Phone TR: `LIKE '0##########'` veya `LIKE '+90##########'`
> - TC Kimlik: 11 haneli sayi kontrolu `LEN([col]) = 11 AND ISNUMERIC([col])`

#### `min_max.sql`
```sql
SELECT
    CStr(MIN([{column_name}])) AS min_value,
    CStr(MAX([{column_name}])) AS max_value
FROM [{table_name}]
WHERE [{column_name}] IS NOT NULL;
```

## 6. SqlLoader Degisiklikleri

### 6.1 Identifier Validation

Access tablo/kolon adlari bosluk, Turkce karakter, tire icerebilir:

```typescript
const ACCESS_IDENTIFIER_RE = /^.+$/;  // Access cok esnek
```

SqlLoader'da `validateIdentifier()` icinde `db_type === "access"` icin bu regex kullanilir.

### 6.2 Quoting

Access: `[name]` (MSSQL ile ayni bracket syntax).

```typescript
validateIdentifier(name: string): string {
  if (this.dbType === 'access') {
    if (!ACCESS_IDENTIFIER_RE.test(name)) {
      throw new Error(`Gecersiz SQL identifier: '${name}'.`);
    }
    return `[${name}]`;
  }
  // ... mevcut mssql/pg/oracle/hana logic
}
```

### 6.3 Literal Parameter Handling

Access SQL template'lerinde `{top_n}`, `{total_count}`, `{buckets}` gibi literal sayi parametreleri yer alir. Bunlar SqlLoader identifier validation'dan gecmez — `load()` methoduna ek olarak `loadWithLiterals()` methodu eklenir veya mevcut `load()` methodu literal params icin ek parametre alir:

```typescript
load(
  templateName: string,
  identifierParams: Record<string, string> = {},
  literalParams: Record<string, string | number> = {},
): string {
  // ... mevcut identifier substitution
  // Sonra literal substitution
  for (const [key, value] of Object.entries(literalParams)) {
    sql = sql.replaceAll(`{${key}}`, String(value));
  }
  return sql;
}
```

### 6.4 Access Parameter Method

```typescript
/**
 * Access ? positional params — dogrudan odbc.query(sql, values) ile kullanilir.
 * MSSQL'den farkli olarak @p1 donusumu gerekmez.
 */
accessParams(sql: string, params: unknown[]): { sql: string; values: unknown[] } {
  return { sql, values: params };
}
```

### 6.5 Schema-less Template Handling

Access SQL template'leri `{schema_name}` placeholder'i icermez. Profiler `schema="default"` gonderir ama template'lerde kullanilmaz.

## 7. Metrics Modulleri

### 7.1 PatternAnalyzer (`src/metrics/pattern.ts`)

Yeni `buildAccessPatternCases()` methodu eklenir:

```typescript
private buildAccessPatternCases(): string {
  // Access LIKE wildcard syntax:
  // * = herhangi karakter dizisi (SQL standart %)
  // ? = tek karakter (SQL standart _)
  // # = tek rakam (SQL standart [0-9])
  const cases: string[] = [];
  
  // Email: *@*.*
  cases.push(`IIF([{column_name}] LIKE '*@*.*', 'email', NULL)`);
  
  // Phone TR: 0 + 10 rakam veya +90 + 10 rakam
  cases.push(`IIF([{column_name}] LIKE '0##########', 'phone_tr', NULL)`);
  cases.push(`IIF([{column_name}] LIKE '+90##########', 'phone_tr', NULL)`);
  
  // TC Kimlik: 11 haneli sayi
  cases.push(`IIF(LEN([{column_name}]) = 11 AND ISNUMERIC([{column_name}]), 'tc_kimlik', NULL)`);
  
  // UUID: 8-4-4-4-12 hex pattern
  // Access'te regex yok, bu pattern cok karmasik — atlanabilir
  
  // IBAN TR: TR + 24 rakam
  cases.push(`IIF([{column_name}] LIKE 'TR########################', 'iban', NULL)`);
  
  return cases.join(',\n');
}
```

Pattern detection dispatch'inde Access branch'i eklenir:

```typescript
if (this.dbType === 'access') return this.buildAccessPatternCases();
```

### 7.2 DistributionMetrics (`src/metrics/distribution.ts`)

Access non-comparable tipleri:

```typescript
const ACCESS_NON_COMPARABLE = new Set(['oleobject', 'memo', 'hyperlink']);
```

`isNonComparableType()` fonksiyonuna Access branch'i eklenir:

```typescript
if (dbType === 'access') return ACCESS_NON_COMPARABLE.has(dt);
```

Access numeric tipleri:

```typescript
const ACCESS_NUMERIC_TYPES = new Set([
  'byte', 'integer', 'long', 'single', 'double',
  'currency', 'decimal', 'numeric', 'float',
]);
```

Top-N hesaplamada Access branch'i:
- `{top_n}` ve `{total_count}` literal substitution ile template'e yerlestirilir
- `?` parametrik deger kullanilmaz (Access TOP parametresini desteklemiyor)

Percentile hesaplamada Access branch'i:
- `AccessConnector.getSortedColumnValues()` cagirilir
- `AccessConnector.calculatePercentiles()` ile hesaplanir

### 7.3 OutlierDetector (`src/metrics/outlier.ts`)

Access branch'i:
- SQL'den Q1/Q3 hesaplamak yerine tum veri cekilir
- `AccessConnector.getSortedColumnValues()` kullanilir
- `AccessConnector.calculateIqrStats()` ile IQR hesaplanir

## 8. Profiler Entegrasyonu

### 8.1 Metadata Fetch

`Profiler._fetchSchemaMetadata()` icinde:

```typescript
if (this.dbConfig.dbType === 'access') {
  return await (this.connector as AccessConnector).getTableMetadataViaOdbc(conn, tables);
}
```

### 8.2 ConnectorFactory

```typescript
// src/connectors/factory.ts
import { AccessConnector } from './access-connector.js';

export function createConnector(config: DatabaseConfig): BaseConnector {
  if (config.dbType === 'access') return new AccessConnector(config);
  if (config.dbType === 'mssql') return new MssqlConnector(config);
  // ... diger connector'lar
}
```

## 9. Degismeyen Moduller

- `src/metrics/quality.ts` — ColumnProfile verisi ile calisir, dialect-agnostik
- `src/report/excel-report.ts` — data class'lardan rapor uretir
- `src/report/html-report.ts` — data class'lardan rapor uretir
- `src/ui/` — mevcut menu/progress aynen calisir
- `src/mapping/` — opsiyonel, degisiklik yok
- `src/utils/` — degisiklik yok

## 10. Yeni/Degisen Dosyalar Ozeti

| Dosya | Islem | Aciklama |
|-------|-------|----------|
| `src/connectors/access-connector.ts` | **YENI** | AccessConnector class |
| `sql/access/row_count.sql` | **YENI** | Basit COUNT(*) |
| `sql/access/metadata.sql` | **YENI** | Placeholder (ODBC API) |
| `sql/access/null_ratio.sql` | **YENI** | NULL/distinct ratio |
| `sql/access/min_max.sql` | **YENI** | MIN/MAX with CStr() |
| `sql/access/top_n_values.sql` | **YENI** | TOP N literal |
| `sql/access/numeric_stats.sql` | **YENI** | AVG + StDev |
| `sql/access/histogram.sql` | **YENI** | Subquery bucketing |
| `sql/access/outlier_detection.sql` | **YENI** | Siralanmis veri cekimi |
| `sql/access/pattern_analysis.sql` | **YENI** | Placeholder (Node.js-side) |
| `src/config/types.ts` | **GUNCELLEME** | DbType + dbq |
| `src/config/schema.ts` | **GUNCELLEME** | Zod schema + access dogrulama |
| `src/connectors/factory.ts` | **GUNCELLEME** | access routing |
| `src/sql/loader.ts` | **GUNCELLEME** | Access identifier regex + bracket quoting + literalParams + accessParams |
| `src/metrics/pattern.ts` | **GUNCELLEME** | Access LIKE wildcard destegi |
| `src/metrics/distribution.ts` | **GUNCELLEME** | Access non-comparable + numeric types + Node.js-side percentile |
| `src/metrics/outlier.ts` | **GUNCELLEME** | Access Node.js-side IQR |
| `src/profiler/profiler.ts` | **GUNCELLEME** | Access metadata branch |
| `package.json` | **GUNCELLEME** | odbc dependency |

## 11. Bagimliliklar

- `odbc` npm paketi eklenir (native C++ binding, node-gyp derleme gerekir)
- "Microsoft Access Driver (*.mdb, *.accdb)" ODBC surucusu sistemde yuklu olmali
- Ek Node.js paketi gerekmez (percentile/IQR hesabi pure JS)
- Windows ortami beklenir (Access ODBC driver sadece Windows'ta mevcut)
