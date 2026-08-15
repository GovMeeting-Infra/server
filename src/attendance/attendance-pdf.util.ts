import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import PDFDocument from 'pdfkit';
import type { ExportEvent, ExportRow } from './attendance-export.service';
import { setLabel } from './attendance-export.service';
import type { ExportSet } from './dto/export-attendance.dto';

const NAVY = '#003580';
const GREEN = '#007236';
const GREY = '#6b7280';
const RULE = '#d3deef';

const MARGIN = 40;
const SIGNATURE_WIDTH = 110;
const SIGNATURE_HEIGHT = 34;
const ROW_HEIGHT = SIGNATURE_HEIGHT + 12;

/** x offset and width of each column, left to right. */
const COLUMNS = {
  index: { x: 0, width: 22 },
  name: { x: 22, width: 118 },
  role: { x: 140, width: 130 },
  contact: { x: 270, width: 132 },
  time: { x: 402, width: 58 },
  signature: { x: 460, width: SIGNATURE_WIDTH },
};

/**
 * Copied into the server tree because web/ deploys separately — there is no
 * shared public directory in production. Resolved relative to __dirname so it
 * works the same from src/ under ts-node and from dist/ under PM2.
 */
function coatOfArms(): Buffer | null {
  for (const path of [
    join(__dirname, '..', 'assets', 'coat_of_arms.png'),
    join(process.cwd(), 'src', 'assets', 'coat_of_arms.png'),
  ]) {
    if (existsSync(path)) return readFileSync(path);
  }
  return null;
}

