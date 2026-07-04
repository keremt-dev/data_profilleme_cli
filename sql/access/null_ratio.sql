SELECT
    COUNT(*) AS total_count,
    COUNT({column_name}) AS non_null_count,
    COUNT(*) - COUNT({column_name}) AS null_count,
    IIF(COUNT(*) > 0,
        ROUND((COUNT(*) - COUNT({column_name})) / CDbl(COUNT(*)), 6),
        0) AS null_ratio,
    {distinct_count_expr} AS distinct_count,
    IIF(COUNT({column_name}) > 0,
        ROUND({distinct_count_expr} / CDbl(COUNT({column_name})), 6),
        0) AS distinct_ratio
FROM {table_name};
