import { detectConflict, describeConflict } from '../utils/write-conflict.util';

describe('write conflict reporting', () => {
  const base = new Date('2026-09-07T10:00:00.000Z');

  it('reports a conflict when the record moved on after the client read it', () => {
    expect(detectConflict(base, new Date('2026-09-07T10:05:00.000Z'))).toBe(true);
  });

  it('reports none when the record is untouched since', () => {
    expect(detectConflict(base, base)).toBe(false);
  });

  it('reports none when the record is somehow older', () => {
    expect(detectConflict(base, new Date('2026-09-07T09:00:00.000Z'))).toBe(false);
  });

  it('reports none when the client gave no base version', () => {
    // An ordinary online write. "Nobody checked" must not be reported as
    // "checked and clean" — claiming a write was safe when nothing verified it
    // is worse than saying nothing.
    expect(detectConflict(null, new Date())).toBe(false);
  });

  it('carries back what was overwritten, not just that something was', () => {
    // A minutes save replaces the whole list, so a warning alone tells someone
    // their lines are gone with nothing to restore from.
    const replaced = { decisions: ['Approved the budget'], nextSteps: [] };
    const conflict = describeConflict(base, { id: 'u1', name: 'Fatmata' }, replaced);

    expect(conflict).toEqual({
      overwritten: true,
      previousUpdatedAt: '2026-09-07T10:00:00.000Z',
      previousActor: { id: 'u1', name: 'Fatmata' },
      previousContent: replaced,
    });
  });
});
