/**
 * A live speech-to-text stream. Audio goes in as it is captured and text comes
 * back as the provider settles on it. Nothing in this contract stores audio —
 * an implementation that buffers it to disk or asks its vendor to keep it is
 * wrong, whatever else it does.
 */
export interface TranscriptionStream {
  /** Forward one chunk of the browser's webm/opus recording. */
  send(chunk: Buffer): void;
  /**
   * Ask the provider to flush what it has heard and close. Resolves once the
   * last final segment has been delivered, so the caller can mark the
   * transcript complete knowing nothing is still in flight.
   */
  finish(): Promise<void>;
  /** Drop the stream without waiting for pending text. */
  abort(): void;
}

export interface StreamSegment {
  text: string;
  speaker: number | null;
  /** Seconds from the start of this stream's audio. */
  start: number;
  end: number;
}

export interface StreamHandlers {
  /** Text the provider will not revise. */
  onFinal(segment: StreamSegment): void;
  /** Provisional text for live captions only — never persisted. */
  onInterim(segment: StreamSegment): void;
  onError(error: Error): void;
  /** The provider closed the stream, whether asked to or not. */
  onClose(): void;
}

export interface TranscriptionProvider {
  readonly name: string;
  openStream(handlers: StreamHandlers): TranscriptionStream;
}

export const TRANSCRIPTION_PROVIDER = Symbol('TRANSCRIPTION_PROVIDER');
