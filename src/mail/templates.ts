/**
 * Email bodies.
 *
 * Pure functions with no Nest and no network, so they can be unit-tested
 * directly. Every builder returns both an HTML and a plain-text form — some
 * government mail clients strip HTML entirely, and a text alternative also
 * keeps the message out of spam folders.
 *
 * The HTML is deliberately table-based with inline styles: mail clients drop
 * <style> blocks and do not implement flexbox or grid.
 */

export interface EmailBody {
  subject: string;
  html: string;
  text: string;
}

const NAVY = '#003580';
const GREEN = '#007236';

/**
 * Anything interpolated into the HTML goes through here. Names and event
 * titles are user-supplied, and an unescaped one would inject markup straight
 * into someone's inbox.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout({
  heading,
  intro,
  bodyHtml,
  actionLabel,
  actionUrl,
  footnote,
  footnoteHtml,
}: {
  heading: string;
  intro: string;
  bodyHtml?: string;
  actionLabel?: string;
  actionUrl?: string;
  /** Escaped. Use this unless the footnote genuinely needs a link. */
  footnote?: string;
  /**
   * Not escaped, so it can carry an anchor. Only ever built in this file from
   * values that have been through escapeHtml — never passed straight from a
   * caller.
   */
  footnoteHtml?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background-color:#f6faff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f6faff;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;">
          <tr>
            <td style="background:linear-gradient(135deg,${NAVY} 0%,${GREEN} 100%);background-color:${NAVY};padding:28px 32px;">
              <p style="margin:0;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;opacity:0.75;">Smart Meeting</p>
              <h1 style="margin:6px 0 0;color:#ffffff;font-size:22px;font-weight:700;">${escapeHtml(heading)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;color:#334155;font-size:15px;line-height:1.6;">${escapeHtml(intro)}</p>
              ${bodyHtml ?? ''}
              ${
                actionUrl && actionLabel
                  ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
                <tr><td style="border-radius:12px;background-color:${NAVY};">
                  <a href="${actionUrl}" style="display:inline-block;padding:13px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:12px;">${escapeHtml(actionLabel)}</a>
                </td></tr>
              </table>
              <p style="margin:0 0 8px;color:#64748b;font-size:13px;line-height:1.6;">If the button does not work, copy this address into your browser:</p>
              <p style="margin:0;color:${NAVY};font-size:13px;word-break:break-all;">${actionUrl}</p>`
                  : ''
              }
              ${
                footnoteHtml
                  ? `<p style="margin:24px 0 0;color:#64748b;font-size:13px;line-height:1.6;">${footnoteHtml}</p>`
                  : footnote
                    ? `<p style="margin:24px 0 0;color:#64748b;font-size:13px;line-height:1.6;">${escapeHtml(footnote)}</p>`
                    : ''
              }
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px;background-color:#f8fafc;border-top:1px solid #e2e8f0;">
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.5;">This is an automated message from the Smart Meeting platform. Please do not reply to it.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * The zone these dates are read in.
 *
 * Pinned rather than left to the process. Without it, `toLocaleDateString`
 * renders in whatever zone the server happens to run in, which was right only
 * by coincidence: Sierra Leone is UTC+0 and so is the box. Move the server, or
 * mail somebody abroad, and a 09:00 meeting silently becomes 04:00 in the
 * invitation — worse, a due date stored as midnight UTC renders as the
 * *previous day* anywhere west of Greenwich.
 *
 * Named as the audience's zone rather than 'UTC' because that is the actual
 * intent: these emails are read in Freetown. Africa/Freetown observes no DST,
 * so it is a stable offset, and the override exists for a deployment that
 * serves somewhere else.
 */
const DISPLAY_TIMEZONE = process.env.DISPLAY_TIMEZONE || 'Africa/Freetown';

/** Only the date part, in the reader's zone. */
function formatDate(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: DISPLAY_TIMEZONE,
  });
}

/** Clock time alone, for the second half of a range. */
function formatTime(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DISPLAY_TIMEZONE,
  });
}

function formatDateTime(value: Date | string): string {
  return `${formatDate(value)} at ${formatTime(value)}`;
}

export function inviteEmail({
  name,
  link,
  expiresInDays,
}: {
  name: string;
  link: string;
  expiresInDays: number;
}): EmailBody {
  const intro = `${name}, an account has been created for you on Smart Meeting, the government meeting and attendance platform.`;
  const footnote = `This link can only be used once and expires in ${expiresInDays} days. If it has expired, ask the administrator who created your account to send a new one. If you were not expecting this email, you can ignore it.`;

  return {
    subject: 'Set up your Smart Meeting account',
    html: layout({
      heading: 'Set up your account',
      intro,
      actionLabel: 'Set your password',
      actionUrl: link,
      footnote,
    }),
    text: [
      intro,
      '',
      'Set your password using the link below:',
      link,
      '',
      footnote,
    ].join('\n'),
  };
}

export function passwordResetEmail({
  name,
  link,
  expiresInMinutes,
}: {
  name: string;
  link: string;
  expiresInMinutes: number;
}): EmailBody {
  const intro = `${name}, we received a request to reset the password on your Smart Meeting account.`;
  const footnote = `This link expires in ${expiresInMinutes} minutes and can only be used once. If you did not ask to reset your password you can ignore this email — your current password still works and nothing has changed.`;

  return {
    subject: 'Reset your Smart Meeting password',
    html: layout({
      heading: 'Reset your password',
      intro,
      actionLabel: 'Choose a new password',
      actionUrl: link,
      footnote,
    }),
    text: [
      intro,
      '',
      'Choose a new password using the link below:',
      link,
      '',
      footnote,
    ].join('\n'),
  };
}

export function actionItemAssignedEmail({
  name,
  title,
  description,
  dueDate,
  eventTitle,
  assignedByName,
}: {
  name: string;
  title: string;
  description?: string | null;
  dueDate: Date | string | null;
  eventTitle?: string | null;
  assignedByName?: string | null;
}): EmailBody {
  const due = dueDate ? formatDate(dueDate) : 'no due date';
  const intro = assignedByName
    ? `${name}, ${assignedByName} has assigned you an action item.`
    : `${name}, an action item has been assigned to you.`;

  const rows = [
    `<p style="margin:0 0 6px;color:#0f172a;font-size:15px;font-weight:600;">${escapeHtml(title)}</p>`,
    description
      ? `<p style="margin:0 0 8px;color:#334155;font-size:14px;">${escapeHtml(description)}</p>`
      : '',
    eventTitle
      ? `<p style="margin:0;color:#64748b;font-size:13px;">From: ${escapeHtml(eventTitle)}</p>`
      : '',
    `<p style="margin:8px 0 0;color:#64748b;font-size:13px;">Due: ${escapeHtml(due)}</p>`,
  ].join('');

  return {
    subject: `Action item assigned to you: ${title}`,
    html: layout({
      heading: 'Action item assigned',
      intro,
      bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;background-color:#edf3fd;border:1px solid #cfdff8;border-radius:12px;">
        <tr><td style="padding:16px 18px;">${rows}</td></tr>
      </table>`,
      footnote:
        'If you do not have an account on the platform, the meeting organizer will record your progress for you.',
    }),
    text: [
      intro,
      '',
      title,
      description ?? '',
      eventTitle ? `From: ${eventTitle}` : '',
      `Due: ${due}`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/**
 * One Monday summary listing everything a person still owes, rather than a
 * message per item — someone carrying eight items should not get eight emails.
 */
export interface DigestItem {
  title: string;
  dueDate: Date | string;
  eventTitle?: string | null;
  /** Past its deadline. Flagged in place rather than mailed separately. */
  overdue?: boolean;
  /** Someone else owns it; the reader is helping. */
  assisting?: boolean;
}

/**
 * The Monday email: what you owe, and what got done around you.
 *
 * Both halves in one message on purpose. Mailing every attendee each time a
 * task closed would be forty emails per meeting and would teach people to
 * filter this domain; a weekly summary carries the same information at a
 * fraction of the cost of reading it.
 */
export function actionItemDigestEmail({
  name,
  items,
  closed = [],
  unsubscribeUrl,
}: {
  name: string;
  items: DigestItem[];
  /** Completed last week on meetings this person was invited to. */
  closed?: { title: string; ownerName?: string | null; eventTitle?: string | null }[];
  unsubscribeUrl?: string;
}): EmailBody {
  const count = items.length;
  const intro =
    count === 0
      ? `${name}, nothing is open against your name this week.`
      : count === 1
        ? `${name}, you have 1 action item still open.`
        : `${name}, you have ${count} action items still open.`;

  const rows = items
    .map(
      (i) => `<tr><td style="padding:10px 18px;border-top:1px solid #e6eef8;">
        <p style="margin:0 0 4px;color:#0f172a;font-size:14px;font-weight:600;">${escapeHtml(i.title)}${
          i.assisting
            ? ' <span style="color:#64748b;font-weight:400;font-size:13px;">(assisting)</span>'
            : ''
        }</p>
        <p style="margin:0;color:${i.overdue ? '#c2410c' : '#64748b'};font-size:13px;">${
          i.overdue ? 'Overdue &middot; was due' : 'Due'
        } ${escapeHtml(formatDate(i.dueDate))}${
          i.eventTitle ? ` &middot; ${escapeHtml(i.eventTitle)}` : ''
        }</p>
      </td></tr>`,
    )
    .join('');

  const closedHtml = closed.length
    ? `<p style="margin:20px 0 8px;color:#0f172a;font-size:14px;font-weight:600;">Closed last week (${closed.length})</p>
       <ul style="margin:0;padding-left:20px;color:#334155;font-size:14px;line-height:22px;">${closed
         .map(
           (c) =>
             `<li>${escapeHtml(c.title)}${c.ownerName ? ` &mdash; ${escapeHtml(c.ownerName)}` : ''}${
               c.eventTitle ? ` <span style="color:#64748b;">(${escapeHtml(c.eventTitle)})</span>` : ''
             }</li>`,
         )
         .join('')}</ul>`
    : '';

  return {
    subject:
      count === 1
        ? 'You have 1 open action item'
        : `You have ${count} open action items`,
    html: layout({
      heading: 'Your week',
      intro,
      bodyHtml: `${
        count
          ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;background-color:#ffffff;border:1px solid #e6eef8;border-radius:12px;">${rows}</table>`
          : ''
      }${closedHtml}`,
      ...(unsubscribeUrl
        ? {
            footnoteHtml: `This summary goes out every Monday. <a href="${escapeHtml(
              unsubscribeUrl,
            )}" style="color:#64748b;">Unsubscribe from it</a> &mdash; reminders about your own deadlines and meetings will still reach you.`,
          }
        : {
            footnote:
              'This summary goes out every Monday while items remain open.',
          }),
    }),
    text: [
      intro,
      '',
      ...items.map(
        (i) =>
          `- ${i.title}${i.assisting ? ' (assisting)' : ''} (${
            i.overdue ? 'OVERDUE, was due' : 'due'
          } ${formatDate(i.dueDate)}${i.eventTitle ? `, ${i.eventTitle}` : ''})`,
      ),
      ...(closed.length
        ? [
            '',
            `Closed last week (${closed.length}):`,
            ...closed.map(
              (c) => `- ${c.title}${c.ownerName ? ` — ${c.ownerName}` : ''}`,
            ),
          ]
        : []),
      ...(unsubscribeUrl ? ['', `Unsubscribe from this summary: ${unsubscribeUrl}`] : []),
    ].join('\n'),
  };
}

