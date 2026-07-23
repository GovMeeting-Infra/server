import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { RoomsService } from './rooms.service';
import { BookingsService } from './bookings.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { BookRoomDto } from './dto/book-room.dto';
import { UpdateBookingDto } from './dto/update-booking.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('Rooms & Bookings')
@ApiBearerAuth()
@Controller('api/v1')
@UseGuards(RolesGuard)
export class RoomsController {
  constructor(
    private roomsService: RoomsService,
    private bookingsService: BookingsService,
  ) {}

  // ========== ROOMS ==========

  @Post('admin/rooms')
  @Roles('MINISTRY_ADMIN', 'SUPER_ADMIN')
  async createRoom(
    @Body() dto: CreateRoomDto,
    @CurrentUser() user: any,
  ) {
    return this.roomsService.createRoom(dto, user.ministryId, user.id);
  }

  @Get('rooms')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async getRooms(@CurrentUser() user: any) {
    return this.roomsService.getRooms(user.ministryId);
  }

  @Get('rooms/:roomId')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async getRoom(
    @Param('roomId') roomId: string,
    @CurrentUser() user: any,
  ) {
    return this.roomsService.getRoom(roomId, user.ministryId);
  }

  @Patch('admin/rooms/:roomId')
  @Roles('MINISTRY_ADMIN', 'SUPER_ADMIN')
  async updateRoom(
    @Param('roomId') roomId: string,
    @Body() dto: UpdateRoomDto,
    @CurrentUser() user: any,
  ) {
    return this.roomsService.updateRoom(roomId, dto, user.ministryId, user.id);
  }

  @Delete('admin/rooms/:roomId')
  @HttpCode(204)
  @Roles('MINISTRY_ADMIN', 'SUPER_ADMIN')
  async deactivateRoom(
    @Param('roomId') roomId: string,
    @CurrentUser() user: any,
  ) {
    await this.roomsService.deactivateRoom(roomId, user.ministryId, user.id);
  }

  @Get('rooms/:roomId/availability')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async checkAvailability(
    @Param('roomId') roomId: string,
    @Query('startTime') startTime: string,
    @Query('endTime') endTime: string,
    @CurrentUser() user: any,
  ) {
    return this.roomsService.checkAvailability(
      roomId,
      new Date(startTime),
      new Date(endTime),
      user.ministryId,
    );
  }

  // ========== BOOKINGS ==========

  @Post('bookings')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async bookRoom(
    @Body() dto: BookRoomDto,
    @CurrentUser() user: any,
  ) {
    return this.bookingsService.bookRoom(dto, user.id, user.ministryId);
  }

  @Get('bookings/:bookingId')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async getBooking(
    @Param('bookingId') bookingId: string,
    @CurrentUser() user: any,
  ) {
    return this.bookingsService.getBooking(bookingId, user.ministryId);
  }

  @Get('rooms/:roomId/bookings')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async getBookingsByRoom(
    @Param('roomId') roomId: string,
    @CurrentUser() user: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.bookingsService.getBookingsByRoom(
      roomId,
      user.ministryId,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );
  }

  @Get('my-bookings')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async getMyBookings(@CurrentUser() user: any) {
    return this.bookingsService.getBookingsByUser(user.id, user.ministryId);
  }

  @Patch('bookings/:bookingId')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async updateBooking(
    @Param('bookingId') bookingId: string,
    @Body() dto: UpdateBookingDto,
    @CurrentUser() user: any,
  ) {
    return this.bookingsService.updateBooking(
      bookingId,
      dto,
      user.id,
      user.ministryId,
    );
  }

  @Delete('bookings/:bookingId')
  @HttpCode(200)
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async cancelBooking(
    @Param('bookingId') bookingId: string,
    @CurrentUser() user: any,
  ) {
    return this.bookingsService.cancelBooking(bookingId, user.id, user.ministryId);
  }
}
