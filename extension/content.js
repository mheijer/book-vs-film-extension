(() => {
  console.log("[BookVsFilm] Content script loaded");
  const BACKEND_URL = "http://localhost:5000/analyze";
  const SUBTITLE_BUFFER_SECONDS = 180;

  let subtitleBuffer = [];
  let overlayEl = null;
  let subtitleObserver = null;
  let videoEl = null;

  // --- Subtitle collection ---

  function startSubtitleObserver() {
    const observe = () => {
      const container = document.querySelector(".player-timedtext");
      if (!container) return;
      if (subtitleObserver) subtitleObserver.disconnect();

      subtitleObserver = new MutationObserver(() => {
        const lines = Array.from(
          container.querySelectorAll(".player-timedtext-text-container span span")
        )
          .map((el) => el.textContent.trim())
          .filter(Boolean)
          .join(" ");

        if (lines) {
          const now = videoEl ? videoEl.currentTime : 0;
          // Only add if different from the last entry
          const last = subtitleBuffer[subtitleBuffer.length - 1];
          if (!last || last.text !== lines) {
            subtitleBuffer.push({ text: lines, timestamp_seconds: now });
          }
          // Keep only last SUBTITLE_BUFFER_SECONDS seconds
          subtitleBuffer = subtitleBuffer.filter(
            (s) => now - s.timestamp_seconds <= SUBTITLE_BUFFER_SECONDS
          );
        }
      });

      subtitleObserver.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    };

    // Retry until the subtitle container appears
    const interval = setInterval(() => {
      if (document.querySelector(".player-timedtext")) {
        observe();
        clearInterval(interval);
      }
    }, 1000);
  }

  function getSubtitleContext() {
    const now = videoEl ? videoEl.currentTime : 0;
    return subtitleBuffer
      .filter((s) => now - s.timestamp_seconds <= 180)
      .map((s) => s.text)
      .join(" ");
  }

  // --- Metadata extraction ---

  function getMetadata() {
    const title =
      document.querySelector(".video-title h4")?.textContent?.trim() ||
      document.querySelector('[data-uia="video-title"]')?.textContent?.trim() ||
      document.title.replace(" | Netflix", "").trim();

    // Year: look for a 4-digit year in supplemental metadata
    const supplemental = document.querySelector(
      ".VideoMetaData__first-supplemental-message, [data-uia='supplemental-message']"
    )?.textContent;
    const yearMatch = supplemental?.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? parseInt(yearMatch[0]) : null;

    // Type, season, episode
    const seasonEl = document.querySelector("[data-uia='season-number']");
    const episodeEl = document.querySelector("[data-uia='episode-number']");
    const episodeTitleEl = document.querySelector("[data-uia='episode-title']");

    const season = seasonEl ? parseInt(seasonEl.textContent) : null;
    const episode = episodeEl ? parseInt(episodeEl.textContent) : null;
    const episode_title = episodeTitleEl?.textContent?.trim() || null;
    const type = season !== null ? "series" : "movie";

    const runtime_seconds = videoEl?.duration || null;
    const timestamp_seconds = videoEl?.currentTime || 0;

    return {
      title,
      year,
      type,
      season,
      episode,
      episode_title,
      runtime_seconds,
      timestamp_seconds,
    };
  }

  // --- Overlay ---

  function showOverlay() {
    if (overlayEl) return;

    overlayEl = document.createElement("div");
    overlayEl.id = "bvf-overlay";
    overlayEl.textContent = "📖 Compare to book?";
    overlayEl.style.cssText = `
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.75);
      color: white;
      font-family: sans-serif;
      font-size: 14px;
      padding: 10px 18px;
      border-radius: 20px;
      cursor: pointer;
      z-index: 999999;
      border: 1px solid rgba(255,255,255,0.3);
      backdrop-filter: blur(4px);
      transition: opacity 0.2s;
    `;

    overlayEl.addEventListener("mouseenter", () => {
      overlayEl.style.background = "rgba(30, 30, 30, 0.92)";
    });
    overlayEl.addEventListener("mouseleave", () => {
      overlayEl.style.background = "rgba(0, 0, 0, 0.75)";
    });

    overlayEl.addEventListener("click", () => {
      const metadata = getMetadata();
      const subtitle_context = getSubtitleContext();
      const payload = { ...metadata, subtitle_context };

      removeOverlay();

      // Open side panel
      chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" });

      // Send payload to side panel (slight delay for panel to load)
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "ANALYZE", payload });
      }, 600);
    });

    document.body.appendChild(overlayEl);
  }

  function removeOverlay() {
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
  }

  // --- Video event listeners ---

  function attachVideoListeners(video) {
    videoEl = video;

    video.addEventListener("pause", () => {
      // Don't show overlay if video just ended
      if (!video.ended) {
        showOverlay();
      }
    });

    video.addEventListener("play", () => {
      removeOverlay();
      chrome.runtime.sendMessage({ type: "CLOSE_SIDE_PANEL" });
    });

    video.addEventListener("ended", () => {
      removeOverlay();
    });
  }

  // --- Init: wait for video element to appear ---

  function init() {
    const existing = document.querySelector("video");
    if (existing) {
      attachVideoListeners(existing);
      startSubtitleObserver();
      return;
    }

    const observer = new MutationObserver(() => {
      const video = document.querySelector("video");
      if (video) {
        observer.disconnect();
        attachVideoListeners(video);
        startSubtitleObserver();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
