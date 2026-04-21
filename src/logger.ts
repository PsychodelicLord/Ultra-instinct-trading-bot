export const logger = {
  info(payload: unknown, message?: string) {
    if (message) {
      console.log(`[info] ${message}`, payload ?? "");
      return;
    }
    console.log(`[info]`, payload ?? "");
  },
  error(payload: unknown, message?: string) {
    if (message) {
      console.error(`[error] ${message}`, payload ?? "");
      return;
    }
    console.error(`[error]`, payload ?? "");
  },
};
