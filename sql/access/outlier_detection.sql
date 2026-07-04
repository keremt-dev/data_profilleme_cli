SELECT CDbl({column_name}) AS val
FROM {table_name}
WHERE {column_name} IS NOT NULL
ORDER BY {column_name};
