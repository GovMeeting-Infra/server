import { parseStaffCsv, StaffCsvError } from '../staff-import.csv';

/**
 * The files this has to read are whatever a ministry's spreadsheet program
 * wrote. Every case here is a shape such a file actually takes. Names and
 * addresses are invented.
 */

const parse = (input: string | Buffer, maxRows = 100) =>
  parseStaffCsv(Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8'), {
    maxRows,
  });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof StaffCsvError ? e.code : `not a StaffCsvError: ${e}`;
  }
  return undefined;
}

describe('parseStaffCsv', () => {
  it('reads the three columns, with line numbers', () => {
    expect(
      parse('First Name,Last Name,Email\nAminata,Koroma,a.koroma@mof.gov.sl\n'),
    ).toEqual([
      {
        line: 2,
        firstName: 'Aminata',
        lastName: 'Koroma',
        email: 'a.koroma@mof.gov.sl',
      },
    ]);
  });

  it.each([
    ['first_name,last_name,email_address'],
    ['FIRSTNAME,SURNAME,E-mail'],
    ['Given name,Family name,Mail'],
    ['First Name,Last Name,Email address,Role,Last login time'],
  ])('accepts the header %s', (header) => {
    const [row] = parse(`${header}\nAminata,Koroma,a.koroma@mof.gov.sl,x,y\n`);
    expect(row.firstName).toBe('Aminata');
    expect(row.lastName).toBe('Koroma');
    expect(row.email).toBe('a.koroma@mof.gov.sl');
  });

  it('finds the columns wherever they are, ignoring the rest', () => {
    const [row] = parse(
      'Email,Department,Surname,First name\nb@x.gov.sl,HR,Bangura,Ibrahim',
    );
    expect(row).toMatchObject({
      firstName: 'Ibrahim',
      lastName: 'Bangura',
      email: 'b@x.gov.sl',
    });
  });

  it('allows a file with no surname column', () => {
    const [row] = parse('First name,Email\nFatmata,f@x.gov.sl');
    expect(row.lastName).toBe('');
  });

  it('handles CRLF, a UTF-8 BOM and blank lines', () => {
    const rows = parse(
      '\uFEFFFirst Name,Last Name,Email\r\n\r\nA,B,a@x.gov.sl\r\n,,\r\nC,D,c@x.gov.sl',
    );
    expect(rows.map((r) => [r.line, r.email])).toEqual([
      [3, 'a@x.gov.sl'],
      [5, 'c@x.gov.sl'],
    ]);
  });

  it('reads quoted fields with commas, doubled quotes and line breaks', () => {
    const rows = parse(
      'First Name,Last Name,Email\n"Mary, Jane","O""Neil",m@x.gov.sl\n"Two\nLines",Sesay,t@x.gov.sl\nNext,Row,n@x.gov.sl',
    );
    expect(rows[0]).toMatchObject({
      firstName: 'Mary, Jane',
      lastName: 'O"Neil',
    });
    expect(rows[1]).toMatchObject({ line: 3, firstName: 'Two Lines' });
    // The quoted line break counts, so the next record is reported on line 5.
    expect(rows[2].line).toBe(5);
  });

  it('reads semicolon exports, with or without a sep= line', () => {
    expect(parse('First Name;Last Name;Email\nA;B;a@x.gov.sl')[0].email).toBe(
      'a@x.gov.sl',
    );
    const [row] = parse('sep=;\nFirst Name;Last Name;Email\nA;B;a@x.gov.sl');
    expect(row).toMatchObject({ line: 3, email: 'a@x.gov.sl' });
  });

  it('reads tab-separated text', () => {
    expect(
      parse('First Name\tLast Name\tEmail\nA\tB\ta@x.gov.sl')[0].lastName,
    ).toBe('B');
  });

  it("decodes Excel's Windows-1252 rather than mangling accents", () => {
    const bytes = Buffer.concat([
      Buffer.from('First Name,Last Name,Email\nJos'),
      Buffer.from([0xe9]), // é in Windows-1252, invalid on its own as UTF-8
      Buffer.from(',Conteh,j@x.gov.sl'),
    ]);
    expect(parse(bytes)[0].firstName).toBe('José');
  });

  it('decodes UTF-16 with a byte-order mark', () => {
    const le = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('First Name,Last Name,Email\nA,B,a@x.gov.sl', 'utf16le'),
    ]);
    expect(parse(le)[0].email).toBe('a@x.gov.sl');

    const be = Buffer.from(
      'First Name,Last Name,Email\nA,B,a@x.gov.sl',
      'utf16le',
    );
    be.swap16();
    expect(parse(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))[0].email).toBe(
      'a@x.gov.sl',
    );
  });

  it('strips invisible characters and squeezes whitespace', () => {
    const [row] = parse(
      'First Name,Last Name,Email\n  Abu \u200B Bakarr ,Kamara\u202E, a@x.gov.sl\u00A0',
    );
    expect(row).toMatchObject({
      firstName: 'Abu Bakarr',
      lastName: 'Kamara',
      email: 'a@x.gov.sl',
    });
  });

  it('refuses an Excel workbook with a pointer to Save As CSV', () => {
    const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(codeOf(() => parse(xlsx))).toBe('SPREADSHEET_NOT_CSV');
    const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]);
    expect(codeOf(() => parse(xls))).toBe('SPREADSHEET_NOT_CSV');
  });

  it('refuses binary that is not a spreadsheet', () => {
    expect(
      codeOf(() => parse(Buffer.from([0x41, 0x00, 0x42, 0x00, 0x0a]))),
    ).toBe('NOT_CSV');
  });

  it('refuses empty files and header-only files', () => {
    expect(codeOf(() => parse(Buffer.alloc(0)))).toBe('EMPTY_FILE');
    expect(codeOf(() => parse('\n\n'))).toBe('EMPTY_FILE');
    expect(codeOf(() => parse('First Name,Last Name,Email\n'))).toBe(
      'EMPTY_FILE',
    );
  });

  it('refuses a file whose first row is not headings', () => {
    expect(
      codeOf(() => parse('Aminata,Koroma,a@x.gov.sl\nB,C,b@x.gov.sl')),
    ).toBe('MISSING_COLUMNS');
    expect(codeOf(() => parse('First Name,Last Name\nA,B'))).toBe(
      'MISSING_COLUMNS',
    );
  });

  it('refuses an unterminated quote, naming the line', () => {
    try {
      parse(
        'First Name,Last Name,Email\nA,B,a@x.gov.sl\n"Open,B,b@x.gov.sl\nC,D,c@x.gov.sl',
      );
      fail('expected an error');
    } catch (e) {
      expect((e as StaffCsvError).code).toBe('MALFORMED_CSV');
      expect((e as Error).message).toContain('line 3');
    }
  });

  it('refuses the whole file above the row cap', () => {
    const body = [
      'First Name,Last Name,Email',
      ...Array.from({ length: 4 }, (_, i) => `A${i},B,a${i}@x.gov.sl`),
    ].join('\n');
    expect(parse(body, 4)).toHaveLength(4);
    expect(codeOf(() => parse(body, 3))).toBe('TOO_MANY_ROWS');
  });

  it('keeps formula-looking text as text; nothing here evaluates it', () => {
    const [row] = parse(
      'First Name,Last Name,Email\n=HYPERLINK("x"),B,a@x.gov.sl',
    );
    expect(row.firstName).toBe('=HYPERLINK("x")');
  });
});