/**
 * A task is done.
 *
 * Goes to the people with a stake in it — the owner, whoever raised it, anyone
 * helping, and the organizer of the meeting it came from. Everyone else who
 * attended sees it in the Monday summary instead: forty emails because one
 * task closed is how a platform teaches people to filter its mail.
 */
export function actionItemCompletedEmail({
  name,
  title,
  completedByName,
  eventTitle,
}: {
  name: string;
  title: string;
  completedByName?: string | null;
  eventTitle?: string | null;
}): EmailBody {
  const who = completedByName ? `${completedByName} has` : 'Someone has';
  const intro = `${name}, ${who} completed an action item you are involved in.`;

  return {
    subject: `Completed: ${title}`,
    html: layout({
      heading: 'Action item completed',
      intro,
      bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;background-color:#edf8f1;border:1px solid #cfe5d7;border-radius:12px;">
        <tr><td style="padding:16px 18px;">
          <p style="margin:0 0 6px;color:#0f172a;font-size:15px;font-weight:600;">${escapeHtml(title)}</p>
          ${
            eventTitle
              ? `<p style="margin:0;color:#64748b;font-size:13px;">From: ${escapeHtml(eventTitle)}</p>`
              : ''
          }
        </td></tr>
      </table>`,
      footnote: 'Nothing further is needed from you.',
    }),
    text: [
      intro,
      '',
      `- ${title}${eventTitle ? ` (${eventTitle})` : ''}`,
    ].join('\n'),
  };
}

/**
 * A deadline has passed. Sent once, not every morning — the item stays flagged
 * in the Monday summary for as long as it is open, which is nagging enough.
 */
export function actionItemOverdueEmail({
  name,
  title,
  dueDate,
  eventTitle,
  ownerName,
  isOwner,
}: {
  name: string;
  title: string;
  dueDate: Date | string;
  eventTitle?: string | null;
  ownerName?: string | null;
  /** The raiser gets told whose it is; the owner already knows. */
  isOwner: boolean;
}): EmailBody {
  const intro = isOwner
    ? `${name}, an action item assigned to you has passed its deadline.`
    : `${name}, an action item you raised has passed its deadline.`;

  return {
    subject: `Overdue: ${title}`,
    html: layout({
      heading: 'Action item overdue',
      intro,
      bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;background-color:#fdebec;border:1px solid #f6cfd2;border-radius:12px;">
        <tr><td style="padding:16px 18px;">
          <p style="margin:0 0 6px;color:#0f172a;font-size:15px;font-weight:600;">${escapeHtml(title)}</p>
          <p style="margin:0;color:#c2410c;font-size:13px;">Was due ${escapeHtml(formatDate(dueDate))}</p>
          ${
            !isOwner && ownerName
              ? `<p style="margin:6px 0 0;color:#64748b;font-size:13px;">Assigned to ${escapeHtml(ownerName)}</p>`
              : ''
          }
          ${
            eventTitle
              ? `<p style="margin:6px 0 0;color:#64748b;font-size:13px;">From: ${escapeHtml(eventTitle)}</p>`
              : ''
          }
        </td></tr>
      </table>`,
      footnote:
        'If the deadline has moved, updating it on the platform will stop this and restart the reminders.',
    }),
    text: [
      intro,
      '',
      `- ${title} (was due ${formatDate(dueDate)}${eventTitle ? `, ${eventTitle}` : ''})`,
    ].join('\n'),
  };
}

