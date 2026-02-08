// =======================
// Service Worker (MV3)
// - Google auth via chrome.identity
// - Stores token in chrome.storage.local
// - Vote submit, summary fetch
// - YouTube transcript fetched SERVER-SIDE via /api/youtube/transcript/fetch
// =======================

const BACKEND_BASE_URL = "http://localhost:3000";
const STORAGE_KEY = "googleAccessToken";

const VOTE_ENDPOINT = `${BACKEND_BASE_URL}/api/vote`;
const SUMMARY_ENDPOINT = (contentId, limit = 10) =>
  `${BACKEND_BASE_URL}/api/content/${encodeURIComponent(contentId)}/summary?limit=${limit}`;

const YT_REGISTER_ENDPOINT = `${BACKEND_BASE_URL}/api/youtube/register`;
const YT_FETCH_ENDPOINT = `${BACKEND_BASE_URL}/api/youtube/transcript/fetch`;
const TRANSCRIPT_ENDPOINT = (contentId) =>
  `${BACKEND_BASE_URL}/api/content/${encodeURIComponent(contentId)}/transcript`;
const AUTH_DISABLED_KEY = "authDisabled";

const DEBUG = true;
const log = (...args) => DEBUG && console.log("[SW]", ...args);

const inFlight = new Set();
const sessionStore = chrome.storage.session || chrome.storage.local;

// --------------------
// OAuth helpers
// --------------------
function getValidGoogleToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) {
        chrome.identity.getAuthToken({ interactive: true }, (newToken) => {
          if (chrome.runtime.lastError || !newToken) {
            reject(
              chrome.runtime.lastError?.message ||
                "Google authentication failed",
            );
            return;
          }
          resolve(newToken);
        });
      } else {
        resolve(token);
      }
    });
  });
}

async function getStoredToken() {
  const data = await chrome.storage.local.get([STORAGE_KEY]);
  return data[STORAGE_KEY] || null;
}

async function setStoredToken(token) {
  await chrome.storage.local.set({ [STORAGE_KEY]: token });
}

async function clearStoredToken() {
  await chrome.storage.local.remove([STORAGE_KEY]);
}

function getTokenInteractive() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(chrome.runtime.lastError?.message || "Login failed");
        return;
      }
      resolve(token);
    });
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

async function hardLogout() {
  const token = await getStoredToken();
  if (token) await removeCachedToken(token);
  await clearStoredToken();
  await new Promise((resolve) =>
    chrome.identity.clearAllCachedAuthTokens(resolve),
  );
}

// --------------------
// Main message handler
// --------------------
async function handleMessage(msg, sender) {
  // AUTH
  if (msg?.type === "AUTH_PEEK") {
    const token = await getStoredToken();
    return { ok: true, token: token || null };
  }

  if (msg?.type === "AUTH_LOGIN") {
    const token = await getTokenInteractive();
    await setStoredToken(token);
    return { ok: true, token };
  }

  if (msg?.type === "AUTH_GET_TOKEN") {
    const token = await getStoredToken();
    return { ok: true, token: token || null };
  }

  if (msg?.type === "AUTH_LOGOUT") {
    await hardLogout();
    return { ok: true };
  }

  // VOTE
  if (msg?.type === "VOTE_SUBMIT") {
    const token = await getStoredToken();
    if (!token) return { ok: false, error: "Not logged in" };

    const res = await fetch(VOTE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(msg.payload),
    });

    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data: json };
  }

  // SUMMARY
  if (msg?.type === "API_GET_SUMMARY") {
    const { contentId, limit } = msg.payload || {};
    if (!contentId) return { ok: false, error: "Missing contentId" };

    console.log("token?", await getStoredToken());
    const token = await getStoredToken();
    if (!token) return { ok: false, error: "Not logged in" };

    const res = await fetch(SUMMARY_ENDPOINT(contentId, limit || 10), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data: json };
  }

  // TRANSCRIPT (protected; must send Bearer token)
  if (msg?.type === "API_GET_TRANSCRIPT") {
    const { contentId } = msg.payload || {};
    if (!contentId) return { ok: false, error: "Missing contentId" };

    const token = await getStoredToken();
    if (!token) return { ok: false, error: "Not logged in" };

    const res = await fetch(TRANSCRIPT_ENDPOINT(contentId), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data: json };
  }

  // YT REGISTER + SERVER FETCH (once per contentId per session)
  if (msg?.type === "YT_REGISTER") {
    const payload = msg.payload || {};
    const contentId = payload.contentId;

    if (!contentId) return { ok: false, error: "Missing contentId" };

    const metaKey = `yt_meta_done:${contentId}`;
    const fetchedKey = `yt_fetched:${contentId}`;
    const backoffKey = `yt_backoff:${contentId}`;

    // already fetched this session
    const fetchedState = await sessionStore.get([fetchedKey]);
    if (fetchedState[fetchedKey]) {
      return { ok: true, skipped: true, reason: "already_fetched_session" };
    }

    // backoff (e.g. if server got rate-limited)
    const backoff = await sessionStore.get([backoffKey]);
    if (backoff[backoffKey]) {
      return { ok: true, skipped: true, reason: "backoff" };
    }

    if (inFlight.has(contentId)) {
      return { ok: true, skipped: true, reason: "in_flight" };
    }
    inFlight.add(contentId);

    try {
      const token = await getStoredToken();
      if (!token) return { ok: false, error: "Not logged in" };

      // 1) Register metadata once
      const metaState = await sessionStore.get([metaKey]);
      let metaJson = null;

      if (!metaState[metaKey]) {
        log("YT meta register:", contentId);

        const metaRes = await fetch(YT_REGISTER_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });

        metaJson = await metaRes.json().catch(() => null);
        await sessionStore.set({ [metaKey]: true });

        if (!metaRes.ok) {
          return { ok: false, status: metaRes.status, data: metaJson };
        }

        if (metaJson?.alreadyFetched) {
          await sessionStore.set({ [fetchedKey]: true });
          return {
            ok: true,
            reason: "already_fetched_backend",
            data: metaJson,
          };
        }
      }

      // If no caption track found, don’t fetch server-side either
      // (optional: you can STILL try server-side fetch even without baseUrl; your call)
      if (payload?.captionBaseUrl == null) {
        await sessionStore.set({ [fetchedKey]: true });
        return { ok: false, error: "No caption track found for this video" };
      }

      // 2) Ask SERVER to fetch and store transcript
      log("YT server fetch:", contentId);

      const fetchRes = await fetch(YT_FETCH_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ contentId }),
      });

      const fetchJson = await fetchRes.json().catch(() => null);

      if (!fetchRes.ok) {
        // If server is rate-limited or blocked, stop spamming for this session
        if (fetchRes.status === 429 || fetchRes.status === 403) {
          await sessionStore.set({ [backoffKey]: true });
        }
        return { ok: false, status: fetchRes.status, data: fetchJson };
      }

      await sessionStore.set({ [fetchedKey]: true });
      return { ok: true, reason: "fetched_server", data: fetchJson };
    } finally {
      inFlight.delete(contentId);
    }
  }

  return { ok: false, error: "Unknown message type" };
}

// Listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const res = await handleMessage(msg, sender);
      sendResponse(res);
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});
