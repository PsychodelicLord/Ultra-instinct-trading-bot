type AnyRecord = Record<string, unknown>;

type TradeRow = {
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
  sellPriceCents: number | null;
  pnlCents: number;
  closedAt: Date | null;
  createdAt: Date;
};

type BotLogRow = {
  id: number;
  level: string;
  message: string;
  data: string | null;
  createdAt: Date;
};

const trades: TradeRow[] = [];
const botLogs: BotLogRow[] = [];
let tradeId = 1;
let logId = 1;

export const tradesTable = {
  __name: "trades",
  id: "id",
  status: "status",
  closedAt: "closedAt",
  pnlCents: "pnlCents",
  marketId: "marketId",
};

export const botLogsTable = {
  __name: "bot_logs",
  level: "level",
  message: "message",
  data: "data",
};

class InsertBuilder {
  constructor(private table: { __name: string }) {}

  values(input: AnyRecord | AnyRecord[]) {
    const rows = Array.isArray(input) ? input : [input];
    if (this.table.__name === "trades") {
      const inserted = rows.map((row) => {
        const normalized: TradeRow = {
          id: tradeId++,
          marketId: String(row.marketId ?? ""),
          marketTitle: String(row.marketTitle ?? ""),
          side: String(row.side ?? "YES"),
          buyPriceCents: Number(row.buyPriceCents ?? 0),
          contractCount: Number(row.contractCount ?? 1),
          feeCents: Number(row.feeCents ?? 0),
          status: String(row.status ?? "open"),
          kalshiBuyOrderId: (row.kalshiBuyOrderId as string | null) ?? null,
          kalshiSellOrderId: (row.kalshiSellOrderId as string | null) ?? null,
          minutesRemaining: Number(row.minutesRemaining ?? 0),
          sellPriceCents: (row.sellPriceCents as number | null) ?? null,
          pnlCents: Number(row.pnlCents ?? 0),
          closedAt: (row.closedAt as Date | null) ?? null,
          createdAt: (row.createdAt as Date) ?? new Date(),
        };
        trades.push(normalized);
        return normalized;
      });
      return {
        returning() {
          return Promise.resolve(inserted);
        },
      };
    }

    const inserted = rows.map((row) => {
      const normalized: BotLogRow = {
        id: logId++,
        level: String(row.level ?? "info"),
        message: String(row.message ?? ""),
        data: (row.data as string | null) ?? null,
        createdAt: new Date(),
      };
      botLogs.push(normalized);
      return normalized;
    });

    return {
      returning() {
        return Promise.resolve(inserted);
      },
    };
  }
}

class SelectBuilder {
  private tableName = "";
  private whereClause: any;

  constructor(private selectArg?: any) {}

  from(table: { __name: string }) {
    this.tableName = table.__name;
    return this;
  }

  where(clause: any) {
    this.whereClause = clause;
    return Promise.resolve(this.execute());
  }

  then(resolve: any, reject?: any) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }

  private execute() {
    if (this.selectArg && typeof this.selectArg === "object" && "total" in this.selectArg) {
      const total = trades
        .filter((t) => !t.closedAt || t.closedAt >= new Date(0))
        .reduce((sum, t) => sum + Number(t.pnlCents ?? 0), 0);
      return [{ total }];
    }

    const source = this.tableName === "trades" ? trades : botLogs;
    if (!this.whereClause || typeof this.whereClause !== "object") {
      return [...source];
    }

    if (this.whereClause.kind === "eq") {
      return source.filter((row: any) => row[this.whereClause.column] === this.whereClause.value);
    }
    if (this.whereClause.kind === "gte") {
      return source.filter((row: any) => row[this.whereClause.column] >= this.whereClause.value);
    }
    return [...source];
  }
}

class UpdateBuilder {
  private updateValues: AnyRecord = {};
  constructor(private table: { __name: string }) {}

  set(values: AnyRecord) {
    this.updateValues = values;
    return this;
  }

  where(clause: any) {
    const source = this.table.__name === "trades" ? trades : botLogs;
    for (const row of source as any[]) {
      if (!clause || clause.kind !== "eq") {
        Object.assign(row, this.updateValues);
        continue;
      }
      if (row[clause.column] === clause.value) {
        Object.assign(row, this.updateValues);
      }
    }
    return Promise.resolve();
  }
}

export const db = {
  insert(table: { __name: string }) {
    return new InsertBuilder(table);
  },
  select(selectArg?: any) {
    return new SelectBuilder(selectArg);
  },
  update(table: { __name: string }) {
    return new UpdateBuilder(table);
  },
};