/** Told to the person it was taken from; the new owner gets the assignment mail. */
export function actionItemUnassignedEmail({
  name,
  title,
  newOwnerName,
  eventTitle,
}: {
  name: string;
  title: string;
  newOwnerName?: string | null;
  eventTitle?: string | null;
}): EmailBody {
  const intro = newOwnerName
    ? `${name}, an action item assigned to you has been passed to ${newOwnerName}.`
    : `${name}, an action item assigned to you has been unassigned.`;

  return {
    subject: `No longer yours: ${title}`,
    html: layout({
      heading: 'Action item reassigned',
      intro,
      bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
        <tr><td style="padding:16px 18px;">
          <p style="margin:0 0 6px;color:#0f172a;font-size:15px;font-weight:600;">${escapeHtml(title)}</p>
          ${
            eventTitle
              ? `<p style="margin:0;color:#64748b;font-size:13px;">From: ${escapeHtml(eventTitle)}</p>`
              : ''
          }
        </td></tr>
      </table>`,
      footnote: 'Nothing further is needed from you.',
    }),
    text: [intro, '', `- ${title}${eventTitle ? ` (${eventTitle})` : ''}`].join(
      '\n',
    ),
  };
}

/**
 * A meeting was called off or moved.
 *
 * The one email on this platform whose absence had a physical cost: a
 * cancelled meeting notified nobody at all, so people travelled to it.
 */
export function meetingChangedEmail({
  name,
  eventTitle,
  cancelled,
  startAt,
  previousStartAt,
  venueName,
  previousVenueName,
}: {
  name: string;
  eventTitle: string;
  cancelled: boolean;
  startAt: Date | string;
  previousStartAt?: Date | string | null;
  venueName?: string | null;
  previousVenueName?: string | null;
}): EmailBody {
  const intro = cancelled
    ? `${name}, a meeting you were invited to has been cancelled.`
    : `${name}, the details of a meeting you were invited to have changed.`;

  // Old beside new, because "the venue has changed" without saying from what
  // makes someone check whether they had it wrong all along.
  const changes = cancelled
    ? ''
    : [
        previousStartAt
          ? `<p style="margin:0 0 6px;color:#334155;font-size:14px;">When: <s style="color:#94a3b8;">${escapeHtml(
              formatDateTime(previousStartAt),
            )}</s> &rarr; <strong>${escapeHtml(formatDateTime(startAt))}</strong></p>`
          : `<p style="margin:0 0 6px;color:#334155;font-size:14px;">When: <strong>${escapeHtml(formatDateTime(startAt))}</strong></p>`,
        previousVenueName && previousVenueName !== venueName
          ? `<p style="margin:0;color:#334155;font-size:14px;">Where: <s style="color:#94a3b8;">${escapeHtml(
              previousVenueName,
            )}</s> &rarr; <strong>${escapeHtml(venueName ?? 'To be confirmed')}</strong></p>`
          : venueName
            ? `<p style="margin:0;color:#334155;font-size:14px;">Where: ${escapeHtml(venueName)}</p>`
            : '',
      ].join('');

  return {
    subject: cancelled
      ? `Cancelled: ${eventTitle}`
      : `Changed: ${eventTitle}`,
    html: layout({
      heading: cancelled ? 'Meeting cancelled' : 'Meeting details changed',
      intro,
      bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;background-color:${
        cancelled ? '#fdebec' : '#fff8e5'
      };border:1px solid ${cancelled ? '#f6cfd2' : '#fde8a6'};border-radius:12px;">
        <tr><td style="padding:16px 18px;">
          <p style="margin:0 0 8px;color:#0f172a;font-size:15px;font-weight:600;">${escapeHtml(eventTitle)}</p>
          ${changes}
        </td></tr>
      </table>`,
      footnote: cancelled
        ? 'Nothing further is needed from you. The meeting has been removed from the calendar.'
        : 'Your response to the invitation still stands; only the details have changed.',
    }),
    text: [
      intro,
      '',
      eventTitle,
      ...(cancelled
        ? []
        : [
            previousStartAt
              ? `When: ${formatDateTime(previousStartAt)} -> ${formatDateTime(startAt)}`
              : `When: ${formatDateTime(startAt)}`,
            venueName ? `Where: ${venueName}` : '',
          ].filter(Boolean)),
    ].join('\n'),
  };
}

