type LogPayload = Record<string, unknown>;

function write(level: string, payload: LogPayload, message?: string): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    message: message ?? "",
    ...payload,
  };
  console.log(JSON.stringify(line));
}

export const logger = {
  info(payload: LogPayload, message?: string): void {
    write("info", payload, message);
  },
  warn(payload: LogPayload, message?: string): void {
    write("warn", payload, message);
  },
  error(payload: LogPayload, message?: string): void {
    write("error", payload, message);
  },
};
