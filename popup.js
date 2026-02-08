const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const refreshBtn = document.getElementById("refreshBtn");

const statusPill = document.getElementById("statusPill");
const statusText = document.getElementById("statusText");

// const contentIdEl = document.getElementById("contentId");
const pageHostEl = document.getElementById("pageHost");
const transcriptStatusEl = document.getElementById("transcriptStatus");
// const openPageLink = document.getElementById("openPageLink");

const momentsListEl = document.getElementById("momentsList");
const metaHintEl = document.getElementById("metaHint");

const windowSecEl = document.getElementById("windowSec");
const autoLoadTranscriptEl = document.getElementById("autoLoadTranscript");

const errorBox = document.getElementById("errorBox");

const BACKEND_BASE_URL = "http://localhost:3000";

let current = {
  contentId: null,
  pageUrl: null,
  pageHost: null,
};

let summaryData = null;
let transcriptSegments = null; // array of {start,dur,text}
let transcriptLoaded = false;

function setError(msg) {
  console.log("Set error:", msg);
  if (!msg) {
    errorBox.style.display = "none";
    errorBox.textContent = "";
    return;
  }
  errorBox.style.display = "block";
  errorBox.textContent = msg;
}

function setPill(ok, text) {
  statusText.textContent = text;
  statusPill.classList.remove("good", "bad");
  if (ok === true) statusPill.classList.add("good");
  if (ok === false) statusPill.classList.add("bad");
}

function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res);
    });
  });
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

async function getActiveContentFromTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;

  const res = await chrome.tabs
    .sendMessage(tab.id, { type: "GET_ACTIVE_CONTENT" })
    .catch(() => null);

  if (!res?.ok) return null;
  return res; // { contentId, pageUrl, pageHost }
}

async function refreshAuthStatus() {
  const res = await send("AUTH_PEEK");
  console.log("Auth peek:", res);
  if (res?.ok && res.token) {
    setPill(true, "Logged in");
    loginBtn.disabled = true;
    logoutBtn.disabled = false;
  } else {
    setPill(false, "Please log in");
    loginBtn.disabled = false;
    logoutBtn.disabled = true;
  }
}

async function fetchSummary(contentId) {
  const res = await send("API_GET_SUMMARY", { contentId, limit: 50 });
  if (!res?.ok) throw new Error(res?.error || "Please login");
  return res.data;
}

async function fetchTranscriptViaSW(contentId) {
  const res = await send("API_GET_TRANSCRIPT", { contentId });
  if (!res?.ok) {
    throw new Error(
      res?.data?.error || res?.error || "Transcript fetch failed",
    );
  }
  return res?.data?.segments || [];
}

function buildSnippetAround(segments, centerSec, winSec) {
  const start = Math.max(0, centerSec - winSec);
  const end = centerSec + winSec;

  const slice = segments
    .filter((s) => {
      const ss = Number(s.start) || 0;
      const dur = Number(s.dur) || 0;
      const ee = ss + dur;
      return ss <= end && ee >= start;
    })
    .sort((a, b) => (a.start || 0) - (b.start || 0));

  return {
    range: `${fmtTime(start)} – ${fmtTime(end)}`,
    slice,
  };
}

function getYouTubeLinkAt(contentId, seconds) {
  if (!contentId?.startsWith("yt:")) return current.pageUrl || "#";
  const vid = contentId.slice(3);
  return `https://www.youtube.com/watch?v=${encodeURIComponent(vid)}&t=${Math.max(
    0,
    Math.floor(seconds),
  )}s`;
}

function clearList() {
  momentsListEl.innerHTML = "";
}

function renderMoments() {
  clearList();
  setError(null);

  const top = summaryData?.topUp || [];
  const totalBuckets = top.length;

  metaHintEl.textContent = totalBuckets
    ? `${totalBuckets} moments`
    : "No votes yet";

  if (!top.length) {
    momentsListEl.innerHTML = `<div class="muted">No votes yet for this content.</div>`;
    return;
  }

  const winSec = clamp(Number(windowSecEl.value || 5), 2, 30);

  for (const m of top) {
    const t = Number(m.timeBucket || 0);

    const details = document.createElement("details");
    details.className = "moment";

    const summary = document.createElement("summary");

    const left = document.createElement("div");
    left.className = "momentLeft";
    left.innerHTML = `
      <div class="mono">${fmtTime(t)}</div>
      <div class="muted">Window: ±${winSec}s</div>
    `;

    const right = document.createElement("div");
    right.className = "momentRight";
    right.innerHTML = `
      <span class="badge up">▲ ${m.up || 0}</span>
      <span class="badge down">▼ ${m.down || 0}</span>
      <span class="chev">▾</span>
    `;

    summary.appendChild(left);
    summary.appendChild(right);

    const body = document.createElement("div");
    body.className = "momentBody";
    body.innerHTML = `
      <div class="muted">Loading transcript snippet…</div>
    `;

    details.appendChild(summary);
    details.appendChild(body);

    // Lazy-load snippet only when expanded
    details.addEventListener("toggle", async () => {
      if (!details.open) return;

      try {
        // Ensure transcript loaded (or explain why not)
        if (!transcriptLoaded || !Array.isArray(transcriptSegments)) {
          body.innerHTML = `
            <div class="muted">Transcript not loaded.</div>
            <div class="actions">
              <a href="#"><button class="primary" id="loadTrBtn">Load transcript</button></a>
              <a href="${getYouTubeLinkAt(current.contentId, t)}" target="_blank">
                <button>Open @ ${fmtTime(t)}</button>
              </a>
            </div>
          `;

          const loadBtn = body.querySelector("#loadTrBtn");
          loadBtn?.addEventListener("click", async (ev) => {
            ev.preventDefault();
            await ensureTranscriptLoaded(true);
            // re-render snippet after loading
            if (transcriptLoaded && transcriptSegments?.length) {
              const { range, slice } = buildSnippetAround(
                transcriptSegments,
                t,
                winSec,
              );
              body.innerHTML = renderSnippetHtml(range, slice, t);
              wireSnippetActions(body, range, slice, t);
            } else {
              body.innerHTML = `
                <div class="muted">Transcript still unavailable for this content.</div>
                <div class="actions">
                  <a href="${getYouTubeLinkAt(current.contentId, t)}" target="_blank">
                    <button>Open @ ${fmtTime(t)}</button>
                  </a>
                </div>
              `;
            }
          });

          return;
        }

        const { range, slice } = buildSnippetAround(
          transcriptSegments,
          t,
          winSec,
        );
        body.innerHTML = renderSnippetHtml(range, slice, t);
        wireSnippetActions(body, range, slice, t);
      } catch (e) {
        body.innerHTML = `<div class="muted">Failed to load snippet.</div>`;
      }
    });

    momentsListEl.appendChild(details);
  }
}

