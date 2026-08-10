// ─────────────────────────────────────────────────────────────────────────────
// GeminiCatalog — the choices offered on the setup screen.
//
// Two different kinds of list, handled differently on purpose:
//
//   Voices are a fixed, documented set with no discovery endpoint, so they are
//   tabulated here — transcribed from ai.google.dev/gemini-api/docs/
//   speech-generation, which states 30 options and names each one's character.
//
//   Models change constantly, so they are *not* tabulated. They come from
//   `models.list` filtered on `supportedGenerationMethods` containing
//   `bidiGenerateContent`, which is what a Live session actually needs. Field
//   names confirmed against the v1beta discovery document rather than assumed:
//   Model has `name`, `displayName`, `description` and
//   `supportedGenerationMethods: array<string>`; ListModelsResponse has `models`
//   plus `nextPageToken`; `pageSize` defaults to 50 and caps at 1000.
// ─────────────────────────────────────────────────────────────────────────────

import { geminiGet } from './GeminiKeyCheck';

export interface VoiceOption {
  name: string;
  /** The one-word character Google gives it, shown next to the name. */
  character: string;
}

/**
 * The 30 prebuilt voices. Note the docs' own caveat: the Live API's set is
 * "slightly different" from the one `generateContent` exposes, and it is not
 * enumerated anywhere machine-readable. So a name here can still be refused at
 * session setup — which is why the session error is surfaced rather than
 * swallowed, and why this list is a convenience over the free-text setting, not
 * a guarantee.
 */
