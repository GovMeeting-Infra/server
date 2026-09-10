import { CLIENT_ID_PATTERN } from '../validators/is-client-id.decorator';

/**
 * The shape check for a client-minted primary key. Not a security control —
 * anyone can produce a value in this shape — so these cover that it accepts the
 * identifiers Prisma actually generates and rejects values that have no
 * business in a primary key column.
 */
describe('client id shape', () => {
  it('accepts a cuid of the kind Prisma generates for @default(cuid())', () => {
    // 'c' plus 24 lowercase alphanumerics.
    expect(CLIENT_ID_PATTERN.test('cm3x9k2p40000qwer8t7yu1io')).toBe(true);
  });

  it('accepts a cuid2, so switching the schema to cuid(2) is not a breaking change', () => {
    // cuid2 is shorter and does not always begin with 'c'.
    expect(CLIENT_ID_PATTERN.test('tz4a98xxat96iws9zmbrgj3a')).toBe(true);
    expect(CLIENT_ID_PATTERN.test('pfh0haxfpzowht3oi213cqos')).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['too short', 'abc'],
    ['too long', 'a'.repeat(33)],
    ['starting with a digit', '1m3x9k2p40000qwer8t7yu1io'],
    ['uppercase', 'CM3X9K2P40000QWER8T7YU1IO'],
    ['a path', 'cm3x9k2p4/../../etc/passwd'],
    ['a newline', 'cm3x9k2p40000qwer8t7yu1i\n'],
    ['a null byte', 'cm3x9k2p40000qwer8t7yu1i\u0000'],
    ['whitespace', 'cm3x9k2p4 0000qwer8t7yu1io'],
    ['a hyphen', 'cm3x9k2p4-0000qwer8t7yu1i'],
  ])('rejects %s', (_label, value) => {
    expect(CLIENT_ID_PATTERN.test(value)).toBe(false);
  });
});