function renderSnippetHtml(range, slice, t) {
  const rows =
    slice.length === 0
      ? `<div class="muted">No transcript text found in this window.</div>`
      : slice
          .map((s) => {
            const ts = fmtTime(Number(s.start) || 0);
            const txt = escapeHtml(cleanText(s.text));
            return `
              <div style="display:flex; gap:10px; padding:6px 0; border-top:1px solid rgba(255,255,255,0.06);">
                <div class="mono" style="width:54px; color: var(--muted); flex:0 0 auto;">${ts}</div>
                <div style="flex:1; min-width:0;">${txt}</div>
              </div>
            `;
          })
          .join("");

  return `
    <div class="snippetBox">
      <div class="muted mono" style="margin-bottom:6px;">${range}</div>
      <div>${rows}</div>
    </div>

    <div class="actions">
      <a href="${getYouTubeLinkAt(current.contentId, t)}" target="_blank">
        <button class="primary">Open @ ${fmtTime(t)}</button>
      </a>
      <a href="#"><button id="copyBtn">Copy</button></a>
    </div>
  `;
}

function wireSnippetActions(container, range, slice, t) {
  const copyBtn = container.querySelector("#copyBtn");
  copyBtn?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    try {
      const lines = (slice || [])
        .map((s) => `${fmtTime(Number(s.start) || 0)} ${cleanText(s.text)}`)
        .join("\n");
      await navigator.clipboard.writeText(`${range}\n${lines || ""}`.trim());
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 900);
    } catch {
      copyBtn.textContent = "Failed";
      setTimeout(() => (copyBtn.textContent = "Copy"), 900);
    }
  });
}

function decodeEntities(str) {
  // Handles &#39; and also &amp;#39; (double-encoded) by decoding twice
  const t = document.createElement("textarea");
  t.innerHTML = String(str || "");
  const once = t.value;
  t.innerHTML = once;
  return t.value;
}

function cleanText(str) {
  return decodeEntities(str).replace(/\s+/g, " ").trim();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function ensureTranscriptLoaded(force = false) {
  if (!current.contentId) return;
  if (transcriptLoaded && !force) return;

  transcriptStatusEl.textContent = "Loading…";
  try {
    const segs = await fetchTranscriptViaSW(current.contentId);
    transcriptSegments = Array.isArray(segs) ? segs : [];
    transcriptLoaded = true;
    transcriptStatusEl.textContent = transcriptSegments.length
      ? `Loaded (${transcriptSegments.length})`
      : "Empty";
  } catch (e) {
    transcriptSegments = [];
    transcriptLoaded = false;
    transcriptStatusEl.textContent = "Unavailable";
  }
}

async function doRefresh() {
  setError(null);
  clearList();
  metaHintEl.textContent = "Loading…";

  summaryData = null;
  transcriptSegments = null;
  transcriptLoaded = false;

  const info = await getActiveContentFromTab();
  if (!info?.contentId) {
    current = { contentId: null, pageUrl: null, pageHost: null };
    // contentIdEl.textContent = "—";
    pageHostEl.textContent = "—";
    transcriptStatusEl.textContent = "—";
    // openPageLink.href = "#";
    setError("Open a page with a video first (YouTube / HTML5 <video>).");
    metaHintEl.textContent = "—";
    return;
  }

  current = info;

  // contentIdEl.textContent = info.contentId || "—";
  pageHostEl.textContent = info.pageHost || "—";
  // openPageLink.href = info.pageUrl || "#";

  // Load summary
  try {
    summaryData = await fetchSummary(info.contentId);
  } catch (e) {
    setError(e?.message || "Please login.");
    metaHintEl.textContent = "—";
    return;
  }

  // Auto-load transcript if enabled
  if (autoLoadTranscriptEl.value === "yes") {
    await ensureTranscriptLoaded(false);
  } else {
    transcriptStatusEl.textContent = "Not loaded";
  }

  renderMoments();
}

// UI events
loginBtn.addEventListener("click", async () => {
  setError(null);
  setPill(null, "Signing in…");
  const res = await send("AUTH_LOGIN");
  await refreshAuthStatus();
  if (!res?.ok) setError(res?.error || "Login failed");
});

logoutBtn.addEventListener("click", async () => {
  setError(null);
  setPill(null, "Logging out…");
  const res = await send("AUTH_LOGOUT");
  await refreshAuthStatus();
  if (!res?.ok) setError(res?.error || "Logout failed");
});

refreshBtn.addEventListener("click", doRefresh);

// Re-render snippets if window changes
windowSecEl.addEventListener("change", () => {
  if (summaryData) renderMoments();
});

// Initial
(async function init() {
  await refreshAuthStatus();
  await doRefresh();
})();
