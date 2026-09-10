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

/**
 * Normalizes speech recognition text and removes consecutive repeated words or phrases
 * across all languages (Kannada, Hindi, English).
 */
export function cleanSpeechTranscript(text: string): string {
  if (!text) return '';
  
  // 1. Normalize spaces and whitespace
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';

  // 2. Tokenize by spaces (preserves full Unicode characters for Kannada & Hindi)
  const tokens = clean.split(' ').filter(Boolean);
  if (tokens.length <= 1) return clean;

  // 3. Remove consecutive duplicate words
  const deduplicatedWords: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const current = tokens[i];
    const prev = deduplicatedWords[deduplicatedWords.length - 1];
    
    // Normalize for comparison (lowercase & strip outer punctuation)
    const normCurrent = current.toLowerCase().replace(/^[.,!?;:()]+|[.,!?;:()]+$/g, '');
    const normPrev = prev ? prev.toLowerCase().replace(/^[.,!?;:()]+|[.,!?;:()]+$/g, '') : null;
    
    if (normCurrent && normCurrent === normPrev) {
      continue; // Skip duplicate word
    }
    deduplicatedWords.push(current);
  }

  // 4. Remove consecutive duplicate phrases (phrase lengths 4, 3, 2)
  let words = deduplicatedWords;
  for (let phraseLen = 4; phraseLen >= 2; phraseLen--) {
    let changed = true;
    while (changed) {
      changed = false;
      if (words.length < phraseLen * 2) break;
      for (let i = 0; i <= words.length - phraseLen * 2; i++) {
        const phrase1 = words.slice(i, i + phraseLen).map(w => w.toLowerCase().replace(/^[.,!?;:()]+|[.,!?;:()]+$/g, '')).join(' ');
        const phrase2 = words.slice(i + phraseLen, i + phraseLen * 2).map(w => w.toLowerCase().replace(/^[.,!?;:()]+|[.,!?;:()]+$/g, '')).join(' ');
        if (phrase1 && phrase1 === phrase2) {
          // Remove the duplicate phrase
          words.splice(i + phraseLen, phraseLen);
          changed = true;
          break;
        }
      }
    }
  }

  return words.join(' ').trim();
}

/**
 * Merges a session prefix and incoming new transcript without seam duplication
 */
export function mergeTranscripts(prefix: string, newText: string): string {
  const p = prefix.trim();
  const n = newText.trim();
  if (!p) return cleanSpeechTranscript(n);
  if (!n) return cleanSpeechTranscript(p);

  const pWords = p.split(/\s+/).filter(Boolean);
  const nWords = n.split(/\s+/).filter(Boolean);

  // Check if tail of prefix overlaps with head of newText
  let maxOverlap = 0;
  const maxCheck = Math.min(pWords.length, nWords.length, 6);
  for (let len = maxCheck; len >= 1; len--) {
    const pTail = pWords.slice(pWords.length - len).map(w => w.toLowerCase().replace(/^[.,!?;:()]+|[.,!?;:()]+$/g, '')).join(' ');
    const nHead = nWords.slice(0, len).map(w => w.toLowerCase().replace(/^[.,!?;:()]+|[.,!?;:()]+$/g, '')).join(' ');
    if (pTail && pTail === nHead) {
      maxOverlap = len;
      break;
    }
  }

  let merged = '';
  if (maxOverlap > 0) {
    merged = pWords.concat(nWords.slice(maxOverlap)).join(' ');
  } else {
    merged = p + ' ' + n;
  }

  return cleanSpeechTranscript(merged);
}

