import { HttpStatus } from '@nestjs/common';

/**
 * Reads a ministry's staff list — first name, last name, email — out of
 * whatever a spreadsheet program produced when somebody chose "Save as CSV".
 *
 * Deliberately not a library. Nothing else in this project parses CSV, the
 * format needed here is small, and the hard cases are not the grammar but the
 * files: Excel on Windows writes Windows-1252 rather than UTF-8, French-locale
 * Excel separates with semicolons, and a header can be "Email address",
 * "E-mail" or "email". Each of those is handled below and covered by
 * __tests__/staff-import.csv.spec.ts.
 *
 * Pure: bytes in, rows or a StaffCsvError out. It decides nothing about who
 * belongs on a roster — that is staff-import.classify.ts.
 */

export type StaffCsvErrorCode =
  | 'EMPTY_FILE'
  | 'NOT_CSV'
  | 'SPREADSHEET_NOT_CSV'
  | 'MALFORMED_CSV'
  | 'MISSING_COLUMNS'
  | 'TOO_MANY_ROWS';

export class StaffCsvError extends Error {
  constructor(
    readonly code: StaffCsvErrorCode,
    message: string,
    readonly status: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super(message);
  }
}

export interface StaffCsvRow {
  /** 1-based line in the file where this record starts, for the uploader. */
  line: number;
  firstName: string;
  lastName: string;
  email: string;
}

/**
 * Header spellings seen in, or plausible for, ministry exports. Compared after
 * lowercasing and dropping everything that is not a letter or digit, so
 * "First Name", "first_name" and "FIRSTNAME" are all `firstname`.
 */
const HEADER_ALIASES: Record<'firstName' | 'lastName' | 'email', string[]> = {
  firstName: ['firstname', 'givenname', 'forename', 'first'],
  lastName: ['lastname', 'surname', 'familyname', 'last'],
  email: ['email', 'emailaddress', 'mail', 'emailid', 'workemail'],
};

/**
 * C0/C1 controls, and the invisible characters that make two equal-looking
 * addresses differ: soft hyphen, zero-width, bidi overrides, BOM. Written as
 * escapes so the source itself holds none of them.
 */
export const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export function decodeCsv(buf: Buffer): string {
  if (buf.length === 0) {
    throw new StaffCsvError('EMPTY_FILE', 'The file is empty.');
  }

  // .xlsx is a zip; .xls is an OLE compound file. Both are what somebody
  // uploads when they meant to export, and the fix is theirs to make.
  const zip =
    buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  const ole =
    buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
  if (zip || ole) {
    throw new StaffCsvError(
      'SPREADSHEET_NOT_CSV',
      'This is an Excel workbook, not a CSV. In Excel choose File → Save As → CSV, then upload that file.',
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
  }

  let text: string;
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2).toString('utf16le');
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    // Node has no utf16be codec; swap to little-endian.
    const body = Buffer.from(buf.subarray(2));
    body.swap16();
    text = body.toString('utf16le');
  } else {
    const body =
      buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
        ? buf.subarray(3)
        : buf;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      // Not valid UTF-8, so almost certainly Excel's Windows default. Decoding
      // it as UTF-8 anyway would turn every accented name into replacement
      // characters and store them that way.
      text = new TextDecoder('windows-1252').decode(body);
    }
  }

  if (text.includes('\u0000')) {
    throw new StaffCsvError(
      'NOT_CSV',
      'This does not look like a text CSV file.',
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
  }
  return text;
}

/**
 * RFC 4180 records: quoted fields may hold the delimiter, doubled quotes and
 * line breaks. Each record carries the line it started on.
 */
function records(
  text: string,
  delimiter: string,
): Array<{ line: number; cells: string[] }> {
  const out: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let quoteOpenedOn = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell.trim() === '') {
      quoted = true;
      quoteOpenedOn = line;
      cell = '';
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell);
      out.push({ line: start, cells });
      cells = [];
      cell = '';
      line++;
      start = line;
    } else {
      cell += ch;
    }
  }

  if (quoted) {
    throw new StaffCsvError(
      'MALFORMED_CSV',
      `A quote opened on line ${quoteOpenedOn} is never closed.`,
    );
  }
  if (cell !== '' || cells.length > 0) {
    cells.push(cell);
    out.push({ line: start, cells });
  }
  return out;
}

/** Comma, semicolon or tab — whichever the header line uses most. */
function detectDelimiter(firstLine: string): string {
  const unquoted = firstLine.replace(/"[^"]*"/g, '');
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t']) {
    const count = unquoted.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

function clean(value: string): string {
  // Whitespace first, so a line break inside a quoted name becomes a space
  // rather than being stripped as a control character and joining two words.
  return value
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(INVISIBLE, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function headerKey(value: string): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function parseStaffCsv(
  buf: Buffer,
  { maxRows }: { maxRows: number },
): StaffCsvRow[] {
  let text = decodeCsv(buf);

  // Excel's "sep=;" hint line, written by some exports to name the delimiter.
  let delimiter: string | undefined;
  let lineOffset = 0;
  const sep = /^sep=(.)\r?\n/i.exec(text);
  if (sep) {
    delimiter = sep[1];
    text = text.slice(sep[0].length);
    lineOffset = 1;
  }
  delimiter ??= detectDelimiter(text.split(/\r?\n/, 1)[0] ?? '');

  const all = records(text, delimiter)
    .map((r) => ({ line: r.line + lineOffset, cells: r.cells.map(clean) }))
    .filter((r) => r.cells.some((c) => c !== ''));

  if (all.length === 0) {
    throw new StaffCsvError('EMPTY_FILE', 'The file has no rows.');
  }

  const [header, ...data] = all;
  const keys = header.cells.map(headerKey);
  const find = (aliases: string[]) =>
    keys.findIndex((k) => aliases.includes(k));
  const col = {
    firstName: find(HEADER_ALIASES.firstName),
    lastName: find(HEADER_ALIASES.lastName),
    email: find(HEADER_ALIASES.email),
  };

  const missing = [
    col.firstName === -1 && 'first name',
    col.email === -1 && 'email',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new StaffCsvError(
      'MISSING_COLUMNS',
      `The first row must be column headings, including ${missing.join(' and ')}. Found: ${
        header.cells.filter(Boolean).join(', ') || 'nothing'
      }.`,
    );
  }

  if (data.length === 0) {
    throw new StaffCsvError(
      'EMPTY_FILE',
      'The file has headings but no people.',
    );
  }
  if (data.length > maxRows) {
    throw new StaffCsvError(
      'TOO_MANY_ROWS',
      `The file has ${data.length} rows; the limit is ${maxRows}. Split it and upload each part.`,
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
  }

  return data.map(({ line, cells }) => ({
    line,
    firstName: cells[col.firstName] ?? '',
    lastName: col.lastName === -1 ? '' : (cells[col.lastName] ?? ''),
    email: cells[col.email] ?? '',
  }));
}
