// Structured JSON logs. Never pass secrets, passwords, tokens or document contents here.
// service/env/version identify the emitting process and deployed build (GIT_SHA is baked into the container image).
let base: object | null = null;
function write(level: string, obj: object, msg: string) {
  if (process.env.LOG_SILENT === '1') return;
  base ??= { service: `taskapp-${process.env.APP_ROLE || 'all'}`, env: process.env.APP_ENV || process.env.NODE_ENV || 'development', version: process.env.GIT_SHA || 'dev' };
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...base, ...obj }) + '\n');
}
export const log = {
  info: (o: object, m: string) => write('info', o, m),
  warn: (o: object, m: string) => write('warn', o, m),
  error: (o: object, m: string) => write('error', o, m),
};
