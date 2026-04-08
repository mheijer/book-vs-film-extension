(() => {
  console.log("[BookVsFilm] Content script loaded");
  const SUBTITLE_BUFFER_SECONDS = 180;

  let subtitleBuffer = [];
  let overlayEl = null;
  let subtitleObserver = null;
  let videoEl = null;

  // --- Platform detection ---

  const PLATFORM = (() => {
    const h = window.location.hostname;
    if (h.includes("netflix.com")) return "netflix";
    if (h.includes("hbomax.com") || h.includes("max.com")) return "hbomax";
    return "unknown";
  })();

  // --- Platform configs ---

  const PLATFORM_CONFIG = {
    netflix: {
      subtitleContainer: () => document.querySelector(".player-timedtext"),
      subtitleText: (container) =>
        Array.from(container.querySelectorAll(".player-timedtext-text-container span span"))
          .map((el) => el.textContent.trim())
          .filter(Boolean)
          .join(" "),
      getMetadata: () => {
        const title =
          document.querySelector(".video-title h4")?.textContent?.trim() ||
          document.querySelector('[data-uia="video-title"]')?.textContent?.trim() ||
          document.title.replace(/ \| Netflix$/, "").trim();

        const supplemental = document.querySelector(
          ".VideoMetaData__first-supplemental-message, [data-uia='supplemental-message']"
        )?.textContent;
        const yearMatch = supplemental?.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? parseInt(yearMatch[0]) : null;

        const seasonEl = document.querySelector("[data-uia='season-number']");
        const episodeEl = document.querySelector("[data-uia='episode-number']");
        const episodeTitleEl = document.querySelector("[data-uia='episode-title']");
        const season = seasonEl ? parseInt(seasonEl.textContent) : null;
        const episode = episodeEl ? parseInt(episodeEl.textContent) : null;
        const episode_title = episodeTitleEl?.textContent?.trim() || null;

        return { title, year, season, episode, episode_title };
      },
    },

    hbomax: {
      subtitleContainer: () => document.querySelector('[data-testid="cueBoxRowTextCue"]')?.closest('[class*="RowContainer"]') ||
        document.querySelector('[data-testid="cueBoxRowTextCue"]')?.parentElement?.parentElement,
      subtitleText: () =>
        Array.from(document.querySelectorAll('[data-testid="cueBoxRowTextCue"]'))
          .map((el) => el.textContent.trim())
          .filter(Boolean)
          .join(" "),
      getMetadata: () => {
        // Primary: dedicated asset title element (series name)
        const assetTitle = document.querySelector('[data-testid="player-ux-asset-title"]')?.textContent?.trim();

        // Fallback: parse from "What did you think of [Series]?" prompt
        const feedbackEl = Array.from(document.querySelectorAll('*')).find(
          el => el.children.length === 0 && el.textContent.includes('What did you think of')
        );
        const feedbackMatch = feedbackEl?.textContent.match(/What did you think of (.+?)\?/);
        const seriesTitle = feedbackMatch ? feedbackMatch[1].trim() : null;

        // Fall back to episode title from document.title if all else fails
        const title = assetTitle || seriesTitle || document.title.replace(/\s*[•·|]\s*(?:HBO\s*Max|Max)\s*/i, "").trim();

        // Parse "S1 E6: Episode Title" from the on-screen label
        const titleEl = document.querySelector('[class*="title"]')?.textContent || "";
        const seasonMatch = titleEl.match(/S(\d+)/i);
        const episodeMatch = titleEl.match(/E(\d+)/i);
        const episodeTitleMatch = titleEl.match(/:\s*(.+)$/);

        const season = seasonMatch ? parseInt(seasonMatch[1]) : null;
        const episode = episodeMatch ? parseInt(episodeMatch[1]) : null;
        const episode_title = episodeTitleMatch ? episodeTitleMatch[1].trim() : null;

        return { title, year: null, season, episode, episode_title };
      },
    },

  };

  const config = PLATFORM_CONFIG[PLATFORM];
  if (!config) {
    console.log("[BookVsFilm] Unsupported platform:", PLATFORM);
    return;
  }

  // --- Subtitle collection ---

  function startSubtitleObserver() {
    if (PLATFORM === "hbomax") {
      // HBO Max: observe body for cue changes since container may re-render
      subtitleObserver = new MutationObserver(() => {
        const lines = config.subtitleText();
        if (lines) {
          const now = videoEl ? videoEl.currentTime : 0;
          const last = subtitleBuffer[subtitleBuffer.length - 1];
          if (!last || last.text !== lines) {
            subtitleBuffer.push({ text: lines, timestamp_seconds: now });
          }
          subtitleBuffer = subtitleBuffer.filter(
            (s) => now - s.timestamp_seconds <= SUBTITLE_BUFFER_SECONDS
          );
        }
      });
      subtitleObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      return;
    }

    // Netflix: watch for specific container
    const observe = () => {
      const container = config.subtitleContainer();
      if (!container) return;
      if (subtitleObserver) subtitleObserver.disconnect();

      subtitleObserver = new MutationObserver(() => {
        const lines = config.subtitleText(container);
        if (lines) {
          const now = videoEl ? videoEl.currentTime : 0;
          const last = subtitleBuffer[subtitleBuffer.length - 1];
          if (!last || last.text !== lines) {
            subtitleBuffer.push({ text: lines, timestamp_seconds: now });
          }
          subtitleBuffer = subtitleBuffer.filter(
            (s) => now - s.timestamp_seconds <= SUBTITLE_BUFFER_SECONDS
          );
        }
      });

      subtitleObserver.observe(container, { childList: true, subtree: true, characterData: true });
    };

    const interval = setInterval(() => {
      if (config.subtitleContainer()) {
        observe();
        clearInterval(interval);
      }
    }, 1000);
  }

  function getSubtitleContext() {
    const now = videoEl ? videoEl.currentTime : 0;
    return subtitleBuffer
      .filter((s) => now - s.timestamp_seconds <= SUBTITLE_BUFFER_SECONDS)
      .map((s) => s.text)
      .join(" ");
  }

  // --- Metadata extraction ---

  function getMetadata() {
    const platformMeta = config.getMetadata();
    const type = platformMeta.season !== null ? "series" : "movie";
    const runtime_seconds = videoEl?.duration || null;
    const timestamp_seconds = videoEl?.currentTime || 0;

    return {
      ...platformMeta,
      type,
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
      chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" });
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
      if (!video.ended) showOverlay();
    });

    video.addEventListener("play", () => {
      removeOverlay();
      chrome.runtime.sendMessage({ type: "CLOSE_SIDE_PANEL" });
    });

    video.addEventListener("ended", () => {
      removeOverlay();
    });
  }

  // --- Init ---

  function attachToVideo() {
    const existing = document.querySelector("video");
    if (existing && existing !== videoEl) {
      attachVideoListeners(existing);
      startSubtitleObserver();
      return;
    }

    const observer = new MutationObserver(() => {
      const video = document.querySelector("video");
      if (video && video !== videoEl) {
        observer.disconnect();
        attachVideoListeners(video);
        startSubtitleObserver();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    attachToVideo();

    // Netflix/HBO Max are SPAs — re-initialize when the URL changes to a watch page
    let lastUrl = window.location.href;
    new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        removeOverlay();
        subtitleBuffer = [];
        attachToVideo();
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
