import {
  escapeHtml,
  inviteEmail,
  actionItemReminderEmail,
  meetingInvitationEmail,
  meetingReminderEmail,
} from '../templates';

const LINK = 'http://localhost:3000/set-password?token=abc123';

/**
 * Dates render in the reader's zone, not the server's.
 *
 * These pass trivially on a UTC box, which is exactly why they are worth
 * having: the old formatters passed no timeZone at all and were correct only
 * because Sierra Leone and the deployment happen to share an offset. Run the
 * suite under TZ=America/New_York and the old code fails every one of these —
 * a 09:00 meeting reads 04:00, and a due date stored at midnight UTC reads as
 * the day before.
 */
describe('rendering dates in the reader’s timezone', () => {
  // 09:00 in Freetown, whatever the machine running this thinks.
  const NINE_AM_UTC = new Date('2026-09-02T09:00:00Z');
  // Action item due dates are written as date-only, so they land here.
  const MIDNIGHT_UTC = new Date('2026-09-02T00:00:00.000Z');

  it('shows a meeting at the hour it starts in Freetown', () => {
    const body = meetingReminderEmail({
      name: 'Aminata',
      eventTitle: 'Cabinet Meeting',
      startAt: NINE_AM_UTC,
    });
    expect(body.text).toContain('09:00');
    expect(body.text).toContain('2 September 2026');
  });

  it('keeps a midnight due date on its own day', () => {
    const body = actionItemReminderEmail({
      name: 'Aminata',
      title: 'Circulate the figures',
      dueDate: MIDNIGHT_UTC,
    });
    // West of Greenwich an unzoned render would say 1 September.
    expect(body.text).toContain('2 September 2026');
    expect(body.text).not.toContain('1 September 2026');
  });

  it('renders both ends of a meeting in the same zone', () => {
    const body = meetingInvitationEmail({
      name: 'Aminata',
      eventTitle: 'Cabinet Meeting',
      startAt: NINE_AM_UTC,
      endAt: new Date('2026-09-02T11:30:00Z'),
    });
    expect(body.text).toContain('09:00');
    expect(body.text).toContain('11:30');
  });
});

describe('escapeHtml', () => {
  it('neutralises the characters that could inject markup', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
  });

  it('escapes ampersands before anything else, so entities are not doubled oddly', () => {
    expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });
});

describe('inviteEmail', () => {
  const body = inviteEmail({
    name: 'Hawa Kallon',
    link: LINK,
    expiresInDays: 7,
  });

  it('has a subject', () => {
    expect(body.subject.length).toBeGreaterThan(0);
  });

  it('carries the link in both the HTML and the text alternative', () => {
    expect(body.html).toContain(LINK);
    expect(body.text).toContain(LINK);
  });

  it('states the expiry in both forms', () => {
    expect(body.html).toContain('7 days');
    expect(body.text).toContain('7 days');
  });

  it('produces a plain-text part that carries no markup', () => {
    expect(body.text).not.toContain('<');
  });

  it('escapes a hostile name rather than embedding it as markup', () => {
    const hostile = inviteEmail({
      name: '<script>steal()</script>',
      link: LINK,
      expiresInDays: 7,
    });
    expect(hostile.html).not.toContain('<script>steal()');
    expect(hostile.html).toContain('&lt;script&gt;steal()');
  });
});

describe('actionItemReminderEmail', () => {
  const body = actionItemReminderEmail({
    name: 'Hawa Kallon',
    title: 'Circulate the budget paper',
    dueDate: new Date('2026-08-01T09:00:00Z'),
    eventTitle: 'Finance Committee',
  });

  it('names the item in the subject', () => {
    expect(body.subject).toContain('Circulate the budget paper');
  });

  it('mentions the source meeting', () => {
    expect(body.html).toContain('Finance Committee');
    expect(body.text).toContain('Finance Committee');
  });

  it('copes with no due date and no event', () => {
    const sparse = actionItemReminderEmail({
      name: 'Hawa Kallon',
      title: 'Follow up',
      dueDate: null,
      eventTitle: null,
    });
    expect(sparse.subject).toContain('Follow up');
    expect(sparse.html).toContain('soon');
  });

  it('escapes a hostile title', () => {
    const hostile = actionItemReminderEmail({
      name: 'A',
      title: '<img src=x onerror=alert(1)>',
      dueDate: null,
      eventTitle: null,
    });
    expect(hostile.html).not.toContain('<img src=x');
  });
});

describe('meetingReminderEmail', () => {
  const body = meetingReminderEmail({
    name: 'Hawa Kallon',
    eventTitle: 'Cabinet Briefing',
    startAt: new Date('2026-08-01T09:00:00Z'),
    venueName: 'Committee Room 2',
  });

  it('names the meeting in the subject', () => {
    expect(body.subject).toContain('Cabinet Briefing');
  });

  it('includes the venue when there is one', () => {
    expect(body.html).toContain('Committee Room 2');
    expect(body.text).toContain('Committee Room 2');
  });

  it('omits the venue line entirely when there is none', () => {
    const noVenue = meetingReminderEmail({
      name: 'Hawa Kallon',
      eventTitle: 'Cabinet Briefing',
      startAt: new Date('2026-08-01T09:00:00Z'),
      venueName: null,
    });
    expect(noVenue.text).not.toContain('Where:');
  });

  it('accepts an ISO string as well as a Date', () => {
    const fromString = meetingReminderEmail({
      name: 'Hawa Kallon',
      eventTitle: 'Cabinet Briefing',
      startAt: '2026-08-01T09:00:00Z',
      venueName: null,
    });
    expect(fromString.text).toContain('2026');
  });
});