export const PREBUILT_VOICES: VoiceOption[] = [
  { name: 'Zephyr', character: 'Bright' },
  { name: 'Puck', character: 'Upbeat' },
  { name: 'Charon', character: 'Informative' },
  { name: 'Kore', character: 'Firm' },
  { name: 'Fenrir', character: 'Excitable' },
  { name: 'Leda', character: 'Youthful' },
  { name: 'Orus', character: 'Firm' },
  { name: 'Aoede', character: 'Breezy' },
  { name: 'Callirrhoe', character: 'Easy-going' },
  { name: 'Autonoe', character: 'Bright' },
  { name: 'Enceladus', character: 'Breathy' },
  { name: 'Iapetus', character: 'Clear' },
  { name: 'Umbriel', character: 'Easy-going' },
  { name: 'Algieba', character: 'Smooth' },
  { name: 'Despina', character: 'Smooth' },
  { name: 'Erinome', character: 'Clear' },
  { name: 'Algenib', character: 'Gravelly' },
  { name: 'Rasalgethi', character: 'Informative' },
  { name: 'Laomedeia', character: 'Upbeat' },
  { name: 'Achernar', character: 'Soft' },
  { name: 'Alnilam', character: 'Firm' },
  { name: 'Schedar', character: 'Even' },
  { name: 'Gacrux', character: 'Mature' },
  { name: 'Pulcherrima', character: 'Forward' },
  { name: 'Achird', character: 'Friendly' },
  { name: 'Zubenelgenubi', character: 'Casual' },
  { name: 'Vindemiatrix', character: 'Gentle' },
  { name: 'Sadachbia', character: 'Lively' },
  { name: 'Sadaltager', character: 'Knowledgeable' },
  { name: 'Sulafat', character: 'Warm' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Language
//
// The Live API documents support for 70 languages but gives no endpoint that
// lists them, and — this is the part that decides the implementation — the Live
// guide states that native audio output models "automatically choose the
// appropriate language and don't support explicitly setting the language code".
//
// So `speechConfig.languageCode` is not the lever here. Sending it risks failing
// setup on exactly the native-audio models the speech-to-speech path needs. The
// lever is the system instruction, which every model family honours, and which
// also fixes the harder half of the problem: an accented speaker whose language
// the model is left to *guess* gets guessed wrong, and the transcript comes back
// as mangled English. Naming the language removes the guess.
// ─────────────────────────────────────────────────────────────────────────────

export interface LanguageOption {
  /** BCP-47, or 'auto'. Stored verbatim in `tara.language`. */
  code: string;
  /** English name, for the picker. */
  label: string;
  /** The language's own name for itself, so a speaker recognises their row. */
  endonym?: string;
}

/**
 * Offered on the setup screen. Not all 70 — a picker nobody can scan is worse
 * than a short list beside a setting that also takes a hand-typed code. Bengali
 * is first after auto-detect because it is the reason this exists.
 */
export const SPOKEN_LANGUAGES: LanguageOption[] = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'bn-IN', label: 'Bengali', endonym: 'বাংলা' },
  { code: 'en-US', label: 'English' },
  { code: 'hi-IN', label: 'Hindi', endonym: 'हिन्दी' },
  { code: 'ur-PK', label: 'Urdu', endonym: 'اردو' },
  { code: 'ar-XA', label: 'Arabic', endonym: 'العربية' },
  { code: 'es-ES', label: 'Spanish', endonym: 'Español' },
  { code: 'fr-FR', label: 'French', endonym: 'Français' },
  { code: 'de-DE', label: 'German', endonym: 'Deutsch' },
  { code: 'pt-BR', label: 'Portuguese', endonym: 'Português' },
  { code: 'ru-RU', label: 'Russian', endonym: 'Русский' },
  { code: 'tr-TR', label: 'Turkish', endonym: 'Türkçe' },
  { code: 'id-ID', label: 'Indonesian', endonym: 'Bahasa Indonesia' },
  { code: 'ta-IN', label: 'Tamil', endonym: 'தமிழ்' },
  { code: 'te-IN', label: 'Telugu', endonym: 'తెలుగు' },
  { code: 'mr-IN', label: 'Marathi', endonym: 'मराठी' },
  { code: 'ja-JP', label: 'Japanese', endonym: '日本語' },
  { code: 'ko-KR', label: 'Korean', endonym: '한국어' },
  { code: 'cmn-CN', label: 'Chinese (Mandarin)', endonym: '中文' },
  { code: 'it-IT', label: 'Italian', endonym: 'Italiano' },
  { code: 'nl-NL', label: 'Dutch', endonym: 'Nederlands' },
  { code: 'pl-PL', label: 'Polish', endonym: 'Polski' },
  { code: 'vi-VN', label: 'Vietnamese', endonym: 'Tiếng Việt' },
  { code: 'th-TH', label: 'Thai', endonym: 'ไทย' },
];

/** The English name for a code, falling back to the code for a hand-typed one. */
export function languageLabel(code: string): string {
  const trimmed = (code || '').trim();
  const known = SPOKEN_LANGUAGES.find((l) => l.code === trimmed);
  return known ? known.label : trimmed;
}

/**
 * The paragraph that turns a general-purpose conversational model into Tara.
 * Two jobs, pulling in different directions, so both are stated outright rather
 * than left to be inferred:
 *
 *   1. Speak the user's language. Under 'auto' the model follows what it hears;
 *      under a fixed code it is told, so a strong accent cannot be mistaken for
 *      a different language.
 *
 *   2. Hand real work to `run_coding_task` rather than attempting it. A model
 *      that cannot see the files will otherwise answer about them anyway, which
 *      is the worst failure available here — it sounds right.
 *
 * The task text is pinned to English even when the conversation is not: it is a
 * prompt for Claude Code, whose codebase, identifiers and own instructions are
 * English.
 */
