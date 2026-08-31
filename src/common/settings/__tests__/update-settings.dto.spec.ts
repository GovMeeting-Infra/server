import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateSettingsDto } from '../dto/update-settings.dto';

/**
 * main.ts validates with forbidNonWhitelisted, so a key missing from this DTO
 * is not merely ignored — the whole request is refused. SUPPORT_EMAIL was in
 * that position: a fully implemented setting, complete with its own address
 * validator and carried on every session response, that no super admin could
 * actually change because the payload never reached the service.
 */
const check = (payload: Record<string, unknown>) =>
  validateSync(plainToInstance(UpdateSettingsDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('UpdateSettingsDto', () => {
  it.each([
    ['SESSION_TIMEOUT_SECONDS', 43200],
    ['GOVERNMENT_EMAIL_DOMAIN', '.gov.sl'],
    ['SUPPORT_EMAIL', 'info@mocti.gov.sl'],
  ])('accepts %s', (key, value) => {
    expect(check({ [key]: value })).toHaveLength(0);
  });

  it('accepts a blank support address, which means "no address"', () => {
    // Not the same as omitting the key: blank is how an administrator turns
    // the help page's mailto off and sends people to their ministry admin.
    expect(check({ SUPPORT_EMAIL: '' })).toHaveLength(0);
  });

  it('still refuses a key nothing reads', () => {
    // GOVERNMENT_EMAIL_STRICT sits in the .env templates and is read by
    // nothing. Offering a control that changes nothing is worse than none.
    const errors = check({ GOVERNMENT_EMAIL_STRICT: 'true' });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('GOVERNMENT_EMAIL_STRICT');
  });

  it('accepts every key the service declares', () => {
    // Guards the drift that caused this: a setting added to SETTINGS but not
    // here is unreachable, and nothing else would have failed.
    const { SETTINGS } = jest.requireActual('../settings.service');
    const payload = Object.fromEntries(
      Object.keys(SETTINGS).map((k) => [
        k,
        k === 'SESSION_TIMEOUT_SECONDS' ? 43200 : 'x',
      ]),
    );
    expect(check(payload)).toHaveLength(0);
  });
});
