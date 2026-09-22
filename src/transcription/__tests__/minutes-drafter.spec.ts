import { MinutesDrafter, renderTranscript } from '../minutes-drafter';

describe('MinutesDrafter', () => {
  const input = {
    title: 'Budget review',
    startAt: new Date('2026-09-22T10:00:00Z'),
    attendeeNames: ['A. Kamara'],
    segments: [
      { speaker: 0, text: 'We go do am next week.' },
      { speaker: null, text: 'Agreed.' },
    ],
  };

  it('labels speakers and dates the meeting for the model', () => {
    const text = renderTranscript(input);
    expect(text).toContain('Date: 2026-09-22');
    expect(text).toContain('[Speaker 0] We go do am next week.');
    expect(text).toContain('[Speaker ?] Agreed.');
  });

  const drafterReturning = (response: any) => {
    const parse = jest.fn().mockResolvedValue(response);
    return {
      parse,
      drafter: new MinutesDrafter(() => ({ messages: { parse } }) as any),
    };
  };

  it('returns the parsed draft', async () => {
    const draft = {
      decisions: ['The budget was approved.'],
      nextSteps: [],
      actionItems: [],
      lowConfidenceNotes: [],
    };
    const { drafter, parse } = drafterReturning({
      stop_reason: 'end_turn',
      parsed_output: draft,
    });
    await expect(drafter.draft(input)).resolves.toEqual(draft);
    expect(parse.mock.calls[0][0].model).toBe('claude-opus-5');
  });

  it.each(['refusal', 'max_tokens'])('fails on a %s stop', async (reason) => {
    const { drafter } = drafterReturning({
      stop_reason: reason,
      parsed_output: null,
    });
    await expect(drafter.draft(input)).rejects.toThrow();
  });
});
