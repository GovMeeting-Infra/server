import { buildListenUrl, splitBySpeaker } from '../providers/deepgram.provider';

/**
 * The retention promise rests on one query parameter. If it goes missing,
 * Deepgram's default is to keep part of the audio for training, and nothing
 * else in the system would notice.
 */
describe('buildListenUrl', () => {
  it('always opts out of Deepgram keeping the audio', () => {
    const url = new URL(buildListenUrl([]));
    expect(url.searchParams.get('mip_opt_out')).toBe('true');
  });

  it('still opts out when key terms are supplied', () => {
    const url = new URL(buildListenUrl(['mip_opt_out=false', 'Krio']));
    expect(url.searchParams.getAll('mip_opt_out')).toEqual(['true']);
    expect(url.searchParams.getAll('keyterm')).toEqual([
      'mip_opt_out=false',
      'Krio',
    ]);
  });

  it('asks for speaker labels on the English model', () => {
    const url = new URL(buildListenUrl([]));
    expect(url.host).toBe('api.deepgram.com');
    expect(url.searchParams.get('diarize')).toBe('true');
    expect(url.searchParams.get('model')).toBe('nova-3');
  });
});

describe('splitBySpeaker', () => {
  const results = (words: any[], transcript = 'x') => ({
    type: 'Results' as const,
    is_final: true,
    start: 10,
    duration: 5,
    channel: { alternatives: [{ transcript, words }] },
  });

  it('gives each voice its own segment', () => {
    const segments = splitBySpeaker(
      results([
        {
          word: 'good',
          punctuated_word: 'Good',
          start: 10,
          end: 10.3,
          speaker: 0,
        },
        {
          word: 'morning',
          punctuated_word: 'morning.',
          start: 10.3,
          end: 10.8,
          speaker: 0,
        },
        {
          word: 'kushe',
          punctuated_word: 'Kushe.',
          start: 11,
          end: 11.4,
          speaker: 1,
        },
      ]),
    );
    expect(segments).toEqual([
      { text: 'Good morning.', speaker: 0, start: 10, end: 10.8 },
      { text: 'Kushe.', speaker: 1, start: 11, end: 11.4 },
    ]);
  });

  it('ignores silence', () => {
    expect(splitBySpeaker(results([], '  '))).toEqual([]);
  });

  it('falls back to the whole transcript when there are no words', () => {
    expect(splitBySpeaker(results([], 'Hello.'))).toEqual([
      { text: 'Hello.', speaker: null, start: 10, end: 15 },
    ]);
  });
});
