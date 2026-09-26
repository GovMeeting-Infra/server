import { OpenAiDrafter } from '../drafters/openai.drafter';

/**
 * The same three failures the Claude drafter raises, in the shapes OpenAI
 * reports them: a refusal arrives as a content part on a successful request,
 * and truncation as a status rather than a stop reason. Missing either one
 * would store an empty draft as though it had worked.
 */
describe('OpenAiDrafter', () => {
  const input = {
    title: 'Budget review',
    startAt: new Date('2026-09-22T10:00:00Z'),
    attendeeNames: ['A. Kamara'],
    segments: [{ speaker: 0, text: 'We go do am next week.' }],
  };

  const draft = {
    decisions: ['The budget was approved.'],
    nextSteps: [],
    actionItems: [],
    lowConfidenceNotes: [],
  };

  const drafterReturning = (response: any) => {
    const parse = jest.fn().mockResolvedValue(response);
    return {
      parse,
      drafter: new OpenAiDrafter(() => ({ responses: { parse } }) as any),
    };
  };

  afterEach(() => {
    delete process.env.MINUTES_DRAFT_MODEL;
  });

  it('returns the parsed draft', async () => {
    const { drafter, parse } = drafterReturning({
      status: 'completed',
      output: [{ content: [{ type: 'output_text' }] }],
      output_parsed: draft,
    });
    await expect(drafter.draft(input)).resolves.toEqual(draft);

    const sent = parse.mock.calls[0][0];
    expect(sent.model).toBe('gpt-6-sol');
    expect(sent.text.format).toBeDefined();
    // The transcript goes in as the user turn, the instructions as the system.
    expect(sent.input[1].content).toContain('We go do am next week.');
  });

  it('honours a configured model', async () => {
    process.env.MINUTES_DRAFT_MODEL = 'gpt-6-luna';
    const { drafter, parse } = drafterReturning({
      status: 'completed',
      output: [],
      output_parsed: draft,
    });
    await drafter.draft(input);
    expect(parse.mock.calls[0][0].model).toBe('gpt-6-luna');
  });

  it('fails on a refusal, which comes back as a content part', async () => {
    const { drafter } = drafterReturning({
      status: 'completed',
      output: [{ content: [{ type: 'refusal', refusal: 'no' }] }],
      output_parsed: null,
    });
    await expect(drafter.draft(input)).rejects.toThrow(/declined/);
  });

  it('fails on a truncated response', async () => {
    const { drafter } = drafterReturning({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
      output_parsed: null,
    });
    await expect(drafter.draft(input)).rejects.toThrow(/cut off/);
  });

  it('fails when nothing parsed', async () => {
    const { drafter } = drafterReturning({
      status: 'completed',
      output: [],
      output_parsed: null,
    });
    await expect(drafter.draft(input)).rejects.toThrow(/did not parse/);
  });
});
