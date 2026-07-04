SELECT DISTINCT
    AVG(CAST({column_name} AS DOUBLE)) OVER()                                                     AS mean_value,
    STDDEV(CAST({column_name} AS DOUBLE)) OVER()                                                  AS stddev_value,
    PERCENTILE_CONT(0.01) WITHIN GROUP (ORDER BY CAST({column_name} AS DOUBLE)) OVER()            AS p01,
    PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY CAST({column_name} AS DOUBLE)) OVER()            AS p05,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY CAST({column_name} AS DOUBLE)) OVER()            AS p25,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY CAST({column_name} AS DOUBLE)) OVER()            AS p50,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY CAST({column_name} AS DOUBLE)) OVER()            AS p75,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY CAST({column_name} AS DOUBLE)) OVER()            AS p95,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY CAST({column_name} AS DOUBLE)) OVER()            AS p99
FROM {schema_name}.{table_name} {sample_clause}
WHERE {column_name} IS NOT NULL
