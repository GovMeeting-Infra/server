import { TasksService } from '../tasks.service';

/**
 * The meeting-reminder cron runs every 10 minutes across a one-hour window, so
 * without the guards below every attendee would be emailed roughly six times
 * per meeting, including for drafts and cancelled events.
 */
describe('TasksService.sendMeetingReminders', () => {
  let queue: { add: jest.Mock };
  let events: any[];
  let prisma: any;
  let service: TasksService;

  const event = (overrides: Record<string, unknown> = {}) => ({
    id: 'evt-1',
    title: 'Cabinet Briefing',
    attendees: [{ user: { id: 'usr-1' } }],
    ...overrides,
  });

  beforeEach(() => {
    events = [event()];
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    prisma = {
      event: { findMany: jest.fn().mockImplementation(() => events) },
    };
    service = new TasksService(prisma, queue as any);
  });

  it('queues one reminder per attendee', async () => {
    await service.sendMeetingReminders();
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'send-meeting-reminder',
      { eventId: 'evt-1', userId: 'usr-1' },
      expect.objectContaining({ jobId: 'meeting-reminder:evt-1:usr-1' }),
    );
  });

  it('uses a stable jobId across runs so repeat sweeps collapse to one email', async () => {
    await service.sendMeetingReminders();
    await service.sendMeetingReminders();
    await service.sendMeetingReminders();

    const jobIds = queue.add.mock.calls.map((c) => c[2].jobId);
    expect(new Set(jobIds).size).toBe(1);
  });

  it('retains the job long enough to outlive the one-hour reminder window', async () => {
    await service.sendMeetingReminders();
    const opts = queue.add.mock.calls[0][2];
    expect(opts.removeOnComplete.age).toBeGreaterThanOrEqual(60 * 60);
  });

  it('only looks at published events', async () => {
    await service.sendMeetingReminders();
    const where = prisma.event.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('PUBLISHED');
  });

  it('excludes attendees who declined', async () => {
    await service.sendMeetingReminders();
    const include = prisma.event.findMany.mock.calls[0][0].include;
    expect(include.attendees.where).toEqual({ status: { not: 'DECLINED' } });
  });

  it('skips external attendees who have no account', async () => {
    events = [event({ attendees: [{ user: null }] })];
    await service.sendMeetingReminders();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('queues nothing when no event is due', async () => {
    events = [];
    await service.sendMeetingReminders();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not throw when the query fails', async () => {
    prisma.event.findMany.mockRejectedValue(new Error('db down'));
    await expect(service.sendMeetingReminders()).resolves.toBeUndefined();
  });
});