export function actionItemReminderEmail({
  name,
  title,
  dueDate,
  eventTitle,
}: {
  name: string;
  title: string;
  dueDate: Date | string | null;
  eventTitle?: string | null;
}): EmailBody {
  const due = dueDate ? formatDate(dueDate) : 'soon';
  const intro = `${name}, an action item assigned to you is due ${due}.`;
  const rows = [
    `<p style="margin:0 0 6px;color:#0f172a;font-size:15px;font-weight:600;">${escapeHtml(title)}</p>`,
    eventTitle
      ? `<p style="margin:0;color:#64748b;font-size:13px;">From: ${escapeHtml(eventTitle)}</p>`
      : '',
    `<p style="margin:8px 0 0;color:#64748b;font-size:13px;">Due: ${escapeHtml(due)}</p>`,
  ].join('');

  return {
    subject: `Action item due ${due}: ${title}`,
    html: layout({
      heading: 'Action item due soon',
      intro,
      bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;background-color:#fff8e5;border:1px solid #fde8a6;border-radius:12px;">
        <tr><td style="padding:16px 18px;">${rows}</td></tr>
      </table>`,
      footnote:
        'Update the status on the Action Items board once the work is done.',
    }),
    text: [
      intro,
      '',
      title,
      eventTitle ? `From: ${eventTitle}` : '',
      `Due: ${due}`,
      '',
      'Update the status on the Action Items board once the work is done.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/**
 * The published record, in full.
 *
 * The whole minutes now fit in an email — decisions, then who is doing what,
 * then what happens next. That is worth doing rather than teasing: this
 * message used to carry a summary paragraph and a table, and for most
 * recipients the email is as far as they ever get.
 *
 * Carries a link for a guest and a different one for staff: a guest has no
 * session, so the in-app URL would be a dead end for them.
 */
export function minutesPublishedEmail({
  name,
  eventTitle,
  eventDate,
  decisions,
  nextSteps,
  actionItems,
  link,
  isGuest,
}: {
  name: string;
  eventTitle: string;
  eventDate: Date | string;
  decisions?: string[];
  nextSteps?: string[];
  actionItems: {
    title: string;
    ownerName?: string | null;
    dueDate: Date | string;
  }[];
  link: string;
  isGuest: boolean;
}): EmailBody {
  const when = formatDate(eventDate);
  const intro = `${name}, the minutes for "${eventTitle}" (${when}) have been published.`;

  const itemRows = actionItems
    .map(
      (i) => `<tr><td style="padding:10px 18px;border-top:1px solid #e6eef8;">
        <p style="margin:0 0 4px;color:#0f172a;font-size:14px;font-weight:600;">${escapeHtml(i.title)}</p>
        <p style="margin:0;color:#64748b;font-size:13px;">${
          i.ownerName ? `${escapeHtml(i.ownerName)} &middot; ` : ''
        }due ${escapeHtml(formatDate(i.dueDate))}</p>
      </td></tr>`,
    )
    .join('');

  /** A headed list, or nothing at all — an empty heading says less than none. */
  const listHtml = (heading: string, lines: string[]) =>
    lines.length
      ? `<p style="margin:16px 0 8px;color:#0f172a;font-size:14px;font-weight:600;">${heading} (${lines.length})</p>
         <ul style="margin:0;padding-left:20px;color:#334155;font-size:14px;line-height:22px;">${lines
           .map((line) => `<li>${escapeHtml(line)}</li>`)
           .join('')}</ul>`
      : '';

  const decisionList = decisions ?? [];
  const nextStepList = nextSteps ?? [];

  const bodyHtml = [
    listHtml('Decisions', decisionList),
    actionItems.length
      ? `<p style="margin:16px 0 8px;color:#0f172a;font-size:14px;font-weight:600;">Action items (${actionItems.length})</p>
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border:1px solid #e6eef8;border-radius:12px;">${itemRows}</table>`
      : `<p style="margin:16px 0 0;color:#64748b;font-size:14px;">No action items were raised.</p>`,
    listHtml('Next steps', nextStepList),
  ].join('');

  return {
    subject: `Minutes published: ${eventTitle}`,
    html: layout({
      heading: 'Minutes published',
      intro,
      bodyHtml,
      actionLabel: 'Read the minutes',
      actionUrl: link,
      footnote: isGuest
        ? 'This link is personal to you and stops working once the record is archived.'
        : 'You can also find this under Minutes on the platform.',
    }),
    text: [
      intro,
      '',
      ...(decisionList.length
        ? [`Decisions (${decisionList.length}):`, ...decisionList.map((d) => `- ${d}`), '']
        : []),
      actionItems.length
        ? `Action items (${actionItems.length}):`
        : 'No action items were raised.',
      ...actionItems.map(
        (i) =>
          `- ${i.title}${i.ownerName ? ` (${i.ownerName})` : ''}, due ${formatDate(i.dueDate)}`,
      ),
      ...(nextStepList.length
        ? ['', `Next steps (${nextStepList.length}):`, ...nextStepList.map((s) => `- ${s}`)]
        : []),
      '',
      link,
    ]
      .filter((line) => line !== undefined)
      .join('\n'),
  };
}

/**
 * The invitation sent when someone is added to an event.
 *
 * The RSVP link is the point of the message, so it is the action button rather
 * than a footnote. It carries the per-attendee token, which is why this is one
 * email per recipient and never a shared body.
 *
 * `rsvpUrl` is optional because an attendee row can exist without a token —
 * a legacy row, or one created before the column was populated. Those still
 * get told about the meeting; they just have nothing to click.
 */
export function meetingInvitationEmail({
  name,
  eventTitle,
  startAt,
  endAt,
  venueName,
  ministryName,
  organizerName,
  rsvpUrl,
}: {
  name: string;
  eventTitle: string;
  startAt: Date | string;
  endAt?: Date | string | null;
  venueName?: string | null;
  ministryName?: string | null;
  organizerName?: string | null;
  rsvpUrl?: string | null;
}): EmailBody {
  const when = formatDateTime(startAt);
  // The end time is rendered here rather than through formatDateTime, which
  // would repeat the date. Same zone, for the same reason.
  const until = endAt ? formatTime(endAt) : null;
  const whenLine = until ? `${when} – ${until}` : when;

  const intro = organizerName
    ? `${name}, ${organizerName} has invited you to ${eventTitle}.`
    : `${name}, you have been invited to ${eventTitle}.`;

  const rows = [
    `<p style="margin:0 0 6px;color:#0f172a;font-size:15px;font-weight:600;">${escapeHtml(eventTitle)}</p>`,
    `<p style="margin:0;color:#64748b;font-size:13px;">When: ${escapeHtml(whenLine)}</p>`,
    venueName
      ? `<p style="margin:6px 0 0;color:#64748b;font-size:13px;">Where: ${escapeHtml(venueName)}</p>`
      : '',
    ministryName
      ? `<p style="margin:6px 0 0;color:#64748b;font-size:13px;">Hosted by: ${escapeHtml(ministryName)}</p>`
      : '',
  ].join('');

  return {
    subject: `Invitation: ${eventTitle}`,
    html: layout({
      heading: 'You have been invited to a meeting',
      intro,
      bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;background-color:#edf3fd;border:1px solid #c9d9f2;border-radius:12px;">
        <tr><td style="padding:16px 18px;">${rows}</td></tr>
      </table>`,
      actionLabel: rsvpUrl ? 'Respond to this invitation' : undefined,
      actionUrl: rsvpUrl ?? undefined,
      footnote: rsvpUrl
        ? 'Letting the organizer know whether you are coming helps them plan the room and the agenda.'
        : 'Contact the organizing ministry if you need to confirm your attendance.',
    }),
    text: [
      intro,
      '',
      eventTitle,
      `When: ${whenLine}`,
      venueName ? `Where: ${venueName}` : '',
      ministryName ? `Hosted by: ${ministryName}` : '',
      '',
      rsvpUrl ? `Respond to this invitation: ${rsvpUrl}` : '',
      rsvpUrl
        ? 'Letting the organizer know whether you are coming helps them plan the room and the agenda.'
        : 'Contact the organizing ministry if you need to confirm your attendance.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export function meetingReminderEmail({
  name,
  eventTitle,
  startAt,
  venueName,
}: {
  name: string;
  eventTitle: string;
  startAt: Date | string;
  venueName?: string | null;
}): EmailBody {
  const when = formatDateTime(startAt);
  const intro = `${name}, this is a reminder that ${eventTitle} starts shortly.`;
  const rows = [
    `<p style="margin:0 0 6px;color:#0f172a;font-size:15px;font-weight:600;">${escapeHtml(eventTitle)}</p>`,
    `<p style="margin:0;color:#64748b;font-size:13px;">When: ${escapeHtml(when)}</p>`,
    venueName
      ? `<p style="margin:6px 0 0;color:#64748b;font-size:13px;">Where: ${escapeHtml(venueName)}</p>`
      : '',
  ].join('');

  return {
    subject: `Reminder: ${eventTitle} starts soon`,
    html: layout({
      heading: 'Your meeting starts soon',
      intro,
      bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;background-color:#edf3fd;border:1px solid #c9d9f2;border-radius:12px;">
        <tr><td style="padding:16px 18px;">${rows}</td></tr>
      </table>`,
      footnote:
        'Check in at the venue by scanning the QR code the organizer displays.',
    }),
    text: [
      intro,
      '',
      eventTitle,
      `When: ${when}`,
      venueName ? `Where: ${venueName}` : '',
      '',
      'Check in at the venue by scanning the QR code the organizer displays.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}
