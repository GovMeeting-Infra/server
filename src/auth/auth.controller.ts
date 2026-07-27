import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Res,
  Req,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { AuthService } from './auth.service';
import { SignInDto } from './dto/sign-in.dto';
import { auth } from './auth.config';
import { extractToken } from './extract-token';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private authService: AuthService) {}

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
