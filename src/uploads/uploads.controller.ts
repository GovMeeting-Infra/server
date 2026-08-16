import {
  Controller,
  Get,
  Query,
  UseGuards,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Issues short-lived Cloudinary upload signatures so the browser can upload
 * directly. Signing here keeps the API secret server-side while avoiding
 * proxying image bytes through this service — no multipart handling, and no
 * new dependency: the signature is a plain SHA-1 over the sorted params.
 */
@Controller('api/v1/uploads')
@UseGuards(RolesGuard)
export class UploadsController {
  @Get('signature')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  getSignature(@Query('folder') folder?: string) {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      throw new ServiceUnavailableException(
        'Image upload is not configured on this server',
      );
    }

    const timestamp = Math.floor(Date.now() / 1000);

    // An allowlist, because the folder is signed and then trusted by Cloudinary
    // — an unchecked value would let a caller write anywhere in the account.
    // 'avatars' was missing, so every profile photo the account page uploaded
    // asked for 'avatars', fell through to the fallback, and was filed with the
    // event banners.
    const ALLOWED_FOLDERS = ['public-events', 'event-banners', 'avatars'];
    const targetFolder =
      folder && ALLOWED_FOLDERS.includes(folder) ? folder : 'event-banners';

    // Cloudinary expects the parameters that will be sent, sorted by key,
    // joined as k=v pairs, with the API secret appended.
    const toSign = `folder=${targetFolder}&timestamp=${timestamp}`;
    const signature = createHash('sha1')
      .update(`${toSign}${apiSecret}`)
      .digest('hex');

    return {
      cloudName,
      apiKey,
      timestamp,
      folder: targetFolder,
      signature,
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    };
  }
}
