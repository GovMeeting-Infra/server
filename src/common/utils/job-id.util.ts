/**
 * A BullMQ job id, always shaped `kind:subject:detail`.
 *
 * BullMQ refuses a custom id containing a colon unless it splits into exactly
 * three parts — the shape of its legacy repeat-job keys. It throws "Custom Id
 * cannot contain :" from add(), and every producer here swallows queue errors
 * so that a notification cannot fail the action behind it. Ids written by hand
 * with a fourth part (a timestamp tacked on) or only two were therefore
 * refused on every call, silently: co-organizer, meeting-changed, re-sent
 * invitation and overdue emails, and every push, were never queued at all,
 * while the in-app notification beside them arrived as if nothing was wrong.
 *
 * Extra detail is joined with '-' rather than ':', and a colon inside any part
 * is replaced, so the result is three parts whatever is passed in.
 */
export function jobId(
  kind: string,
  subject: string,
  ...detail: [string | number, ...(string | number)[]]
): string {
  const part = (p: string | number) => String(p).replace(/:/g, '-');
  return [kind, subject, detail.map(part).join('-')].map(part).join(':');
}
