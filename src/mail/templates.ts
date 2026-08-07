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
}: {
  heading: string;
  intro: string;
  bodyHtml?: string;
  actionLabel?: string;
  actionUrl?: string;
  footnote?: string;
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
                footnote
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

/** Only the date part; these emails never need a time zone argument. */
function formatDate(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatDateTime(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return `${formatDate(d)} at ${d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
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
export function actionItemDigestEmail({
  name,
  items,
}: {
  name: string;
  items: { title: string; dueDate: Date | string; eventTitle?: string | null }[];
}): EmailBody {
  const count = items.length;
  const intro =
    count === 1
      ? `${name}, you have 1 action item still open.`
      : `${name}, you have ${count} action items still open.`;

  const rows = items
    .map(
      (i) => `<tr><td style="padding:10px 18px;border-top:1px solid #e6eef8;">
        <p style="margin:0 0 4px;color:#0f172a;font-size:14px;font-weight:600;">${escapeHtml(i.title)}</p>
        <p style="margin:0;color:#64748b;font-size:13px;">Due ${escapeHtml(formatDate(i.dueDate))}${
          i.eventTitle ? ` &middot; ${escapeHtml(i.eventTitle)}` : ''
        }</p>
      </td></tr>`,
    )
    .join('');

  return {
    subject:
      count === 1
        ? 'You have 1 open action item'
        : `You have ${count} open action items`,
    html: layout({
      heading: 'Your open action items',
      intro,
      bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;background-color:#ffffff;border:1px solid #e6eef8;border-radius:12px;">
        ${rows}
      </table>`,
      footnote: 'This summary goes out every Monday while items remain open.',
    }),
    text: [
      intro,
      '',
      ...items.map(
        (i) =>
          `- ${i.title} (due ${formatDate(i.dueDate)}${i.eventTitle ? `, ${i.eventTitle}` : ''})`,
      ),
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
 * The published record, with the action items it produced.
 *
 * Carries a link for a guest and a different one for staff: a guest has no
 * session, so the in-app URL would be a dead end for them.
 */
export function minutesPublishedEmail({
  name,
  eventTitle,
  eventDate,
  summary,
  actionItems,
  link,
  isGuest,
}: {
  name: string;
  eventTitle: string;
  eventDate: Date | string;
  summary?: string | null;
  actionItems: { title: string; ownerName?: string | null; dueDate: Date | string }[];
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

  const bodyHtml = [
    summary
      ? `<p style="margin:0 0 16px;color:#334155;font-size:14px;">${escapeHtml(summary)}</p>`
      : '',
    actionItems.length
      ? `<p style="margin:16px 0 8px;color:#0f172a;font-size:14px;font-weight:600;">Action items (${actionItems.length})</p>
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border:1px solid #e6eef8;border-radius:12px;">${itemRows}</table>`
      : `<p style="margin:16px 0 0;color:#64748b;font-size:14px;">No action items were raised.</p>`,
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
      summary ?? '',
      actionItems.length ? `Action items (${actionItems.length}):` : 'No action items were raised.',
      ...actionItems.map(
        (i) => `- ${i.title}${i.ownerName ? ` (${i.ownerName})` : ''}, due ${formatDate(i.dueDate)}`,
      ),
      '',
      link,
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
