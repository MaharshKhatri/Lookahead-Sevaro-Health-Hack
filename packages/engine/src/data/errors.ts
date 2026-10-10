/** Thrown for any row or file that cannot be parsed. Message always names the file (and line when known). */
export class DataParseError extends Error {
  override readonly name = 'DataParseError';
  readonly file: string;
  readonly line: number | null;

  constructor(file: string, line: number | null, detail: string) {
    super(line === null ? `${file}: ${detail}` : `${file}:${line}: ${detail}`);
    this.file = file;
    this.line = line;
  }
}
