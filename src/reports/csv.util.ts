/**
 * CSV encoding.
 *
 * Two things the previous inline `"${cell}"` did not handle:
 *
 * 1. **Embedded quotes.** RFC 4180 escapes a quote by doubling it. Wrapping a
 *    title like `Budget "Q3" Review` in quotes without doubling produced
 *    `"Budget "Q3" Review"`, which ends the field early and shifts every
 *    following column.
 * 2. **Formula injection.** A cell starting with = + - @ or a control
 *    character is executed as a formula by Excel and Sheets when the file is
 *    opened. Meeting titles and names are user-supplied, so an exported
 *    government record is exactly the wrong place to leave that open. Such
 *    cells are prefixed with an apostrophe, which those applications treat as
 *    "this is text".
 */

const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';

  let text = String(value);

  if (FORMULA_TRIGGERS.includes(text.charAt(0))) {
    text = `'${text}`;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

/** Rows to a CSV document, with the trailing newline spreadsheets expect. */
export function toCsv(rows: unknown[][]): string {
  return rows.map(csvRow).join('\r\n') + '\r\n';
}
