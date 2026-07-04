SELECT
    bucket,
    MIN(lower_b) AS lower_bound,
    MAX(upper_b) AS upper_bound,
    COUNT(*) AS freq
FROM (
    SELECT
        IIF(sub.max_val = sub.min_val, 1,
            INT((CDbl({column_name}) - sub.min_val)
                / IIF(sub.max_val - sub.min_val = 0, 1, sub.max_val - sub.min_val)
                * {buckets}) + 1
        ) AS bucket,
        sub.min_val AS lower_b,
        sub.max_val AS upper_b
    FROM {table_name},
        (SELECT MIN(CDbl({column_name})) AS min_val,
                MAX(CDbl({column_name})) AS max_val
         FROM {table_name}
         WHERE {column_name} IS NOT NULL) AS sub
    WHERE {column_name} IS NOT NULL
) AS bucketed
WHERE bucket BETWEEN 1 AND {buckets}
GROUP BY bucket
ORDER BY bucket;
