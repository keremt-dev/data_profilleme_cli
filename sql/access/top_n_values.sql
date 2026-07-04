SELECT TOP {top_n} val, freq, ROUND(freq / CDbl({total_count}), 6) AS pct
FROM (
  SELECT {column_name} AS val, COUNT(*) AS freq
  FROM {table_name}
  WHERE {column_name} IS NOT NULL
  GROUP BY {column_name}
) AS sub
ORDER BY freq DESC;