export function buildSystemInstruction(language: string): string {
  const code = (language || 'auto').trim();
  const name = code === 'auto' ? '' : languageLabel(code);

  const languageRule = name
    ? `This user's language is ${name}. Understand them as ${name} — never as some ` +
      `other language that sounds similar — and reply in ${name}, however strong ` +
      `their accent is and whatever language these instructions are written in. ` +
      `That includes errors and refusals. If they ask you outright to use a ` +
      `different language, do it from that message onward; a request made once is ` +
      `enough and does not have to be repeated.\n` +
      // Without this the rule gets read as being about substance: a request in
      // Bengali came back as a *different answer* rather than the same answer in
      // Bengali. It is a rule about wording only.
      `This line describes the language, not the content: it never means a request ` +
      `should be answered differently, only written differently.`
    : 'Reply in whichever language the user speaks to you in, and switch when ' +
      'they switch. Never answer in a different language from the one you were ' +
      'just addressed in. This is about wording, not substance — the language ' +
      'someone asks in never changes what the right answer is.';

  return [
    'You are Tara, a voice assistant built into VS Code. You are talking with a',
    'developer about the project open in their editor.',
    '',
    languageRule,
    '',
    'You have one tool, run_coding_task. It hands work to Claude Code, an agent',
    'that can actually read and edit the files in this project. You cannot see',
    'those files, so never describe, quote, guess at or summarise the code from',
    'memory — call the tool instead.',
    '',
    'Call it for anything touching the real code: reading it, changing it, fixing',
    'a bug, adding a feature, running tests, reviewing, explaining a particular',
    'file or function. That is most of what this user will say to you. Write the',
    '`task` argument in English, as one clear self-contained instruction, keeping',
    'every detail they gave and adding none they did not — even when the two of',
    'you are speaking another language.',
    '',
    'Say one short sentence before you call it, so they know it started. When the',
    'result comes back, tell them what happened in one or two sentences. Never',
    'read code, file paths or long output aloud; say what changed and let them',
    'read the rest on screen.',
    '',
    'Answer directly, without the tool, only for greetings, small talk, and',
    'questions about what you yourself just did. Keep every spoken reply short —',
    'this is a conversation, not a document.',
  ].join('\n');
}

export interface LiveModelOption {
  /** Bare id, e.g. `gemini-3.1-flash-live-preview`. */
  id: string;
  label: string;
  description?: string;
}

interface RawModel {
  name?: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
}

interface ListModelsResponse {
  models?: RawModel[];
  nextPageToken?: string;
}

/** The generation method a Live (bidirectional) session requires. */
const LIVE_METHOD = 'bidiGenerateContent';

/** `pageSize` maxes out at 1000, so one page is normally the whole catalogue. */
const PAGE_SIZE = 1000;

/** Bounded so a repeated `nextPageToken` cannot spin forever. */
const MAX_PAGES = 5;

/**
 * Models this key can open a Live session with. Returns an empty array on any
 * failure: callers fall back to the configured value rather than presenting an
 * empty picker as if the account had no models.
 */
export async function listLiveModels(apiKey: string): Promise<LiveModelOption[]> {
  const key = apiKey.trim();
  if (!key) {
    return [];
  }

  const options: LiveModelOption[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    if (pageToken) {
      query.set('pageToken', pageToken);
    }
    const res = await geminiGet(`/v1beta/models?${query.toString()}`, key);
    if (res.status !== 200) {
      break;
    }

    let parsed: ListModelsResponse;
    try {
      parsed = JSON.parse(res.body) as ListModelsResponse;
    } catch {
      break;
    }

    for (const model of parsed.models ?? []) {
      if (!model.name || !model.supportedGenerationMethods?.includes(LIVE_METHOD)) {
        continue;
      }
      const id = model.name.replace(/^models\//, '');
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      options.push({
        id,
        // `displayName` is often prettier but sometimes absent, or identical to
        // the id, so the id stays visible either way.
        label: model.displayName && model.displayName !== id ? `${model.displayName} (${id})` : id,
        description: model.description,
      });
    }

    const next = parsed.nextPageToken;
    if (!next || next === pageToken) {
      break;
    }
    pageToken = next;
  }

  // Alphabetical by id. Not "newest first" — the API exposes no release date, and
  // guessing recency from a version string would reorder wrongly the moment the
  // naming scheme changes.
  options.sort((a, b) => a.id.localeCompare(b.id));
  return options;
}
