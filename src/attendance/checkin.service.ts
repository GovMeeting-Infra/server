import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EncryptionUtil } from '../common/utils/encryption.util';
import { QRTokenService } from './qr-token.service';
import { CheckInDto } from './dto/check-in.dto';

@Injectable()
export class CheckinService {
  private logger = new Logger('CheckinService');
  private encryption: EncryptionUtil;

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private qrToken: QRTokenService,
  ) {
    this.encryption = new EncryptionUtil(
      process.env.DATA_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef',
    );
  }

  async checkIn(
    token: string,
    dto: CheckInDto,
    userId?: string,
  ) {
    const eventId = await this.qrToken.validateToken(token);

    if (!eventId) {
      throw new BadRequestException('Invalid or expired QR token');
    }

    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    let withinGeofence = true;
    let checkInMethod = 'QR';

    if (event.venueLat && event.venueLng && dto.lat && dto.lng) {
      checkInMethod = 'GEO';

      if (!dto.gpsAccuracy || dto.gpsAccuracy > 100) {
        throw new BadRequestException(
          'GPS accuracy insufficient for geofence verification',
        );
      }

      withinGeofence = this.validateGeofence(
        dto.lat,
        dto.lng,
        event.venueLat,
        event.venueLng,
        event.geofenceRadius || 100,
      );

      if (!withinGeofence) {
        throw new BadRequestException(
          'Location outside event geofence',
        );
      }
    }

    const encryptedLat = dto.lat
      ? this.encryption.encrypt(dto.lat.toString())
      : null;
    const encryptedLng = dto.lng
      ? this.encryption.encrypt(dto.lng.toString())
      : null;

    let attendance = await (this.prisma as any).attendance.findUnique({
      where: {
        eventId_userId: {
          eventId,
          userId: userId || eventId,
        },
      },
    });

    if (attendance) {
      throw new BadRequestException('Already checked in to this event');
    }

    attendance = await (this.prisma as any).attendance.create({
      data: {
        eventId,
        userId: userId || eventId,
        signedName: dto.signedName,
        signature: dto.signature,
        lat: encryptedLat,
        lng: encryptedLng,
        gpsAccuracy: dto.gpsAccuracy,
        withinGeofence,
        checkInMethod,
        ipAddress: null,
        userAgent: null,
      },
    });

    await this.audit.log({
      action: 'ATTENDANCE_CHECKIN',
      actionCategory: 'ATTENDANCE',
      entityType: 'Attendance',
      entityId: attendance.id,
      status: 'SUCCESS',
      ministryId: event.ministryId,
      actorId: userId,
      description: `Checked in to event: ${event.title} (${checkInMethod})`,
      metadata: {
        eventId,
        checkInMethod,
        withinGeofence,
      },
    });

    return {
      id: attendance.id,
      eventId,
      signedName: attendance.signedName,
      checkInAt: attendance.checkInAt,
      checkInMethod,
    };
  }

  validateGeofence(
    userLat: number,
    userLng: number,
    venueLat: number,
    venueLng: number,
    radiusMeters: number,
  ): boolean {
    const distance = this.haversineDistance(
      userLat,
      userLng,
      venueLat,
      venueLng,
    );

    return distance <= radiusMeters;
  }

  private haversineDistance(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const R = 6371000; // Earth's radius in meters
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRad(degrees: number): number {
    return (degrees * Math.PI) / 180;
  }

  async manualCheckIn(
    eventId: string,
    userId: string,
    dto: CheckInDto,
    staffId: string,
    ministryId: string,
  ) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    let attendance = await (this.prisma as any).attendance.findUnique({
      where: {
        eventId_userId: {
          eventId,
          userId,
        },
      },
    });

    if (attendance) {
      throw new BadRequestException('Already checked in');
    }

    attendance = await (this.prisma as any).attendance.create({
      data: {
        eventId,
        userId,
        signedName: dto.signedName,
        signature: dto.signature,
        checkInMethod: 'MANUAL',
        withinGeofence: true,
      },
    });

    await this.audit.log({
      action: 'ATTENDANCE_MANUAL_CHECKIN',
      actionCategory: 'ATTENDANCE',
      entityType: 'Attendance',
      entityId: attendance.id,
      status: 'SUCCESS',
      ministryId,
      actorId: staffId,
      description: `Staff check-in: ${attendance.signedName} to event: ${event.title}`,
    });

    return attendance;
  }
}
