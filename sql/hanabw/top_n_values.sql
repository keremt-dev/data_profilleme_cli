-- En sik N deger
-- Value params: ? (total_count), ? (top_n)
SELECT
    CAST({column_name} AS NVARCHAR(5000)) AS value,
    COUNT(*) AS frequency,
    ROUND(CAST(COUNT(*) AS DECIMAL) / ?, 6) AS pct
FROM {schema_name}.{table_name} {sample_clause}
WHERE {column_name} IS NOT NULL
GROUP BY {column_name}
ORDER BY frequency DESC
LIMIT ?
