import type { RowPredicate, SqlFragment } from "./query-helpers";

type Row = Record<string, any>;

type TradesRow = {
  id: number;
  marketId: string;
  marketTitle: string;
  side: string;
  buyPriceCents: number;
  contractCount: number;
  feeCents: number;
  status: string;
  kalshiBuyOrderId: string | null;
  kalshiSellOrderId: string | null;
  minutesRemaining: number;
  pnlCents: number;
  sellPriceCents: number | null;
  createdAt: Date;
  closedAt: Date | null;
};

type BotLogRow = {
  id: number;
  level: string;
  message: string;
  data: string | null;
  createdAt: Date;
};

type TableDef<T extends Row> = {
  name: string;
  rows: T[];
  autoId: number;
  columns: Record<string, { table: string; name: string }>;
};

function column(table: string, name: string): { table: string; name: string } {
  return { table, name };
}

function createTable<T extends Row>(name: string, columnNames: string[]): TableDef<T> {
  const columns: Record<string, { table: string; name: string }> = {};
  for (const c of columnNames) columns[c] = column(name, c);
  return { name, rows: [], autoId: 1, columns };
}

const tradesState = createTable<TradesRow>("trades", [
  "id",
  "marketId",
  "marketTitle",
  "side",
  "buyPriceCents",
  "contractCount",
  "feeCents",
  "status",
  "kalshiBuyOrderId",
  "kalshiSellOrderId",
  "minutesRemaining",
  "pnlCents",
  "sellPriceCents",
  "createdAt",
  "closedAt",
]);

const botLogsState = createTable<BotLogRow>("bot_logs", ["id", "level", "message", "data", "createdAt"]);

export const tradesTable = {
  _def: tradesState,
  id: tradesState.columns.id,
  marketId: tradesState.columns.marketId,
  marketTitle: tradesState.columns.marketTitle,
  side: tradesState.columns.side,
  buyPriceCents: tradesState.columns.buyPriceCents,
  contractCount: tradesState.columns.contractCount,
  feeCents: tradesState.columns.feeCents,
  status: tradesState.columns.status,
  kalshiBuyOrderId: tradesState.columns.kalshiBuyOrderId,
  kalshiSellOrderId: tradesState.columns.kalshiSellOrderId,
  minutesRemaining: tradesState.columns.minutesRemaining,
  pnlCents: tradesState.columns.pnlCents,
  sellPriceCents: tradesState.columns.sellPriceCents,
  createdAt: tradesState.columns.createdAt,
  closedAt: tradesState.columns.closedAt,
};

export const botLogsTable = {
  _def: botLogsState,
  id: botLogsState.columns.id,
  level: botLogsState.columns.level,
  message: botLogsState.columns.message,
  data: botLogsState.columns.data,
  createdAt: botLogsState.columns.createdAt,
};

function withDefaults(tableName: string, value: Row): Row {
  if (tableName === "trades") {
    return {
      kalshiBuyOrderId: null,
      kalshiSellOrderId: null,
      sellPriceCents: null,
      pnlCents: 0,
      closedAt: null,
      createdAt: new Date(),
      ...value,
    };
  }
  if (tableName === "bot_logs") return { createdAt: new Date(), ...value };
  return value;
}

function getRows(table: any): Row[] {
  return table._def.rows;
}

function matches(predicate: RowPredicate | undefined, row: Row): boolean {
  return predicate ? Boolean(predicate(row)) : true;
}

class SelectBuilder {
  private table: any;
  private predicate?: RowPredicate;
  constructor(private fields?: Record<string, SqlFragment>) {}
  from(table: any): this {
    this.table = table;
    return this;
  }
  where(predicate: RowPredicate): this {
    this.predicate = predicate;
    return this;
  }
  then(resolve: (value: any) => void, reject?: (reason?: unknown) => void): Promise<void> {
    try {
      const rows = getRows(this.table).filter((row) => matches(this.predicate, row));
      if (this.fields && Object.keys(this.fields).length > 0) {
        const out: Record<string, unknown> = {};
        for (const [alias, frag] of Object.entries(this.fields)) {
          if (frag.kind === "sql" && frag.text.includes("sum(")) {
            out[alias] = rows.reduce((acc, row) => acc + Number(row.pnlCents ?? 0), 0);
          } else {
            out[alias] = null;
          }
        }
        resolve([out]);
      } else {
        resolve(rows.map((r) => ({ ...r })));
      }
    } catch (err) {
      reject?.(err);
    }
    return Promise.resolve();
  }
}

class InsertBuilder {
  private valuesToInsert: Row[] = [];
  constructor(private table: any) {}
  values(value: Row | Row[]): this {
    this.valuesToInsert = Array.isArray(value) ? value : [value];
    return this;
  }
  returning(): Promise<Row[]> {
    const rows = getRows(this.table);
    const inserted = this.valuesToInsert.map((value) => {
      const row = withDefaults(this.table._def.name, value);
      const fullRow = { ...row, id: this.table._def.autoId++ };
      rows.push(fullRow);
      return { ...fullRow };
    });
    return Promise.resolve(inserted);
  }
  then(resolve: (value: unknown) => void): Promise<void> {
    const rows = getRows(this.table);
    this.valuesToInsert.forEach((value) => {
      const row = withDefaults(this.table._def.name, value);
      const fullRow = { ...row, id: this.table._def.autoId++ };
      rows.push(fullRow);
    });
    resolve(undefined);
    return Promise.resolve();
  }
}

class UpdateBuilder {
  private updates: Row = {};
  private predicate?: RowPredicate;
  constructor(private table: any) {}
  set(values: Row): this {
    this.updates = values;
    return this;
  }
  where(predicate: RowPredicate): Promise<void> {
    this.predicate = predicate;
    const rows = getRows(this.table);
    for (const row of rows) {
      if (matches(this.predicate, row)) Object.assign(row, this.updates);
    }
    return Promise.resolve();
  }
}

export const db = {
  select(fields?: Record<string, SqlFragment>): SelectBuilder {
    return new SelectBuilder(fields);
  },
  insert(table: any): InsertBuilder {
    return new InsertBuilder(table);
  },
  update(table: any): UpdateBuilder {
    return new UpdateBuilder(table);
  },
};
