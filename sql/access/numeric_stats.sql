SELECT
    AVG(CDbl({column_name})) AS mean_value,
    STDEV(CDbl({column_name})) AS stddev_value
FROM {table_name}
WHERE {column_name} IS NOT NULL;
