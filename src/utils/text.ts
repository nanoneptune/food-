/**
 * Strips all emojis, pictographs, symbols, markdown tokens, and URLs
 * so that Text-to-Speech (TTS) never speaks or reads emojis.
 */
export function stripEmojis(text: string): string {
  if (!text) return '';
  return text
    // Strip Unicode emojis, pictographs, symbols, flags, variation selectors, zero-width joiners
    .replace(/[\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F910}-\u{1F96B}\u{1F980}-\u{1F9E0}\u{2B50}\u{2B55}\u{231A}\u{23F0}\u{23F3}\u{25AA}\u{25AB}\u{25FB}-\u{25FE}\u{FE0E}\u{FE0F}\u{200D}]/gu, '')
    // Strip markdown formatting symbols (hashes, asterisks, underscores, brackets)
    .replace(/[*#_`~\[\]\(\)]/g, ' ')
    // Strip URLs
    .replace(/https?:\/\/\S+/g, '')
    // Normalize spaces
    .replace(/\s+/g, ' ')
    .trim();
}
