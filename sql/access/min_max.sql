SELECT
    IIF(MIN({column_name}) IS NULL, NULL, CStr(MIN({column_name}))) AS min_value,
    IIF(MAX({column_name}) IS NULL, NULL, CStr(MAX({column_name}))) AS max_value
FROM {table_name}
WHERE {column_name} IS NOT NULL;
