import { ForbiddenException } from '@nestjs/common';
import { ActionItemsService } from '../action-items.service';

/**
 * Who may change what.
 *
 * Assistants introduce a second, narrower tier to a permission check that was
 * all-or-nothing, and a narrower tier is exactly the kind of thing that
 * quietly widens later. These pin the boundary: an assistant reports on the
 * work, they do not decide what the work is.
 */
describe('ActionItemsService — permissions', () => {
  const MINISTRY = 'min-moh';
  const OWNER = 'u-owner';
  const RAISER = 'u-raiser';
  const HELPER = 'u-helper';
  const STRANGER = 'u-stranger';
  const ITEM = 'ai-1';

  let prisma: any;
  let service: ActionItemsService;

  const seedItem = (over: Record<string, unknown> = {}) => {
    prisma.actionItem.findUnique.mockResolvedValue({
      id: ITEM,
      title: 'Circulate the revised figures',
      ownerId: OWNER,
      assignedById: RAISER,
      dueDate: new Date('2026-04-01T00:00:00Z'),
      status: 'TODO',
      minutes: { event: { ministryId: MINISTRY } },
      assistants: [{ userId: HELPER }],
      ...over,
    });
  };

  const written = () => prisma.actionItem.update.mock.calls[0][0].data;

  beforeEach(() => {
    jest.clearAllMocks();

    prisma = {
      actionItem: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: ITEM }),
      },
      actionItemAssistant: {
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: { findFirst: jest.fn() },
    };

    service = new ActionItemsService(
      prisma,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      { invalidateAnalytics: jest.fn().mockResolvedValue(undefined) } as any,
      {
        notifyActionItemAssigned: jest.fn().mockResolvedValue(undefined),
        notifyActionItemStatusChanged: jest.fn().mockResolvedValue(undefined),
      } as any,
    );

    jest
      .spyOn(service, 'getActionItem')
      .mockResolvedValue({ id: ITEM } as any);
  });

  /**
   * The detail view reads item.minutes.event.title straight off whatever a
   * write returned. updateStatus used to return the bare prisma.update result
   * — scalars only — so every save replaced the open item with an object that
   * had no meeting on it and the next render threw.
   */
  describe('what a write hands back', () => {
    it('returns the full record, not the bare update result', async () => {
      seedItem();
      const full = { id: ITEM, minutes: { event: { id: 'e1', title: 'Budget' } } };
      (service.getActionItem as jest.Mock).mockResolvedValue(full);

      const result = await service.updateStatus(
        ITEM,
        { status: 'IN_PROGRESS' } as any,
        OWNER,
        MINISTRY,
        'STAFF',
      );

      expect(result).toBe(full);
      expect(service.getActionItem).toHaveBeenCalledWith(ITEM);
    });

    it('asks for the meeting when it loads one', async () => {
      (service.getActionItem as jest.Mock).mockRestore();
      prisma.actionItem.findUnique.mockResolvedValue({ id: ITEM });

      await service.getActionItem(ITEM);

      const include =
        prisma.actionItem.findUnique.mock.calls.at(-1)[0].include;
      expect(include.minutes.select.event).toBeTruthy();
      expect(include.assistants).toBeTruthy();
      expect(include.assignedBy).toBeTruthy();
    });
  });

  describe('an assistant', () => {
    const asHelper = (dto: Record<string, unknown>) =>
      service.updateStatus(ITEM, dto as any, HELPER, MINISTRY, 'STAFF');

    it('may report progress and move the status', async () => {
      seedItem();

      await asHelper({
        status: 'IN_PROGRESS',
        progressNotes: 'Draft circulated to the committee',
        progressLink: 'https://intranet/doc/1',
      });

      expect(written().status).toBe('IN_PROGRESS');
      expect(written().progressNotes).toBe('Draft circulated to the committee');
    });

    // The line the whole tier exists to draw.
    it.each([
      ['the title', { title: 'Something else entirely' }],
      ['the due date', { dueDate: '2026-09-01T00:00:00.000Z' }],
      ['the owner', { ownerId: STRANGER }],
      ['the description', { description: 'rewritten' }],
      ['the priority', { priority: 'high' }],
    ])('may not change %s', async (_label, dto) => {
      seedItem();

      await expect(asHelper(dto)).rejects.toThrow(ForbiddenException);
      expect(prisma.actionItem.update).not.toHaveBeenCalled();
    });

    it('is told why, not just refused', async () => {
      seedItem();

      await expect(asHelper({ title: 'x' })).rejects.toThrow(/Ask the owner/);
    });
  });

  describe('everyone else', () => {
    it('lets the owner change the task itself', async () => {
      seedItem();

      await service.updateStatus(
        ITEM,
        { title: 'Reworded' } as any,
        OWNER,
        MINISTRY,
        'STAFF',
      );

      expect(written().title).toBe('Reworded');
    });

    it('lets the person who raised it change the task', async () => {
      seedItem();

      await service.updateStatus(
        ITEM,
        { title: 'Reworded' } as any,
        RAISER,
        MINISTRY,
        'STAFF',
      );

      expect(written().title).toBe('Reworded');
    });

    it('refuses someone with no connection to the item', async () => {
      seedItem();

      await expect(
        service.updateStatus(
          ITEM,
          { status: 'COMPLETED' } as any,
          STRANGER,
          MINISTRY,
          'STAFF',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses an assistant from another ministry before anything else', async () => {
      seedItem();

      await expect(
        service.updateStatus(
          ITEM,
          { status: 'COMPLETED' } as any,
          HELPER,
          'min-other',
          'STAFF',
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.actionItem.update).not.toHaveBeenCalled();
    });
  });

  describe('moving the due date', () => {
    it('re-arms the reminder, so a rescheduled item is chased again', async () => {
      seedItem();

      await service.updateStatus(
        ITEM,
        { dueDate: '2026-09-01T00:00:00.000Z' } as any,
        OWNER,
        MINISTRY,
        'STAFF',
      );

      expect(written().reminderSentAt).toBeNull();
    });

    it('leaves the reminder alone when the date has not moved', async () => {
      seedItem();

      await service.updateStatus(
        ITEM,
        { dueDate: '2026-04-01T00:00:00.000Z' } as any,
        OWNER,
        MINISTRY,
        'STAFF',
      );

      expect(written().reminderSentAt).toBeUndefined();
    });
  });

  describe('recruiting help', () => {
    const activeUser = (over: Record<string, unknown> = {}) =>
      prisma.user.findFirst.mockResolvedValue({
        id: STRANGER,
        name: 'Foday Sesay',
        email: 'foday@moh.gov.sl',
        ministryId: MINISTRY,
        ...over,
      });

    it('lets the owner add a helper', async () => {
      seedItem();
      activeUser();

      await service.addAssistant(ITEM, STRANGER, OWNER, MINISTRY, 'STAFF');

      expect(prisma.actionItemAssistant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            userId: STRANGER,
            addedById: OWNER,
          }),
        }),
      );
    });

    // A helper who can recruit helpers is a second owner by another name.
    it('does not let an assistant recruit more assistants', async () => {
      seedItem();
      activeUser();

      await expect(
        service.addAssistant(ITEM, STRANGER, HELPER, MINISTRY, 'STAFF'),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.actionItemAssistant.upsert).not.toHaveBeenCalled();
    });

    it('refuses a helper from another ministry', async () => {
      seedItem();
      activeUser({ ministryId: 'min-other' });

      await expect(
        service.addAssistant(ITEM, STRANGER, OWNER, MINISTRY, 'STAFF'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses to make the owner their own assistant', async () => {
      seedItem();
      activeUser({ id: OWNER });

      await expect(
        service.addAssistant(ITEM, OWNER, RAISER, MINISTRY, 'STAFF'),
      ).rejects.toThrow(/already owns/);
    });
  });
});
