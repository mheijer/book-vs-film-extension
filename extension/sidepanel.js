const BACKEND_URL = "https://book-vs-film-extension-production.up.railway.app/analyze";

const loadingEl = document.getElementById("loading");
const noBookEl = document.getElementById("no-book");
const resultsEl = document.getElementById("results");
const headerSubtitle = document.getElementById("header-subtitle");
const sceneDescEl = document.getElementById("scene-description");
const bookPassageEl = document.getElementById("book-passage");
const comparisonRowsEl = document.getElementById("comparison-rows");

function showState(state) {
  const loading = document.getElementById("loading");
  const noBook = document.getElementById("no-book");
  const results = document.getElementById("results");

  loading.style.display = "none";
  noBook.style.display = "none";
  results.style.display = "none";

  if (state === "loading") loading.style.display = "flex";
  if (state === "no-book") noBook.style.display = "block";
  if (state === "results") results.style.display = "block";
}

function formatTimestamp(seconds) {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function ratingClass(rating) {
  if (!rating) return "";
  const r = rating.toLowerCase();
  if (r === "faithful") return "rating-faithful";
  if (r === "modified") return "rating-modified";
  return "rating-different";
}

function renderComparison(comparison) {
  const dims = ["dialogue", "characters", "setting", "timing", "vibe"];
  const labels = {
    dialogue: "Dialogue",
    characters: "Characters",
    setting: "Setting",
    timing: "Timing",
    vibe: "Vibe",
  };

  comparisonRowsEl.innerHTML = "";
  dims.forEach((dim) => {
    const d = comparison[dim];
    if (!d) return;

    const row = document.createElement("div");
    row.className = "comparison-row";

    const dimLabel = document.createElement("div");
    dimLabel.className = "dim-label";
    dimLabel.textContent = labels[dim];

    const dimRight = document.createElement("div");
    dimRight.className = "dim-right";

    const badge = document.createElement("span");
    badge.className = `rating-badge ${ratingClass(d.rating)}`;
    badge.textContent = d.rating;

    const detail = document.createElement("div");
    detail.className = "dim-detail";
    detail.textContent = d.detail;

    dimRight.appendChild(badge);
    dimRight.appendChild(detail);
    row.appendChild(dimLabel);
    row.appendChild(dimRight);
    comparisonRowsEl.appendChild(row);
  });
}

async function analyze(payload) {
  document.getElementById("retry-btn").style.display = "none";
  showState("loading");

  const titleStr = payload.title || "Unknown Title";
  const yearStr = payload.year ? ` (${payload.year})` : "";
  const timeStr = payload.timestamp_seconds
    ? ` · ${formatTimestamp(payload.timestamp_seconds)}`
    : "";
  headerSubtitle.textContent = `${titleStr}${yearStr}${timeStr}`;

  try {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    const data = await res.json();

    if (!data.book_detected) {
      showState("no-book");
      return;
    }

    document.getElementById("scene-description").textContent = data.scene_description || "";
    document.getElementById("book-passage").textContent = data.book_passage || "";

    // Key difference
    const keyDiffBlock = document.getElementById("key-difference-block");
    const keyDiffText = document.getElementById("key-difference-text");
    if (data.key_difference) {
      keyDiffText.textContent = data.key_difference;
      keyDiffBlock.style.display = "block";
    } else {
      keyDiffBlock.style.display = "none";
    }

    // Chapter indicator
    const chapterIndicator = document.getElementById("chapter-indicator");
    const chapterText = document.getElementById("chapter-text");
    if (data.chapter) {
      chapterText.textContent = data.chapter;
      chapterIndicator.style.display = "flex";
    } else {
      chapterIndicator.style.display = "none";
    }

    // Confidence indicator
    const confidence = data.book_confidence || 0;
    const confLabels = { 1: "Guessing", 2: "Limited", 3: "Moderate", 4: "Good", 5: "High" };
    const dotsEl = document.getElementById("confidence-dots");
    dotsEl.innerHTML = Array.from({ length: 5 }, (_, i) =>
      `<div class="confidence-dot ${i < confidence ? `filled-${confidence}` : ""}"></div>`
    ).join("");
    document.getElementById("confidence-text").textContent = confLabels[confidence] || "";

    renderComparison(data.comparison);
    showState("results");
  } catch (err) {
    const isNetworkError = err.message.includes("Failed to fetch") || err.message.includes("NetworkError");
    document.querySelector(".no-book-message").textContent = isNetworkError
      ? "Connection error — the server may be waking up."
      : `Something went wrong: ${err.message}`;
    document.getElementById("retry-btn").style.display = "block";
    showState("no-book");
  }
}

// Retry button
document.getElementById("retry-btn").addEventListener("click", () => {
  document.getElementById("retry-btn").style.display = "none";
  if (lastPayload) analyze(lastPayload);
});

// Manual override form
let lastPayload = null;

document.getElementById("override-submit").addEventListener("click", () => {
  const bookTitle = document.getElementById("override-title").value.trim();
  const author = document.getElementById("override-author").value.trim();
  if (!bookTitle || !lastPayload) return;
  analyze({ ...lastPayload, override_book_title: bookTitle, override_author: author || null });
});

document.getElementById("override-title").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("override-submit").click();
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "ANALYZE") {
    lastPayload = message.payload;
    analyze(message.payload);
  }
  if (message.type === "CLOSE_SIDE_PANEL") {
    window.close();
  }
});
