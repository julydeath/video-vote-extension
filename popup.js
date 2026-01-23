const statusEl = document.getElementById("status");
const videoInfoEl = document.getElementById("videoInfo");
const topListEl = document.getElementById("topList");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const refreshBtn = document.getElementById("refreshBtn");

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

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function getActiveVideoId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try {
    const u = new URL(tab.url);
    if (!u.hostname.includes("youtube.com")) return null;
    return u.searchParams.get("v");
  } catch {
    return null;
  }
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

async function getActiveContentIdFromTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;

  const res = await chrome.tabs
    .sendMessage(tab.id, { type: "GET_ACTIVE_CONTENT" })
    .catch(() => null);

  return res?.ok ? res.contentId : null;
}

function renderTopMoments(topUp = []) {
  topListEl.innerHTML = "";

  if (!topUp.length) {
    topListEl.innerHTML = `<div class="muted">No votes yet for this video.</div>`;
    return;
  }

  for (const b of topUp) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div>
        <div class="mono">${formatTime(b.timeBucket)}</div>
        <div class="muted">bucket ${b.timeBucket}s</div>
      </div>
      <div class="mono">▲ ${b.up} &nbsp; ▼ ${b.down}</div>
    `;
    topListEl.appendChild(div);
  }
}

async function refreshStatus() {
  const res = await send("AUTH_GET_TOKEN");
  if (res?.ok && res.token) {
    statusEl.textContent = "✅ Logged in";
    loginBtn.disabled = true;
    logoutBtn.disabled = false;
  } else {
    statusEl.textContent = "❌ Not logged in";
    loginBtn.disabled = false;
    logoutBtn.disabled = true;
  }
}

async function fetchSummary(contentId) {
  const res = await send("API_GET_SUMMARY", { contentId, limit: 10 });
  if (!res?.ok) throw new Error(res?.error || "Failed");
  return res.data;
}

loginBtn.addEventListener("click", async () => {
  statusEl.textContent = "Signing in...";
  const res = await send("AUTH_LOGIN");
  statusEl.textContent = res?.ok
    ? "✅ Logged in"
    : `❌ ${res?.error || "Login failed"}`;
  await refreshStatus();
});

logoutBtn.addEventListener("click", async () => {
  statusEl.textContent = "Logging out...";
  const res = await send("AUTH_LOGOUT");
  statusEl.textContent = res?.ok
    ? "✅ Logged out"
    : `❌ ${res?.error || "Logout failed"}`;
  await refreshStatus();
});

refreshBtn.addEventListener("click", async () => {
  topListEl.innerHTML = `<div class="muted">Loading…</div>`;

  const info = await getActiveContentFromTab();

  if (!info || !info.contentId) {
    videoInfoEl.textContent = "Open a page with a video (HTML5 <video>) first.";
    topListEl.innerHTML = "";
    return;
  }

  videoInfoEl.textContent = `Content ID: ${info.contentId}`;

  try {
    const data = await fetchSummary(info.contentId);
    renderTopMoments(data.topUp || []);
  } catch (e) {
    topListEl.innerHTML = `<div class="muted">Failed to load summary.</div>`;
  }
});

(async function init() {
  await refreshStatus();
  const videoId = await getActiveVideoId();
  videoInfoEl.textContent = videoId
    ? `Video: ${videoId}`
    : "Open a YouTube video tab first.";
})();
