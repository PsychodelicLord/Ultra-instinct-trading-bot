type Column = {
  table: string;
  name: string;
};

export type RowPredicate<T = Record<string, unknown>> = (row: T) => boolean;

function valueOf(row: Record<string, unknown>, column: Column): unknown {
  return row[column.name];
}

export function eq(column: Column, expected: unknown): RowPredicate {
  return (row) => valueOf(row, column) === expected;
}

export function gte(column: Column, minimum: unknown): RowPredicate {
  return (row) => {
    const value = valueOf(row, column) as number | Date | undefined;
    if (value == null || minimum == null) return false;
    if (value instanceof Date && minimum instanceof Date) return value.getTime() >= minimum.getTime();
    return Number(value) >= Number(minimum);
  };
}

export type SqlFragment = {
  kind: "sql";
  text: string;
};

export function sql<T = unknown>(strings: TemplateStringsArray, ...parts: unknown[]): SqlFragment {
  const text = strings.reduce((acc, str, idx) => `${acc}${str}${idx < parts.length ? String(parts[idx]) : ""}`, "");
  return { kind: "sql", text } satisfies SqlFragment;
}
