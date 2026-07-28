import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { InvitesService } from './invites.service';
import { SetInvitePasswordDto } from './dto/set-invite-password.dto';

/**
 * Public invitation endpoints.
 *
 * No guards and no @Roles by design: the recipient has no account session yet.
 * RolesGuard only rejects when a handler declares roles, so their absence is
 * what makes these reachable — same mechanism as PublicEventsController. The
 * token itself is the credential.
 */
@Controller('api/v1/invites')
export class InvitesController {
  constructor(private invitesService: InvitesService) {}

  @Get(':token')
  verify(@Param('token') token: string) {
    return this.invitesService.verify(token);
  }

  @Post(':token/password')
  setPassword(
    @Param('token') token: string,
    @Body() dto: SetInvitePasswordDto,
  ) {
    return this.invitesService.setPassword(token, dto.password);
  }
}
