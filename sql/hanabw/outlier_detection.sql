-- IQR tabanli outlier tespiti (HANA)
-- Value params: ? (iqr_multiplier x2)
WITH quartiles AS (
    SELECT DISTINCT
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY CAST({column_name} AS DOUBLE)) OVER() AS q1,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY CAST({column_name} AS DOUBLE)) OVER() AS q3
    FROM {schema_name}.{table_name} {sample_clause}
    WHERE {column_name} IS NOT NULL
),
bounds AS (
    SELECT q1, q3,
        q3 - q1 AS iqr,
        q1 - (q3 - q1) * ? AS lower_bound,
        q3 + (q3 - q1) * ? AS upper_bound
    FROM quartiles
    LIMIT 1
)
SELECT
    b.q1, b.q3, b.iqr, b.lower_bound, b.upper_bound,
    COUNT(CASE WHEN CAST(t.{column_name} AS DOUBLE) < b.lower_bound
                 OR CAST(t.{column_name} AS DOUBLE) > b.upper_bound
               THEN 1 END) AS outlier_count,
    COUNT(t.{column_name}) AS total_non_null
FROM {schema_name}.{table_name} t {sample_clause}, bounds b
WHERE t.{column_name} IS NOT NULL
GROUP BY b.q1, b.q3, b.iqr, b.lower_bound, b.upper_bound
