import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import {
  DraftInput,
  MinutesDraft,
  MinutesDraftSchema,
  MinutesDrafter,
  renderTranscript,
  SYSTEM,
} from '../minutes-drafter';

/**
 * Drafts the minutes with OpenAI, so a deployment transcribing with OpenAI
 * needs no second vendor: one key, one bill, one retention agreement.
 */
export class OpenAiDrafter implements MinutesDrafter {
  private client: OpenAI | null = null;

  /** A factory, so a missing key fails one draft rather than the boot. */
  constructor(private makeClient: () => OpenAI) {}

  async draft(input: DraftInput): Promise<MinutesDraft> {
    this.client ??= this.makeClient();
    const response = await this.client.responses.parse({
      model: process.env.MINUTES_DRAFT_MODEL || 'gpt-6-sol',
      input: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: renderTranscript(input) },
      ],
      text: { format: zodTextFormat(MinutesDraftSchema, 'minutes') },
    });

    // A refusal is a content part, not an error: the request succeeds and the
    // draft is simply absent, which would otherwise look like a parse failure.
    const refusal = response.output
      ?.flatMap((item: any) => item.content ?? [])
      .find((part: any) => part?.type === 'refusal');
    if (refusal) {
      throw new Error('The model declined to draft these minutes');
    }
    if (response.status === 'incomplete') {
      throw new Error('The draft was cut off before it finished');
    }
    if (!response.output_parsed) {
      throw new Error('The model returned a draft that did not parse');
    }
    return response.output_parsed;
  }
}
