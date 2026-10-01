// Structured JSON logs. Never pass secrets, passwords, tokens or document contents here.
function write(level: string, obj: object, msg: string) {
  if (process.env.LOG_SILENT === '1') return;
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...obj }) + '\n');
}
export const log = {
  info: (o: object, m: string) => write('info', o, m),
  warn: (o: object, m: string) => write('warn', o, m),
  error: (o: object, m: string) => write('error', o, m),
};
