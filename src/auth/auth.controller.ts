import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  UseGuards,
  Res,
  Req,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { SignInDto } from './dto/sign-in.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { auth } from './auth.config';
import { extractToken } from './extract-token';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimit } from '../common/decorators/rate-limit.decorator';

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private passwordReset: PasswordResetService,
  ) {}

  @Post('sign-in/email')
  async signIn(
    @Body() dto: SignInDto,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    const result = await this.authService.signIn(
      dto,
      req.ip || undefined,
    );

    res.setHeader(
      'Set-Cookie',
      `authToken=${(result as any).token}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );

    res.json({
      success: true,
      message: 'Sign in successful',
    });
  }

  @Get('session')
  async getSession(@Req() req: Request) {
    const token = extractToken(req);

    if (!token) {
      return { authenticated: false };
    }

    const session = await this.authService.getSession(token);

    if (!session) {
      return { authenticated: false };
    }

    return {
      authenticated: true,
      user: session,
    };
  }

  /**
   * Request a reset link.
   *
   * Always succeeds with the same body, whether or not the address belongs to
   * an account. Anything else turns this into a way to discover who has one.
   */
  @Post('forgot-password')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ perIp: 5, windowSeconds: 900 })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.passwordReset.request(dto.email, req.ip || undefined);

    return {
      message:
        'If that address belongs to an account, a reset link is on its way.',
    };
  }

  /** Checks a link before showing the form, so a dead link fails early. */
  @Get('reset-password/:token')
  @UseGuards(RateLimitGuard)
  @RateLimit({ perIp: 30, windowSeconds: 900 })
  async verifyReset(@Param('token') token: string) {
    return this.passwordReset.verify(token);
  }

  @Post('reset-password/:token')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ perIp: 10, windowSeconds: 900 })
  async resetPassword(
    @Param('token') token: string,
    @Body() dto: ResetPasswordDto,
    @Req() req: Request,
  ) {
    return this.passwordReset.reset(token, dto.password, req.ip || undefined);
  }

  @Post('sign-out')
  async signOut(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.authService.signOut(extractToken(req), req.ip || undefined);

    // Attributes must mirror the sign-in cookie. A browser will not let a
    // non-Secure Set-Cookie overwrite a Secure one, so clearing without them
    // can leave the cookie sitting in the jar.
    res.clearCookie('authToken', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
    res.json({ success: true, message: 'Signed out' });
  }
}
