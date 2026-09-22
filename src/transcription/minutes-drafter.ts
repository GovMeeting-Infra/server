import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod/v4';

/**
 * What the AI suggests for a meeting's minutes. Stored on Transcript.aiDraft
 * and offered to the organizer in the editor — never written into the record
 * itself, which only a person adopts into.
 */
export const MinutesDraftSchema = z.object({
  decisions: z.array(z.string()),
  nextSteps: z.array(z.string()),
  actionItems: z.array(
    z.object({
      title: z.string(),
      ownerName: z.string().nullable(),
      dueDate: z.string().nullable(),
    }),
  ),
  lowConfidenceNotes: z.array(z.string()),
});

export type MinutesDraft = z.infer<typeof MinutesDraftSchema>;

export interface DraftInput {
  title: string;
  startAt: Date;
  attendeeNames: string[];
  segments: { speaker: number | null; text: string }[];
}

const SYSTEM = `You draft the minutes of Government of Sierra Leone meetings from an automatic transcript.

The minutes record what a meeting settled, not what was said in it. Produce:
- decisions: things the meeting agreed or resolved. One sentence each.
- nextSteps: things that will happen next that nobody was specifically tasked with.
- actionItems: tasks someone was asked to do. ownerName only if the transcript names the person responsible; dueDate (YYYY-MM-DD) only if a date or clear deadline was stated, resolved against the meeting date. Otherwise null.
- lowConfidenceNotes: short notes on anything you were unsure of — garbled passages, a decision you could not tell was final, a name you could not make out.

About the transcript: speakers are labelled by number, not name, and the labels are the recogniser's guess. Much of the speech is Krio mixed with English. The recogniser only knows English, so Krio passages appear as English-looking words chosen for their sound ("wi go du am" may come out as "we go do am", or as unrelated English words). Read through that to the meaning where you reasonably can, and write every point in plain formal English. Where you cannot recover the meaning, leave it out of the lists and say so in lowConfidenceNotes rather than guessing.

Include only what the transcript supports. Empty lists are fine. Keep each item to a single line.`;

export function renderTranscript(input: DraftInput): string {
  const lines = input.segments.map(
    (s) => `[Speaker ${s.speaker ?? '?'}] ${s.text}`,
  );
  return [
    `Meeting: ${input.title}`,
    `Date: ${input.startAt.toISOString().slice(0, 10)}`,
    input.attendeeNames.length
      ? `Invited: ${input.attendeeNames.join(', ')}`
      : null,
    '',
    '<transcript>',
    ...lines,
    '</transcript>',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

export class MinutesDrafter {
  private client: Anthropic | null = null;

  /**
   * Takes a factory so the client is built on first use: the SDK throws when
   * ANTHROPIC_API_KEY is missing, and that should fail a draft, not the boot.
   */
  constructor(private makeClient: () => Anthropic) {}

  async draft(input: DraftInput): Promise<MinutesDraft> {
    this.client ??= this.makeClient();
    const response = await this.client.messages.parse({
      model: 'claude-opus-5',
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
