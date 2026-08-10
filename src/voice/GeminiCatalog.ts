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
