-- Numerik histogram (HANA - manual bucket, no WIDTH_BUCKET)
-- Literal substitution: {buckets}
WITH stats AS (
    SELECT
        MIN(CAST({column_name} AS DOUBLE)) AS min_val,
        MAX(CAST({column_name} AS DOUBLE)) AS max_val
    FROM {schema_name}.{table_name} {sample_clause}
    WHERE {column_name} IS NOT NULL
),
bucketed AS (
    SELECT
        CASE
            WHEN s.max_val = s.min_val THEN 1
            ELSE CAST(
                FLOOR(
                    (CAST({column_name} AS DOUBLE) - s.min_val)
                    / NULLIF(s.max_val - s.min_val, 0) * {buckets}
                ) AS INT
            ) + 1
        END AS bucket,
        s.min_val,
        s.max_val
    FROM {schema_name}.{table_name} t {sample_clause}, stats s
    WHERE {column_name} IS NOT NULL
)
SELECT
    b.bucket,
    MIN(b.min_val) + (b.bucket - 1) * (MAX(b.max_val) - MIN(b.min_val)) / {buckets} AS lower_bound,
    MIN(b.min_val) + b.bucket * (MAX(b.max_val) - MIN(b.min_val)) / {buckets} AS upper_bound,
    COUNT(*) AS freq
FROM bucketed b
WHERE b.bucket BETWEEN 1 AND {buckets}
GROUP BY b.bucket
ORDER BY b.bucket
