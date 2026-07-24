import { createCipheriv, createDecipheriv, randomBytes, createHash, CipherGCM, DecipherGCM } from 'crypto';

export class EncryptionUtil {
  private algorithm = 'aes-256-gcm';
  private key: Buffer;

  constructor(keyHex?: string) {
    // Use provided key, environment variable, or default
    const key = keyHex || process.env.DATA_ENCRYPTION_KEY || 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5';

    if (!key || key.length !== 64) {
      throw new Error('Encryption key must be 32 bytes (64 hex chars)');
    }

    this.key = Buffer.from(key, 'hex');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv(this.algorithm, this.key, iv) as CipherGCM;

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  decrypt(ciphertext: string): string {
    const [ivHex, authTagHex, encrypted] = ciphertext.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = createDecipheriv(this.algorithm, this.key, iv) as DecipherGCM;
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
