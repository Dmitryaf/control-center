// Column expressions are fixed by callers, never supplied by requests.
export const taskProjectsSql = (json: string) =>
  `COALESCE(json_extract(${json},'$.projectIds'),CASE WHEN json_extract(${json},'$.projectId') IS NULL THEN '[]' ELSE json_array(json_extract(${json},'$.projectId')) END)`;