/** The PNG bytes behind a `data:image/png;base64,...` signature. */
function decodeSignature(dataUrl: string | null): Buffer | null {
  if (!dataUrl) return null;

  const comma = dataUrl.indexOf(',');
  if (comma === -1 || !dataUrl.slice(0, comma).includes('base64')) return null;

  try {
    const buffer = Buffer.from(dataUrl.slice(comma + 1), 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

function formatDateTime(date: Date): string {
  return date.toLocaleString('en-GB', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}

function formatTime(date: Date | null): string {
  if (!date) return '—';
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

/**
 * The attendance register, as the paper sign-in sheet it replaces: the arms at
 * the top, the meeting it belongs to, and every attendee's own signature
 * beside their name.
 *
 * Streams into the response — the signatures are already in memory from the
 * query, and there is no reason to hold a second copy of the whole document.
 */
export function renderAttendancePdf(
  event: ExportEvent,
  rows: ExportRow[],
  set: ExportSet,
  stream: NodeJS.WritableStream,
): void {
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    // Page numbers cannot be written until the count is known, so the pages
    // are held open until the totals are in.
    bufferPages: true,
    info: {
      Title: `Attendance register — ${event.title}`,
      Author: event.ministry?.name ?? 'Government of Sierra Leone',
    },
  });

  doc.pipe(stream);

  const contentWidth = doc.page.width - MARGIN * 2;
  const left = MARGIN;

  drawHeader(doc, event, set, rows, left, contentWidth);
  let y = doc.y + 8;
  y = drawColumnHeader(doc, y, left, contentWidth);

  rows.forEach((row, index) => {
    if (y + ROW_HEIGHT > doc.page.height - MARGIN - 30) {
      doc.addPage();
      y = MARGIN;
      y = drawColumnHeader(doc, y, left, contentWidth);
    }
    drawRow(doc, row, index + 1, y, left, contentWidth);
    y += ROW_HEIGHT;
  });

  if (rows.length === 0) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(10)
      .fillColor(GREY)
      .text('Nobody on this list.', left, y + 8);
    y += 24;
  }

  drawTotals(doc, rows, set, y + 12, left, contentWidth);
  drawPageNumbers(doc);

  doc.end();
}

function drawHeader(
  doc: PDFKit.PDFDocument,
  event: ExportEvent,
  set: ExportSet,
  rows: ExportRow[],
  left: number,
  width: number,
): void {
  const arms = coatOfArms();
  const textLeft = arms ? left + 58 : left;

  if (arms) {
    try {
      doc.image(arms, left, MARGIN, { fit: [46, 46] });
    } catch {
      // A missing or unreadable emblem is not worth losing the register over.
    }
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(GREEN)
    .text('GOVERNMENT OF SIERRA LEONE', textLeft, MARGIN + 2, {
      characterSpacing: 1.2,
    });

  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(GREY)
    .text(event.ministry?.name ?? '', textLeft, doc.y + 1);

  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(NAVY)
    .text('ATTENDANCE REGISTER', textLeft, doc.y + 6);

  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#111827')
    .text(event.title, left, doc.y + 10, { width });

  const details = [
    formatDateTime(event.startAt),
    event.venueName || null,
    `${setLabel(set)} · ${rows.length} ${rows.length === 1 ? 'person' : 'people'}`,
  ].filter(Boolean);

  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(GREY)
    .text(details.join('  ·  '), left, doc.y + 3, { width });

  doc.moveDown(0.6);
}

function drawColumnHeader(
  doc: PDFKit.PDFDocument,
  y: number,
  left: number,
  width: number,
): number {
  doc.save().rect(left, y, width, 20).fill('#f1f6fd').restore();

  doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY);

  const cells: [keyof typeof COLUMNS, string][] = [
    ['index', '#'],
    ['name', 'NAME'],
    ['role', 'TITLE / ORGANISATION'],
    ['contact', 'EMAIL / PHONE'],
    ['time', 'TIME IN'],
    ['signature', 'SIGNATURE'],
  ];

  for (const [key, label] of cells) {
    const column = COLUMNS[key];
    doc.text(label, left + column.x + 4, y + 6, {
      width: column.width - 6,
      lineBreak: false,
    });
  }

  return y + 24;
}

function drawRow(
  doc: PDFKit.PDFDocument,
  row: ExportRow,
  index: number,
  y: number,
  left: number,
  width: number,
): void {
  doc
    .save()
    .moveTo(left, y + ROW_HEIGHT - 4)
    .lineTo(left + width, y + ROW_HEIGHT - 4)
    .lineWidth(0.5)
    .stroke(RULE)
    .restore();

  const top = y + 4;

  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(GREY)
    .text(String(index), left + COLUMNS.index.x + 2, top, {
      width: COLUMNS.index.width - 4,
      lineBreak: false,
    });

  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor('#111827')
    .text(row.name, left + COLUMNS.name.x, top, {
      width: COLUMNS.name.width - 6,
      height: 22,
      ellipsis: true,
    });

  if (row.isWalkIn) {
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor('#8d6400')
      .text('Walk-in', left + COLUMNS.name.x, top + 20, {
        width: COLUMNS.name.width - 6,
        lineBreak: false,
      });
  }

  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor('#374151')
    .text(
      [row.jobTitle, row.organisation].filter(Boolean).join('\n') || '—',
      left + COLUMNS.role.x,
      top,
      { width: COLUMNS.role.width - 6, height: 30, ellipsis: true },
    );

  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor('#374151')
    .text(
      [row.email, row.phone].filter(Boolean).join('\n') || '—',
      left + COLUMNS.contact.x,
      top,
      { width: COLUMNS.contact.width - 6, height: 30, ellipsis: true },
    );

  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(row.attended ? '#374151' : GREY)
    .text(
      row.attended ? formatTime(row.checkInAt) : 'Absent',
      left + COLUMNS.time.x,
      top,
      { width: COLUMNS.time.width - 6, lineBreak: false },
    );

  drawSignature(doc, row, left + COLUMNS.signature.x, top);
}

function drawSignature(
  doc: PDFKit.PDFDocument,
  row: ExportRow,
  x: number,
  y: number,
): void {
  const png =
    row.signature === 'SIGNED' ? decodeSignature(row.signatureData) : null;

  if (png) {
    try {
      doc.image(png, x, y, { fit: [SIGNATURE_WIDTH, SIGNATURE_HEIGHT] });
      return;
    } catch {
      // One unreadable signature must not abort the document; fall through to
      // the note, which is the honest thing to print anyway.
    }
  }

  const note = !row.attended
    ? '—'
    : row.signature === 'ERASED'
      ? 'Signature erased'
      : // Signed, but the stored image will not decode. Saying "recorded by
        // organiser" here would claim something about the record that is not
        // true.
        row.signature === 'SIGNED'
        ? 'Signature unavailable'
        : 'Recorded by organiser';

  doc
    .font('Helvetica-Oblique')
    .fontSize(7.5)
    .fillColor(GREY)
    .text(note, x, y + 10, { width: SIGNATURE_WIDTH, lineBreak: false });
}

function drawTotals(
  doc: PDFKit.PDFDocument,
  rows: ExportRow[],
  set: ExportSet,
  y: number,
  left: number,
  width: number,
): void {
  if (y > doc.page.height - MARGIN - 90) {
    doc.addPage();
    y = MARGIN;
  }

  const attended = rows.filter((r) => r.attended);
  const methods = attended.reduce<Record<string, number>>((counts, row) => {
    const key = row.method ?? 'UNKNOWN';
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

  const lines = [
    `On this list: ${rows.length}`,
    `Attended: ${attended.length}`,
    `Walk-ins: ${rows.filter((r) => r.isWalkIn).length}`,
    `Signed: ${rows.filter((r) => r.signature === 'SIGNED').length}`,
    `Location verified: ${attended.filter((r) => r.withinGeofence === true).length}`,
  ];

  if (set !== 'checked-in') {
    lines.splice(2, 0, `Did not attend: ${rows.length - attended.length}`);
  }

  const methodLine = Object.entries(methods)
    .map(([method, count]) => `${method} ${count}`)
    .join(', ');

  doc.save().rect(left, y, width, 1).fill(RULE).restore();

  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(NAVY)
    .text('Summary', left, y + 10);

  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor('#374151')
    .text(lines.join('   ·   '), left, doc.y + 3, { width });

  if (methodLine) {
    doc
      .fillColor(GREY)
      .text(`Check-in method: ${methodLine}`, left, doc.y + 2, { width });
  }
}

function drawPageNumbers(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();

  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);

    // The footer sits inside the bottom margin, and pdfkit answers text that
    // crosses that margin by starting another page — which is how a four-page
    // register grew four blank pages, each stamped "Page 1 of 4".
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(GREY)
      .text(
        `Page ${i + 1} of ${range.count}`,
        MARGIN,
        doc.page.height - MARGIN + 4,
        {
          width: doc.page.width - MARGIN * 2,
          align: 'right',
          lineBreak: false,
        },
      );

    doc.page.margins.bottom = bottomMargin;
  }
}
