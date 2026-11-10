/** One structured log record. */
export type LogLine = Record<string, unknown>;
export type Logger = (line: LogLine) => void;

/** One JSON line on stdout (stderr for errors), which CloudWatch keeps as a structured record. */
export const jsonLog: Logger = (line) => {
  const text = JSON.stringify(line);
  if (line.level === 'error') console.error(text);
  else console.log(text);
};
