import {
  escapeHtml,
  inviteEmail,
  actionItemReminderEmail,
  meetingReminderEmail,
} from '../templates';

const LINK = 'http://localhost:3000/set-password?token=abc123';

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
