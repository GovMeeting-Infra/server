import { PlatformController } from '../platform.controller';

/**
 * A link base is correct or catastrophic depending on where it is running, and
 * a console that cries wolf in development is one nobody reads in production.
 */
describe('PlatformController — configuration warnings', () => {
  const settings = {
    get: jest.fn().mockResolvedValue('x'),
  } as any;

  const controller = new PlatformController({} as any, {} as any, settings, {} as any);
  const config = () => (controller as any).configuration();

  const ORIGINAL = process.env;
  beforeEach(() => {
    process.env = {
      ...ORIGINAL,
      RESEND_API_KEY: 'k',
      CLOUDINARY_API_KEY: 'k',
    };
    settings.get.mockResolvedValue('info@mocti.gov.sl');
  });
  afterAll(() => {
    process.env = ORIGINAL;
  });

  const warnAbout = async () =>
    (await config()).warnings.filter((w: string) => /link/i.test(w));

  it('accepts a localhost link base in development', async () => {
    process.env.NODE_ENV = 'development';
    process.env.WEB_URL = 'http://localhost:3000';

    expect(await warnAbout()).toEqual([]);
    expect((await config()).webUrlLooksRight).toBe(true);
  });

  it('refuses the same value in production', async () => {
    // The failure mode this exists for: nothing errors, no log line appears,
    // and every invitation simply leads nowhere.
    process.env.NODE_ENV = 'production';
    process.env.WEB_URL = 'http://localhost:3000';

    expect(await warnAbout()).toHaveLength(1);
    expect((await config()).webUrlLooksRight).toBe(false);
  });

  it('accepts the real address in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_URL = 'https://calendar.gov.sl';

    expect(await warnAbout()).toEqual([]);
    expect((await config()).webUrlLooksRight).toBe(true);
  });

  it('warns about plain HTTP in production, where the cookie is Secure', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_URL = 'http://calendar.gov.sl';

    expect(await warnAbout()).toHaveLength(1);
  });

  it('warns when it is unset at all, in any environment', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.WEB_URL;
    delete process.env.NEXT_PUBLIC_WEB_URL;

    expect(await warnAbout()).toHaveLength(1);
    expect((await config()).webUrlLooksRight).toBe(false);
  });
});
