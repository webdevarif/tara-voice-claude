// ─────────────────────────────────────────────────────────────────────────────
// GeminiKeyCheck — proves an API key works before it is stored.
//
// Storing an unverified key means the first failure surfaces much later, as a
// WebSocket close code from the Live API, at the moment the user is holding the
// push-to-talk button. One cheap REST call up front turns that into a sentence
// on the setup screen.
//
// Verified against the live service (2026-08-10):
//
//   GET /v1beta/models  with x-goog-api-key: <garbage>
//     → 400 {"error":{"code":400,"message":"API key not valid. Please pass a
//        valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":
//        "API_KEY_INVALID",…}]}}
//
//   GET /v1beta/models  with no key at all
//     → 403 {"error":{"code":403,"message":"Method doesn't allow unregistered
//        callers …","status":"PERMISSION_DENIED"}}
//
// The key travels in the `x-goog-api-key` header, never the query string, so it
// cannot end up in a proxy or server access log.
// ─────────────────────────────────────────────────────────────────────────────

import * as https from 'https';

const HOST = 'generativelanguage.googleapis.com';
const TIMEOUT_MS = 12000;

/** Enough for a full page of model descriptors; anything larger is not ours. */
const MAX_BODY_BYTES = 512 * 1024;

export interface KeyCheckResult {
  /** True only when the key was *proven* usable. Never true on a guess. */
  ok: boolean;
  /**
   * False when the request never reached Google. Distinct from `ok: false`,
   * which means the service answered and rejected the key — an offline user
   * must not be told their key is invalid.
   */
  reachable: boolean;
  /** Human-facing reason, safe to show verbatim. Never contains the key. */
  message?: string;
  /**
   * Set when the key is valid but the configured Live model could not be
   * confirmed. Advisory only: model listings and preview availability move
   * around, so this must never block saving a working key.
   */
  modelWarning?: string;
}

interface HttpResult {
  status?: number;
  body: string;
  networkError?: string;
}

function get(path: string, apiKey: string): Promise<HttpResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HttpResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const req = https.request(
      {
        host: HOST,
        path,
        method: 'GET',
        headers: {
          'x-goog-api-key': apiKey,
          accept: 'application/json',
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        let overflowed = false;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (body.length + chunk.length > MAX_BODY_BYTES) {
            overflowed = true;
            res.destroy();
            return;
          }
          body += chunk;
        });
        res.on('end', () => finish({ status: res.statusCode, body }));
        res.on('error', (err: Error) =>
          finish(
            overflowed
              ? { status: res.statusCode, body }
              : { body: '', networkError: err.message }
          )
        );
      }
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ body: '', networkError: `no response from ${HOST} within 12s` });
    });
    req.on('error', (err: Error) => finish({ body: '', networkError: err.message }));
    req.end();
  });
}

interface GoogleError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ reason?: string }>;
  };
}

function parseError(body: string): { message?: string; reason?: string } {
  try {
    const parsed = JSON.parse(body) as GoogleError;
    const reason = parsed.error?.details?.find((d) => d.reason)?.reason;
    return { message: parsed.error?.message, reason };
  } catch {
    return {};
  }
}

/** Strips a `models/` prefix so both `models/x` and `x` are accepted. */
function bareModelId(model: string): string {
  return model.trim().replace(/^models\//i, '');
}

/**
 * Confirms the key is accepted by the Gemini API, and separately tries to
 * confirm the Live model exists. Only the first of those can fail the check.
 */
export async function verifyGeminiKey(
  apiKey: string,
  liveModel?: string
): Promise<KeyCheckResult> {
  const key = apiKey.trim();
  if (!key) {
    return { ok: false, reachable: true, message: 'Enter a key first.' };
  }

  // `models.list` is the authoritative check: it is a known-good route, so an
  // unexpected status from it is a real signal rather than a wrong guess about
  // which endpoints exist.
  const list = await get('/v1beta/models', key);

  if (list.networkError) {
    return {
      ok: false,
      reachable: false,
      message: `Could not reach Google to verify the key — ${list.networkError}.`,
    };
  }

  if (list.status !== 200) {
    const { message, reason } = parseError(list.body);
    if (reason === 'API_KEY_INVALID' || list.status === 400) {
      return {
        ok: false,
        reachable: true,
        message: message ?? 'That key was rejected: API key not valid.',
      };
    }
    if (list.status === 403) {
      return {
        ok: false,
        reachable: true,
        message:
          message ??
          'That key was rejected. Check that the Generative Language API is enabled for its project.',
      };
    }
    if (list.status === 429) {
      return {
        ok: false,
        reachable: true,
        message:
          message ?? 'The key is rate limited right now, so it could not be verified. Try again.',
      };
    }
    // 5xx is Google having a bad day, not a bad key — do not condemn the key.
    return {
      ok: false,
      reachable: list.status !== undefined && list.status < 500,
      message: message ?? `Verification failed with HTTP ${list.status ?? '?'}.`,
    };
  }

  const result: KeyCheckResult = { ok: true, reachable: true };

  const model = bareModelId(liveModel ?? '');
  if (model) {
    const one = await get(`/v1beta/models/${encodeURIComponent(model)}`, key);
    // Only a definite 404 is worth reporting. Any other outcome — including a
    // network blip on this second call — leaves the hint off rather than
    // inventing a problem.
    if (one.status === 404) {
      result.modelWarning =
        `Key is valid, but the model "${model}" was not found for it. ` +
        'Voice will fail until "tara.geminiLiveModel" names a model your key can use.';
    }
  }

  return result;
}
