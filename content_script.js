// =======================
// Content Script
// - Overlay ▲/▼ on any HTML5 <video>
// - Vote submit via service worker
// - On YouTube: extract caption baseUrl and trigger transcript ingestion ONLY on vote
// - Provides GET_ACTIVE_CONTENT for popup
// - Provides REQUEST_GOOGLE_TOKEN bridge for dashboard
// =======================

const IS_TOP_FRAME = window.top === window;

let overlayEl = null;
let toastEl = null;
let activeVideo = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function showToast(text) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.id = "yt-votes-toast";
    document.documentElement.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 1100);
}

function sendToSW(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res);
    });
  });
}

// -----------------------
// Video detection
// -----------------------
function getBestVideoElement() {
  if (activeVideo && document.contains(activeVideo)) return activeVideo;

  const vids = Array.from(document.querySelectorAll("video"));
  if (!vids.length) return null;

  const visible = vids.find((v) => {
    const r = v.getBoundingClientRect();
    return (
      r.width > 160 &&
      r.height > 120 &&
      r.bottom > 0 &&
      r.top < window.innerHeight &&
      r.right > 0 &&
      r.left < window.innerWidth
    );
  });

  return visible || vids[0] || null;
}

function getPageUrl() {
  return location.href.split("#")[0];
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getContentId(videoEl) {
  // YouTube stable id
  try {
    const u = new URL(location.href);
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return `yt:${v}`;
    }
  } catch {}

  const pageUrl = getPageUrl();
  const src = videoEl?.currentSrc || videoEl?.src || "";
  const base = `${location.host}|${pageUrl}|${src}`;
  const hash = await sha256Hex(base);
  return `web:${location.host}:${hash.slice(0, 16)}`;
}

// -----------------------
// Overlay UI
// -----------------------
function createOverlay() {
  if (overlayEl) return overlayEl;

  overlayEl = document.createElement("div");
  overlayEl.id = "yt-votes-overlay";

  const upBtn = document.createElement("button");
  upBtn.className = "yt-votes-btn";
  upBtn.textContent = "▲";
  upBtn.title = "Upvote this moment";
  upBtn.addEventListener("click", () => postVote("UP"));

  const downBtn = document.createElement("button");
  downBtn.className = "yt-votes-btn";
  downBtn.textContent = "▼";
  downBtn.title = "Downvote this moment";
  downBtn.addEventListener("click", () => postVote("DOWN"));

  overlayEl.appendChild(upBtn);
  overlayEl.appendChild(downBtn);
  return overlayEl;
}

function positionOverlay() {
  const video = getBestVideoElement();
  if (!video || !overlayEl) return;

  const rect = video.getBoundingClientRect();
  overlayEl.style.left = `${window.scrollX + rect.right - 56}px`;
  overlayEl.style.top = `${window.scrollY + rect.top + 18}px`;
}

function attachOverlay() {
  const video = getBestVideoElement();
  if (!video) return false;

  if (!overlayEl) createOverlay();
  if (!overlayEl.isConnected) document.documentElement.appendChild(overlayEl);

  positionOverlay();
  return true;
}

async function initOverlayForPage() {
  for (let i = 0; i < 20; i++) {
    if (attachOverlay()) break;
    await sleep(250);
  }
}

function watchResizeScroll() {
  window.addEventListener("resize", positionOverlay);
  window.addEventListener("scroll", positionOverlay, { passive: true });
}

