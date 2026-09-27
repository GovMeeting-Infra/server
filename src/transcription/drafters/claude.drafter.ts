import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  DraftInput,
  MinutesDraft,
  MinutesDraftSchema,
  MinutesDrafter,
  renderTranscript,
  SYSTEM,
} from '../minutes-drafter';

/** Drafts the minutes with Claude. Selected by MINUTES_DRAFT_PROVIDER. */
export class ClaudeDrafter implements MinutesDrafter {
  private client: Anthropic | null = null;

  /**
   * Takes a factory so the client is built on first use: the SDK throws when
   * ANTHROPIC_API_KEY is missing, and that should fail a draft, not the boot.
   */
  constructor(private makeClient: () => Anthropic) {}

  async draft(input: DraftInput): Promise<MinutesDraft> {
    this.client ??= this.makeClient();
    const response = await this.client.messages.parse({
      model: process.env.MINUTES_DRAFT_MODEL || 'claude-opus-5',
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: 'user', content: renderTranscript(input) }],
      output_config: { format: zodOutputFormat(MinutesDraftSchema) },
    });

    if (response.stop_reason === 'refusal') {
      throw new Error('The model declined to draft these minutes');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error('The draft was cut off before it finished');
    }
    if (!response.parsed_output) {
      throw new Error('The model returned a draft that did not parse');
    }
    return response.parsed_output;
  }
}
