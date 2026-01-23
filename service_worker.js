// =======================
// Service Worker (MV3)
// - Google auth via chrome.identity
// - Stores token in chrome.storage.local for compatibility
// - Vote submit, summary fetch
// - YouTube transcript fetch (executed in MAIN world to reduce 429)
// =======================

const BACKEND_BASE_URL = "http://localhost:3000";
const STORAGE_KEY = "googleAccessToken";

const VOTE_ENDPOINT = `${BACKEND_BASE_URL}/api/vote`;
const SUMMARY_ENDPOINT = (contentId, limit = 10) =>
  `${BACKEND_BASE_URL}/api/content/${encodeURIComponent(
    contentId,
  )}/summary?limit=${limit}`;

const YT_REGISTER_ENDPOINT = `${BACKEND_BASE_URL}/api/youtube/register`;
const YT_UPLOAD_ENDPOINT = `${BACKEND_BASE_URL}/api/youtube/transcript/upload`;

const DEBUG = true;
const log = (...args) => DEBUG && console.log("[SW]", ...args);

// Prevent duplicate work
const inFlight = new Set();
const sessionStore = chrome.storage.session || chrome.storage.local;

// --------------------
// OAuth helpers
// --------------------

function getValidGoogleToken() {
  return new Promise((resolve, reject) => {
    // silent first (refresh)
    chrome.identity.getAuthToken({ interactive: false }, async (token) => {
      if (chrome.runtime.lastError || !token) {
        // fallback to interactive
        chrome.identity.getAuthToken(
          { interactive: true },
          async (newToken) => {
            if (chrome.runtime.lastError || !newToken) {
              reject(
                chrome.runtime.lastError?.message ||
                  "Google authentication failed",
              );
              return;
            }
            resolve(newToken);
          },
        );
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

function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

// --------------------
// Fetch transcript INSIDE TAB (MAIN world)
// --------------------
function executeInMainWorld(tabId, baseUrl) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        world: "MAIN",
        args: [baseUrl],
        func: async (baseUrlArg) => {
          function buildUrl(baseUrl, fmt) {
            const u = new URL(baseUrl);
            u.searchParams.set("fmt", fmt);
            return u.toString();
          }

          function parseJson3ToSegments(data) {
            const events = data?.events || [];
            return events
              .filter((e) => e.segs && typeof e.tStartMs === "number")
              .map((e) => ({
                start: Math.floor(e.tStartMs / 1000),
                dur: Math.floor((e.dDurationMs || 0) / 1000),
                text: (e.segs || [])
                  .map((s) => s.utf8 || "")
                  .join("")
                  .replace(/\s+/g, " ")
                  .trim(),
              }))
              .filter((s) => s.text);
          }

          function toSeconds(ts) {
            const parts = (ts || "").split(":");
            let h = 0,
              m = 0,
              s = 0;
            if (parts.length === 3) {
              h = Number(parts[0]) || 0;
              m = Number(parts[1]) || 0;
              s = Number(parts[2]) || 0;
            } else {
              m = Number(parts[0]) || 0;
              s = Number(parts[1]) || 0;
            }
            return h * 3600 + m * 60 + s;
          }

          function parseVttToSegments(vttText) {
            const text = (vttText || "").replace(/\r/g, "");
            const lines = text.split("\n");

            const segments = [];
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              if (line.includes("-->")) {
                const [a, b] = line.split("-->").map((x) => x.trim());
                const startStr = a.split(" ")[0];
                const endStr = b.split(" ")[0];

                const start = Math.floor(toSeconds(startStr));
                const end = Math.floor(toSeconds(endStr));
                const dur = Math.max(0, end - start);

                const buf = [];
                i++;
                while (i < lines.length && lines[i].trim() !== "") {
                  buf.push(lines[i].trim());
                  i++;
                }

                const cueText = buf.join(" ").replace(/\s+/g, " ").trim();
                if (cueText) segments.push({ start, dur, text: cueText });
              }
            }
            return segments;
          }

          async function tryJson3() {
            const url = buildUrl(baseUrlArg, "json3");
            const res = await fetch(url, { credentials: "include" });
            const status = res.status;
            const raw = await res.text().catch(() => "");

            if (!res.ok) {
              return {
                ok: false,
                status,
                format: "json3",
                snippet: raw.slice(0, 200),
              };
            }

            // sometimes JSON is returned as text/plain
            try {
              const parsed = JSON.parse(raw);
              const segments = parseJson3ToSegments(parsed);
              return { ok: true, status, format: "json3", segments };
            } catch {
              return {
                ok: false,
                status,
                format: "json3",
                snippet: raw.slice(0, 200),
              };
            }
          }

          async function tryVtt() {
            const url = buildUrl(baseUrlArg, "vtt");
            const res = await fetch(url, { credentials: "include" });
            const status = res.status;
            const vtt = await res.text().catch(() => "");

            if (!res.ok) {
              return {
                ok: false,
                status,
                format: "vtt",
                snippet: vtt.slice(0, 200),
              };
            }

            const segments = parseVttToSegments(vtt);
            return { ok: true, status, format: "vtt", segments };
          }

          const j = await tryJson3();
          if (j.ok && j.segments?.length) return j;

          const v = await tryVtt();
          if (v.ok && v.segments?.length) return v;

          // prefer 429 error to help backoff
          if (!j.ok && j.status === 429) return j;
          if (!v.ok && v.status === 429) return v;

          return j.ok ? v : j;
        },
      },
      (results) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        const first = results?.[0]?.result;
        resolve(
          first || { ok: false, error: "No result returned from MAIN world" },
        );
      },
    );
  });
}

