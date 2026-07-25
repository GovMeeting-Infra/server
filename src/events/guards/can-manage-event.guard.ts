import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CanManageEventGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user || request.session?.user;
    const eventId = request.params.id || request.params.eventId;

    if (!user || !eventId) {
      throw new ForbiddenException('Missing user or event ID');
    }

    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: { organizerId: true, ministryId: true },
    });

    if (!event) {
      throw new ForbiddenException('Event not found');
    }

    if (user.systemRole === 'SUPER_ADMIN') {
      return true;
    }

    if (event.organizerId === user.id) {
      return true;
    }

    // Public activities have no organizer, so an identity check alone would
    // lock everyone out of them. Ministry admins can manage those, within
    // their own ministry.
    if (
      event.organizerId === null &&
      ['MINISTER', 'MINISTRY_ADMIN'].includes(user.systemRole) &&
      event.ministryId === user.ministryId
    ) {
      return true;
    }

    throw new ForbiddenException('Not authorized to manage this event');
  }
}
