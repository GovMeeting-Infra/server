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
      `authToken=${(result as any).token}; HttpOnly; Secure; SameSite=Lax`,
    );

    res.json({
      success: true,
      message: 'Sign in successful',
    });
  }

  @Get('session')
  async getSession(@Req() req: Request) {
    const authHeader = req.headers.authorization;
    const cookie = req.headers.cookie;

    let token: string | null = null;

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (cookie) {
      const cookieParts = cookie.split(';');
      for (const part of cookieParts) {
        const [key, value] = part.trim().split('=');
        if (key === 'authToken' || key === '__session') {
          token = value;
          break;
        }
      }
    }

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
  async signOut(@Res() res: Response): Promise<void> {
    res.clearCookie('authToken');
    res.json({ success: true, message: 'Signed out' });
  }
}