// --------------------
// Main message handler (returns object; listener sends it)
// --------------------
async function handleMessage(msg, sender) {
  // AUTH
  if (msg?.type === "AUTH_LOGIN") {
    try {
      const token = await getValidGoogleToken();
      await setStoredToken(token);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  if (msg?.type === "AUTH_GET_TOKEN") {
    try {
      const token = await getValidGoogleToken();
      await setStoredToken(token);
      return { ok: true, token };
    } catch (e) {
      return { ok: false, error: "Not authenticated" };
    }
  }

  if (msg?.type === "AUTH_LOGOUT") {
    try {
      const token = await getStoredToken();
      if (token) await removeCachedToken(token);
      await chrome.storage.local.remove([STORAGE_KEY]);
      // optional extra cleanup
      await new Promise((resolve) =>
        chrome.identity.clearAllCachedAuthTokens(resolve),
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
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

    const res = await fetch(SUMMARY_ENDPOINT(contentId, limit || 10));
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data: json };
  }

  // YT REGISTER + TRANSCRIPT UPLOAD (once per contentId per session)
  if (msg?.type === "YT_REGISTER") {
    const payload = msg.payload || {};
    const contentId = payload.contentId;
    const baseUrl = payload.captionBaseUrl || null;

    if (!contentId) return { ok: false, error: "Missing contentId" };

    const tabId = sender?.tab?.id;
    if (!tabId) return { ok: false, error: "Missing sender tab id" };

    const metaKey = `yt_meta_done:${contentId}`;
    const upKey = `yt_uploaded:${contentId}`;
    const backoffKey = `yt_backoff:${contentId}`;

    // already uploaded this session
    const upState = await sessionStore.get([upKey]);
    if (upState[upKey]) {
      return { ok: true, skipped: true, reason: "already_uploaded_session" };
    }

    // backoff if 429 hit
    const backoff = await sessionStore.get([backoffKey]);
    if (backoff[backoffKey]) {
      return { ok: true, skipped: true, reason: "backoff_429" };
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

        const metaJson = await metaRes.json().catch(() => null);
        await sessionStore.set({ [metaKey]: true });

        if (!metaRes.ok)
          return { ok: false, status: metaRes.status, data: metaJson };

        if (metaJson?.alreadyFetched) {
          await sessionStore.set({ [upKey]: true });
          return {
            ok: true,
            reason: "already_fetched_backend",
            data: metaJson,
          };
        }
      }

      // No caption track
      if (!baseUrl) {
        await sessionStore.set({ [upKey]: true });
        return { ok: false, error: "No caption track found on this video" };
      }

      // 2) Fetch transcript in MAIN world
      log("YT timedtext fetch MAIN:", contentId);
      const tr = await executeInMainWorld(tabId, baseUrl);

      if (!tr?.ok) {
        if (tr?.status === 429) {
          await sessionStore.set({ [backoffKey]: true });
          return {
            ok: false,
            error: "YouTube captions rate-limited (429).",
            debug: tr,
          };
        }
        return { ok: false, error: "Failed to fetch transcript.", debug: tr };
      }

      const segments = tr.segments || [];
      if (!segments.length) {
        return { ok: false, error: "Transcript empty.", debug: tr };
      }

      // 3) Upload transcript
      log("YT upload:", contentId, segments.length);

      const upRes = await fetch(YT_UPLOAD_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ contentId, segments }),
      });

      const upJson = await upRes.json().catch(() => null);
      if (!upRes.ok) return { ok: false, status: upRes.status, data: upJson };

      await sessionStore.set({ [upKey]: true });
      return {
        ok: true,
        reason: "uploaded",
        status: upRes.status,
        data: upJson,
      };
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