// -----------------------
// YouTube caption track extraction
// -----------------------
function extractJsonObjectAfter(text, marker) {
  const idx = text.indexOf(marker);
  if (idx < 0) return null;

  const start = text.indexOf("{", idx);
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const jsonStr = text.slice(start, i + 1);
        try {
          return JSON.parse(jsonStr);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function getYouTubePlayerResponse() {
  if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;

  const args = window.ytplayer?.config?.args;
  if (args?.raw_player_response) return args.raw_player_response;

  if (args?.player_response && typeof args.player_response === "string") {
    try {
      return JSON.parse(args.player_response);
    } catch {}
  }

  for (const s of document.scripts) {
    const t = s.textContent || "";
    if (!t.includes("ytInitialPlayerResponse")) continue;
    const obj = extractJsonObjectAfter(t, "ytInitialPlayerResponse");
    if (obj) return obj;
  }
  return null;
}

function getCaptionTracksFromPlayerResponse(pr) {
  return pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
}

function pickBestTrack(tracks, preferredLang = "en") {
  if (!tracks.length) return null;
  const manual = tracks.filter((t) => t.kind !== "asr");
  const pool = manual.length ? manual : tracks;
  return (
    pool.find((t) => t.languageCode === preferredLang) ||
    pool.find((t) => (t.languageCode || "").startsWith(preferredLang)) ||
    pool[0]
  );
}

function getYouTubeVideoId() {
  try {
    const u = new URL(location.href);
    if (!u.hostname.includes("youtube.com")) return null;
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

// Only attempt transcript once per video per tab session
let ytAttemptedForVideo = new Set();

async function ensureYouTubeTranscriptOnDemand() {
  if (!IS_TOP_FRAME) return;
  if (!location.hostname.includes("youtube.com")) return;

  const vid = getYouTubeVideoId();
  if (!vid) return;

  const contentId = `yt:${vid}`;
  if (ytAttemptedForVideo.has(contentId)) return;
  ytAttemptedForVideo.add(contentId);

  // must be logged in
  const auth = await sendToSW({ type: "AUTH_GET_TOKEN" });
  if (!auth?.ok || !auth?.token) return;

  const pr = getYouTubePlayerResponse();
  const tracks = getCaptionTracksFromPlayerResponse(pr);
  const track = pickBestTrack(tracks, "en");

  const payload = {
    contentId,
    captionBaseUrl: track?.baseUrl || null,
    captionLanguage: track?.languageCode || null,
    captionIsAuto:
      track?.kind === "asr" || /[?&]caps=asr/.test(track?.baseUrl || ""),
    title: pr?.videoDetails?.title || null,
    channelName: pr?.videoDetails?.author || null,
    pageUrl: getPageUrl(),
    pageHost: location.host,
  };

  const res = await sendToSW({ type: "YT_REGISTER", payload });

  if (
    !res?.ok &&
    (res?.debug?.status === 429 || `${res?.error || ""}`.includes("429"))
  ) {
    showToast("YouTube captions rate-limited (429). Try later.");
  }
}

// -----------------------
// Vote submit
// -----------------------
async function postVote(voteType) {
  const video = getBestVideoElement();
  if (!video) {
    showToast("No video found on this page");
    return;
  }

  const timeSeconds = video.currentTime || 0;
  const contentId = await getContentId(video);

  showToast(
    `${voteType === "UP" ? "▲" : "▼"} Saved @ ${formatTime(timeSeconds)}`,
  );

  const res = await sendToSW({
    type: "VOTE_SUBMIT",
    payload: {
      contentId,
      pageUrl: getPageUrl(),
      pageHost: location.host,
      timeSeconds,
      vote: voteType,
    },
  });

  if (!res?.ok) {
    console.error("Vote failed:", res);
    showToast("Save failed (check backend)");
    return;
  }

  // Only when user votes on YouTube do we attempt transcript (prevents spam)
  ensureYouTubeTranscriptOnDemand();
}

// -----------------------
// Popup support: GET_ACTIVE_CONTENT
// Only respond from frames that contain <video>
// -----------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "GET_ACTIVE_CONTENT") return;

  (async () => {
    const video = getBestVideoElement();
    if (!video) return; // don't respond from non-video frames

    const contentId = await getContentId(video);
    sendResponse({
      ok: true,
      contentId,
      pageUrl: getPageUrl(),
      pageHost: location.host,
    });
  })();

  return true;
});

// -----------------------
// Dashboard token bridge
// -----------------------
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== "REQUEST_GOOGLE_TOKEN") return;

  console.log("[EXT] Dashboard requested token");

  chrome.runtime.sendMessage({ type: "AUTH_GET_TOKEN" }, (res) => {
    console.log("[EXT] Token response from SW:", res);

    window.postMessage(
      {
        type: "GOOGLE_TOKEN_RESPONSE",
        token: res?.ok ? res.token : null,
        error: res?.ok ? null : res?.error || "no_token",
      },
      "*",
    );
  });
});

// Track activeVideo on interaction
document.addEventListener(
  "play",
  (e) => {
    if (e.target && e.target.tagName === "VIDEO") {
      activeVideo = e.target;
      attachOverlay();
      positionOverlay();
    }
  },
  true,
);

document.addEventListener(
  "pointerover",
  (e) => {
    const v = e.target?.closest?.("video");
    if (v) {
      activeVideo = v;
      attachOverlay();
      positionOverlay();
    }
  },
  true,
);

// Start
initOverlayForPage();
watchResizeScroll();
