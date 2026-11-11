/**
 * Who a message says it is from, and where a reply goes.
 *
 * Both feed inbox placement. Gmail's Updates tab and Zoho's Notifications
 * folder lean on a bare `noreply@` sender as a sign of machine mail, and a
 * message nobody can reply to never earns the replies that build a sending
 * domain's reputation. So the sender carries a display name, and replies go to
 * a mailbox a person reads.
 *
 * Read from process.env on every call, like the rest of the mail module, so a
 * reload with `--update-env` takes effect without a code change.
 */

const DISPLAY_NAME = 'Smart Meeting';
const DEFAULT_ADDRESS = 'smartmeeting@calendar.gov.sl';

/**
 * The From header. EMAIL_FROM may be a bare address or already carry a name
 * ("Smart Meeting <smartmeeting@calendar.gov.sl>"); a bare one gets the
 * display name added, and one with a name is left as written.
 */
export function senderAddress(): string {
  const configured = (process.env.EMAIL_FROM || '').trim() || DEFAULT_ADDRESS;
  if (configured.includes('<')) return configured;
  return `${DISPLAY_NAME} <${configured}>`;
}

/**
 * Where replies go, or null when nowhere is configured. The sending domain has
 * inbound mail turned off in Resend, so without a Reply-To a reply would
 * bounce, and the footer must not invite one.
 *
 * EMAIL_REPLY_TO wins; SUPPORT_EMAIL, the help page's address, is the
 * fallback, since it is already the mailbox people are told to write to.
 */
export function replyToAddress(): string | null {
  const value = (
    process.env.EMAIL_REPLY_TO ||
    process.env.SUPPORT_EMAIL ||
    ''
  ).trim();
  return value || null;
}
