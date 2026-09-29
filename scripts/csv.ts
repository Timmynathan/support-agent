// Deliberately strict: the seed files have no quoted fields, so a quote or a ragged row means the
// file is not what we think it is, and loading it anyway would silently misalign columns.
export function parseCsv(text: string, fileLabel: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) throw new Error(`${fileLabel}: file is empty`);

  const header = splitLine(lines[0]!, fileLabel, 1);
  return lines.slice(1).map((line, index) => {
    const lineNumber = index + 2;
    const cells = splitLine(line, fileLabel, lineNumber);
    if (cells.length !== header.length) {
      throw new Error(`${fileLabel}:${lineNumber}: expected ${header.length} columns, found ${cells.length}`);
    }
    return Object.fromEntries(header.map((column, i) => [column, cells[i]!]));
  });
}

function splitLine(line: string, fileLabel: string, lineNumber: number): string[] {
  if (line.includes('"')) throw new Error(`${fileLabel}:${lineNumber}: quoted fields are not supported by this loader`);
  return line.split(',').map((cell) => cell.trim());
}
