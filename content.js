(() => {
  const PANEL_ID = "douyin-like-filter-panel";
  const STORAGE_KEY = "douyin-like-filter-target-date";
  const PAGE_EVENT = "douyin-like-filter:data";
  const SEARCH_STEP_PX = 4200;
  const SEARCH_IDLE_LIMIT = 4;
  const SEARCH_WAIT_MS = 900;
  const SEARCH_POLL_MS = 120;
  const SEARCH_MAX_WAIT_CYCLES = 8;
  const SEARCH_MAX_DURATION_MS = 180000;
  const MATCH_WINDOW_DAYS = 5;
  const MATCH_WINDOW_MS = MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const NEARBY_SAMPLE_LIMIT = 10;
  const NEARBY_AVERAGE_WINDOW_DAYS = 15;
  const NEARBY_AVERAGE_WINDOW_MS = NEARBY_AVERAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const awemeTimeMap = new Map();
  const cardState = new Map();
  const videoCardIndex = new Map();
  let lastPageEventTick = 0;

  let panelReady = false;
  let mutationObserver = null;
  let rescanTimer = null;
  let statusNode = null;
  let targetInput = null;
  let searchButton = null;
  let continueButton = null;
  let stopButton = null;
  let searchState = null;
  let lastRouteSignature = "";
  let sessionState = {
    scrollTarget: null,
    lastSuggestedPosition: -Infinity,
    visitedKeys: new Set(),
    hasStarted: false,
    currentHighlightedKey: null,
    candidateQueue: [],
    networkCandidateQueue: [],
    networkCandidateIds: new Set()
  };

  function injectPageHook() {
    if (document.getElementById("douyin-like-filter-hook")) {
      return;
    }

    const script = document.createElement("script");
    script.id = "douyin-like-filter-hook";
    script.src = chrome.runtime.getURL("page-hook.js");
    script.async = false;
    script.onload = () => script.remove();
    script.onerror = () => script.remove();
    (document.documentElement || document.head).appendChild(script);
  }

  function normalizeTimestamp(rawValue) {
    if (rawValue == null || rawValue === "") {
      return null;
    }

    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }

    return numeric > 1e12 ? numeric : numeric * 1000;
  }

  function parseTextDate(text) {
    if (!text) {
      return null;
    }

    const normalized = text.replace(/\s+/g, " ");
    const patterns = [
      /(20\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/,
      /(20\d{2})\u5E74(\d{1,2})\u6708(\d{1,2})\u65E5?/
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (!match) {
        continue;
      }

      const year = Number(match[1]);
      const month = Number(match[2]) - 1;
      const day = Number(match[3]);
      const timestamp = new Date(year, month, day).getTime();
      if (Number.isFinite(timestamp)) {
        return timestamp;
      }
    }

    return null;
  }

  function extractVideoId(href) {
    if (!href) {
      return null;
    }

    const patterns = [
      /\/video\/(\d+)/,
      /modal_id=(\d+)/,
      /aweme_id=(\d+)/
    ];

    for (const pattern of patterns) {
      const match = href.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  function findCardRoot(anchor) {
    const preferredSelectors = ["li", "[data-e2e]", "article"];
    for (const selector of preferredSelectors) {
      const node = anchor.closest(selector);
      if (node) {
        return node;
      }
    }

    let current = anchor;
    for (let i = 0; i < 6 && current?.parentElement; i += 1) {
      current = current.parentElement;
      if (current.childElementCount > 1 && current.getBoundingClientRect().height > 80) {
        return current;
      }
    }

    return anchor.parentElement || anchor;
  }

  function getCardDate(card, videoId) {
    if (videoId && awemeTimeMap.has(videoId)) {
      return awemeTimeMap.get(videoId);
    }

    return parseTextDate(card.textContent || "");
  }

  function formatDate(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function isWithinMatchWindow(distance) {
    return distance <= MATCH_WINDOW_MS;
  }

  function getTargetTimestamp() {
    if (!targetInput?.value) {
      return null;
    }

    const timestamp = new Date(`${targetInput.value}T00:00:00`).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  async function saveTargetDate() {
    await chrome.storage.local.set({
      [STORAGE_KEY]: { targetDate: targetInput?.value || "" }
    });
  }

  async function restoreTargetDate() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const payload = stored[STORAGE_KEY];
    if (payload?.targetDate && targetInput) {
      targetInput.value = payload.targetDate;
    }
  }

  function updateStatus(message) {
    if (statusNode) {
      statusNode.textContent = message;
    }
  }

  function isVisibleText(text) {
    return typeof text === "string" && text.trim().length > 0;
  }

  function getCompactText(element) {
    if (!element) {
      return "";
    }
    return (element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isLikeTabText(text) {
    return /喜欢|赞过/.test(text);
  }

  function isVideoDetailRoute() {
    return (
      /\/video\/\d+/.test(window.location.pathname) ||
      /(?:\?|&)modal_id=\d+/.test(window.location.search) ||
      /(?:\?|&)aweme_id=\d+/.test(window.location.search)
    );
  }

  function isUserProfileRoute() {
    return /\/user\//.test(window.location.pathname);
  }

  function hasActiveLikeTab() {
    const selectors = [
      '[role="tab"][aria-selected="true"]',
      '[aria-selected="true"]',
      '[class*="tab"][class*="active"]',
      '[class*="Tab"][class*="active"]',
      '[class*="tab"][class*="current"]',
      '[class*="Tab"][class*="current"]',
      '[class*="tab"][class*="selected"]',
      '[class*="Tab"][class*="selected"]'
    ];

    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        const text = getCompactText(node);
        if (isVisibleText(text) && isLikeTabText(text)) {
          return true;
        }
      }
    }

    const search = window.location.search;
    if (/(?:\?|&)(?:tab|showTab)=(?:like|likes|favorite|favourite)/i.test(search)) {
      return true;
    }

    return false;
  }

  function isLikesListContext() {
    if (!isUserProfileRoute()) {
      return false;
    }

    if (isVideoDetailRoute()) {
      return false;
    }

    return hasActiveLikeTab();
  }

  function getPanelNode() {
    return document.getElementById(PANEL_ID);
  }

  function applyPanelVisibility(isVisible) {
    const panel = getPanelNode();
    if (!panel) {
      return;
    }
    panel.classList.toggle("dlf-panel--hidden", !isVisible);
  }

  function stopSearchInternal({ message = "", refresh = true } = {}) {
    if (searchState) {
      searchState.running = false;
    }
    setSearchRunning(false);
    if (refresh) {
      refreshStatus(message ? [message] : []);
    } else if (message) {
      updateStatus(message);
    }
  }

  function updateContextVisibility() {
    const shouldShow = isLikesListContext();
    applyPanelVisibility(shouldShow);

    const routeSignature = `${window.location.pathname}${window.location.search}`;
    if (routeSignature !== lastRouteSignature) {
      lastRouteSignature = routeSignature;
      if (!shouldShow && searchState?.running) {
        stopSearchInternal({ refresh: false });
      }
    }

    return shouldShow;
  }

  function clearTargetHighlight() {
    for (const card of cardState.keys()) {
      card.classList.remove("dlf-target");
    }
  }

  function getDistanceDays(distance) {
    return Math.round(distance / 86400000);
  }

  function getCardKey(card, info) {
    if (info?.videoId) {
      return `video:${info.videoId}`;
    }

    if (!card.dataset.dlfCardKey) {
      card.dataset.dlfCardKey = `card:${Math.random().toString(36).slice(2, 10)}`;
    }

    return card.dataset.dlfCardKey;
  }

  function scanCards() {
    const anchors = getAnchorNodes();
    const seenCards = new Set();
    let detectedDates = 0;
    let unknownDates = 0;
    videoCardIndex.clear();

    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || anchor.href;
      const videoId = extractVideoId(href);
      if (!videoId) {
        continue;
      }

      const card = findCardRoot(anchor);
      if (!card || seenCards.has(card)) {
        continue;
      }

      seenCards.add(card);
      if (!videoCardIndex.has(videoId)) {
        videoCardIndex.set(videoId, []);
      }
      videoCardIndex.get(videoId).push(card);

      const timestamp = getCardDate(card, videoId);
      const existing = cardState.get(card);
      const source =
        videoId && awemeTimeMap.has(videoId) ? "network" : timestamp ? "text" : existing?.source || "unknown";

      cardState.set(card, { videoId, timestamp, source });

      if (timestamp) {
        detectedDates += 1;
        card.classList.remove("dlf-unknown");
      } else {
        unknownDates += 1;
        card.classList.add("dlf-unknown");
      }
    }

    for (const [card] of cardState.entries()) {
      if (!document.contains(card)) {
        cardState.delete(card);
      }
    }

    return {
      totalCards: cardState.size,
      detectedDates,
      unknownDates
    };
  }

  function enqueueNetworkCandidate(videoId, timestamp) {
    const targetTimestamp = getTargetTimestamp();
    if (!targetTimestamp) {
      return;
    }

    const distance = Math.abs(timestamp - targetTimestamp);
    if (!isWithinMatchWindow(distance)) {
      return;
    }

    const key = `video:${videoId}`;
    if (sessionState.visitedKeys.has(key) || sessionState.networkCandidateIds.has(videoId)) {
      return;
    }

    sessionState.networkCandidateIds.add(videoId);
    sessionState.networkCandidateQueue.push({
      key,
      videoId,
      timestamp,
      distance
    });
  }

  function getBestMatch(targetTimestamp) {
    let best = null;

    for (const [card, info] of cardState.entries()) {
      if (!document.contains(card)) {
        continue;
      }

      const timestamp = info.timestamp || getCardDate(card, info.videoId);
      info.timestamp = timestamp;
      if (!timestamp) {
        continue;
      }

      const distance = Math.abs(timestamp - targetTimestamp);
      if (!best || distance < best.distance) {
        best = { card, timestamp, distance, videoId: info.videoId };
      }
    }

    return best;
  }

  function refreshStatus(extraLines = []) {
    if (!updateContextVisibility()) {
      return {
        stats: { totalCards: 0, detectedDates: 0, unknownDates: 0 },
        best: null,
        targetTimestamp: null
      };
    }

    const stats = scanCards();
    const targetTimestamp = getTargetTimestamp();
    const best = targetTimestamp ? getBestMatch(targetTimestamp) : null;

    clearTargetHighlight();
    if (sessionState.currentHighlightedKey) {
      for (const [card, info] of cardState.entries()) {
        if (getCardKey(card, info) === sessionState.currentHighlightedKey) {
          card.classList.add("dlf-target");
          break;
        }
      }
    }

    const lines = [
      `已扫描卡片: ${stats.totalCards}`,
      `可识别发布时间: ${stats.detectedDates}`,
      `无法识别发布时间: ${stats.unknownDates}`,
      `目标日期: ${targetTimestamp ? formatDate(targetTimestamp) : "未设置"}`
    ];

    if (best) {
      lines.push(`最近发布时间: ${formatDate(best.timestamp)}`);
      lines.push(`相差天数: ${getDistanceDays(best.distance)} 天`);
      lines.push(
        isWithinMatchWindow(best.distance)
          ? `首轮结果: 已进入 5 天候选范围，等待邻域校验`
          : `首轮结果: 超出 5 天，请继续查找或重新选择日期`
      );
    } else {
      lines.push("最近发布时间: 暂未找到");
    }

    updateStatus(lines.concat(extraLines).join("\n"));
    return { stats, best, targetTimestamp };
  }

  function setSearchRunning(isRunning) {
    if (searchButton) {
      searchButton.disabled = isRunning;
    }
    if (continueButton) {
      continueButton.disabled = isRunning || !sessionState.hasStarted;
    }
    if (stopButton) {
      stopButton.disabled = !isRunning;
    }
  }

  function wait(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function getVisibleRect(element) {
    try {
      return element.getBoundingClientRect();
    } catch {
      return null;
    }
  }

  function isVisibleElement(element) {
    const rect = getVisibleRect(element);
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  }

  function isElementScrollable(element) {
    if (!element || !(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const overflowY = style.overflowY || style.overflow;
    if (!/(auto|scroll|overlay)/i.test(overflowY)) {
      return false;
    }

    return element.scrollHeight - element.clientHeight > 120;
  }

  function getAnchorNodes() {
    return Array.from(
      document.querySelectorAll('a[href*="/video/"], a[href*="modal_id="], a[href*="aweme_id="]')
    );
  }

  function getScrollableCandidates() {
    const candidates = new Set();
    const anchors = getAnchorNodes().slice(0, 24);

    if (document.scrollingElement) {
      candidates.add(document.scrollingElement);
    }

    for (const anchor of anchors) {
      let current = anchor;
      let depth = 0;
      while (current?.parentElement && depth < 12) {
        current = current.parentElement;
        if (isElementScrollable(current)) {
          candidates.add(current);
        }
        depth += 1;
      }
    }

    return Array.from(candidates);
  }

  function countAnchorsInside(container) {
    if (!container) {
      return 0;
    }

    if (container === document.scrollingElement) {
      return getAnchorNodes().length;
    }

    try {
      return container.querySelectorAll('a[href*="/video/"], a[href*="modal_id="], a[href*="aweme_id="]').length;
    } catch {
      return 0;
    }
  }

  function describeScrollTarget(target) {
    if (!target || target === document.scrollingElement) {
      return "window";
    }

    const parts = [target.tagName.toLowerCase()];
    if (target.id) {
      parts.push(`#${target.id}`);
    }
    if (typeof target.className === "string" && target.className.trim()) {
      const className = target.className.trim().split(/\s+/).slice(0, 2).join(".");
      if (className) {
        parts.push(`.${className}`);
      }
    }

    return parts.join("");
  }

  function resolveScrollTarget() {
    const candidates = getScrollableCandidates();
    let best = document.scrollingElement || document.documentElement;
    let bestScore = -Infinity;

    for (const candidate of candidates) {
      const anchorCount = countAnchorsInside(candidate);
      const scrollRange = Math.max(
        0,
        (candidate.scrollHeight || document.documentElement.scrollHeight) -
          (candidate.clientHeight || window.innerHeight)
      );
      const visibleBonus = candidate === document.scrollingElement || isVisibleElement(candidate) ? 400 : -400;
      const score = anchorCount * 1000 + scrollRange + visibleBonus;

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best;
  }

  function getScrollTop(target) {
    if (!target || target === document.scrollingElement) {
      return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }
    return target.scrollTop;
  }

  function getClientHeight(target) {
    if (!target || target === document.scrollingElement) {
      return window.innerHeight || document.documentElement.clientHeight || 0;
    }
    return target.clientHeight;
  }

  function getScrollHeight(target) {
    if (!target || target === document.scrollingElement) {
      return Math.max(
        document.documentElement.scrollHeight || 0,
        document.body.scrollHeight || 0
      );
    }
    return target.scrollHeight;
  }

  function getMaxScrollTop(target) {
    return Math.max(0, getScrollHeight(target) - getClientHeight(target));
  }

  function setScrollTop(target, nextTop, behavior = "auto") {
    const boundedTop = Math.max(0, Math.min(nextTop, getMaxScrollTop(target)));

    if (!target || target === document.scrollingElement) {
      window.scrollTo({ top: boundedTop, behavior });
      window.dispatchEvent(new Event("scroll", { bubbles: true }));
      return boundedTop;
    }

    target.scrollTo({ top: boundedTop, behavior });
    target.dispatchEvent(new Event("scroll", { bubbles: true }));
    return boundedTop;
  }

  function emitWheelLikeEvents(target, deltaY) {
    const eventTarget =
      target && target !== document.scrollingElement ? target : document.scrollingElement || document.body;

    try {
      eventTarget.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL
        })
      );
    } catch {
      // Ignore event-construction failures in older runtimes.
    }
  }

  async function primeAutoLoading(target) {
    const startTop = getScrollTop(target);
    const nudge = Math.max(400, Math.floor(getClientHeight(target) * 0.5));

    setScrollTop(target, startTop + nudge, "auto");
    emitWheelLikeEvents(target, nudge);
    await wait(220);

    setScrollTop(target, Math.max(0, startTop - Math.floor(nudge / 2)), "auto");
    emitWheelLikeEvents(target, -Math.floor(nudge / 2));
    await wait(220);

    setScrollTop(target, startTop, "auto");
    await wait(300);
  }

  async function scrollSearchTarget(target, direction = 1) {
    const currentTop = getScrollTop(target);
    const step = Math.max(1800, Math.min(SEARCH_STEP_PX, Math.floor(getClientHeight(target) * 1.8)));
    const nextTop = currentTop + step * direction;
    const beforeAnchorCount = getAnchorNodes().length;
    const beforeTick = lastPageEventTick;

    setScrollTop(target, nextTop, "auto");
    emitWheelLikeEvents(target, step * direction);
    for (let i = 0; i < SEARCH_MAX_WAIT_CYCLES; i += 1) {
      await wait(SEARCH_POLL_MS);
      const afterAnchorCount = getAnchorNodes().length;
      if (lastPageEventTick !== beforeTick || afterAnchorCount > beforeAnchorCount) {
        break;
      }
    }
    await wait(Math.max(120, SEARCH_WAIT_MS - SEARCH_POLL_MS * SEARCH_MAX_WAIT_CYCLES));

    const afterTop = getScrollTop(target);
    const moved = Math.abs(afterTop - currentTop);

    if (moved < 24 && direction > 0) {
      setScrollTop(target, currentTop + step, "auto");
      emitWheelLikeEvents(target, step);
      await wait(700);
    }

    return {
      beforeTop: currentTop,
      afterTop: getScrollTop(target),
      reachedBottom: getScrollTop(target) >= getMaxScrollTop(target) - 8
    };
  }

  async function resetSearchStartPosition(target) {
    setScrollTop(target, 0, "auto");
    await wait(400);
    await primeAutoLoading(target);
    setScrollTop(target, 0, "auto");
    await wait(500);
  }

  function scrollCardIntoView(card) {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function getCardAbsoluteTop(card, scrollTarget) {
    const rect = card.getBoundingClientRect();
    if (!scrollTarget || scrollTarget === document.scrollingElement) {
      return rect.top + (window.scrollY || document.documentElement.scrollTop || 0);
    }

    const containerRect = scrollTarget.getBoundingClientRect();
    return rect.top - containerRect.top + scrollTarget.scrollTop;
  }

  function buildCandidateRecord(card, info, targetTimestamp, scrollTarget) {
    const timestamp = info.timestamp || getCardDate(card, info.videoId);
    info.timestamp = timestamp;
    if (!timestamp) {
      return null;
    }

    const distance = Math.abs(timestamp - targetTimestamp);
    if (!isWithinMatchWindow(distance)) {
      return null;
    }

    const position = getCardAbsoluteTop(card, scrollTarget);
    const key = getCardKey(card, info);

    return {
      card,
      key,
      timestamp,
      distance,
      position,
      videoId: info.videoId
    };
  }

  function getLoadedTimelineEntries(scrollTarget) {
    const entries = [];

    for (const [card, info] of cardState.entries()) {
      if (!document.contains(card)) {
        continue;
      }

      const timestamp = info.timestamp || getCardDate(card, info.videoId);
      info.timestamp = timestamp;
      if (!timestamp) {
        continue;
      }

      entries.push({
        card,
        key: getCardKey(card, info),
        timestamp,
        position: getCardAbsoluteTop(card, scrollTarget),
        videoId: info.videoId
      });
    }

    entries.sort((left, right) => left.position - right.position);
    return entries;
  }

  function collectNearbySamples(candidate, scrollTarget) {
    const timelineEntries = getLoadedTimelineEntries(scrollTarget);
    const index = timelineEntries.findIndex((entry) => entry.key === candidate.key);
    if (index === -1) {
      return [];
    }

    const samples = [];
    let left = index - 1;
    let right = index + 1;

    while (samples.length < NEARBY_SAMPLE_LIMIT && (left >= 0 || right < timelineEntries.length)) {
      const leftEntry = left >= 0 ? timelineEntries[left] : null;
      const rightEntry = right < timelineEntries.length ? timelineEntries[right] : null;
      const leftGap = leftEntry ? Math.abs(candidate.position - leftEntry.position) : Number.POSITIVE_INFINITY;
      const rightGap = rightEntry ? Math.abs(rightEntry.position - candidate.position) : Number.POSITIVE_INFINITY;

      if (leftGap <= rightGap) {
        if (leftEntry) {
          samples.push(leftEntry);
        }
        left -= 1;
      } else {
        if (rightEntry) {
          samples.push(rightEntry);
        }
        right += 1;
      }
    }

    return samples;
  }

  function validateCandidateByNeighborhood(candidate, scrollTarget) {
    const nearbySamples = collectNearbySamples(candidate, scrollTarget);
    if (nearbySamples.length === 0) {
      return {
        passed: false,
        sampleCount: 0,
        averageTimestamp: null,
        averageDistance: Number.POSITIVE_INFINITY,
        reason: "附近没有可用的视频日期样本"
      };
    }

    const averageTimestamp =
      nearbySamples.reduce((sum, sample) => sum + sample.timestamp, 0) / nearbySamples.length;
    const averageDistance = Math.abs(averageTimestamp - candidate.timestamp);

    return {
      passed: averageDistance <= NEARBY_AVERAGE_WINDOW_MS,
      sampleCount: nearbySamples.length,
      averageTimestamp,
      averageDistance,
      reason:
        averageDistance <= NEARBY_AVERAGE_WINDOW_MS
          ? "邻域平均时间接近当前候选"
          : "邻域平均时间与当前候选偏差过大"
    };
  }

  function findNextCandidate(targetTimestamp, scrollTarget, afterPosition) {
    const matches = [];

    for (const [card, info] of cardState.entries()) {
      if (!document.contains(card)) {
        continue;
      }

      const candidate = buildCandidateRecord(card, info, targetTimestamp, scrollTarget);
      if (!candidate) {
        continue;
      }

      if (candidate.position <= afterPosition + 24) {
        continue;
      }

      if (sessionState.visitedKeys.has(candidate.key)) {
        continue;
      }

      matches.push(candidate);
    }

    matches.sort((left, right) => {
      if (left.position !== right.position) {
        return left.position - right.position;
      }
      return left.distance - right.distance;
    });

    return matches[0] || null;
  }

  function takeNextNetworkCandidate(targetTimestamp, scrollTarget) {
    for (let i = 0; i < sessionState.networkCandidateQueue.length; i += 1) {
      const queued = sessionState.networkCandidateQueue[i];
      if (!queued) {
        continue;
      }

      if (sessionState.visitedKeys.has(queued.key)) {
        sessionState.networkCandidateQueue.splice(i, 1);
        sessionState.networkCandidateIds.delete(queued.videoId);
        i -= 1;
        continue;
      }

      const cards = videoCardIndex.get(queued.videoId) || [];
      let bestCandidate = null;

      for (const card of cards) {
        if (!document.contains(card)) {
          continue;
        }

        const info = cardState.get(card) || {
          videoId: queued.videoId,
          timestamp: queued.timestamp,
          source: "network"
        };
        const candidate = buildCandidateRecord(card, info, targetTimestamp, scrollTarget);
        if (!candidate) {
          continue;
        }
        if (candidate.position <= sessionState.lastSuggestedPosition + 24) {
          continue;
        }

        if (!bestCandidate || candidate.position < bestCandidate.position) {
          bestCandidate = candidate;
        }
      }

      if (!bestCandidate && cards.length > 0) {
        sessionState.networkCandidateQueue.splice(i, 1);
        sessionState.networkCandidateIds.delete(queued.videoId);
        i -= 1;
        continue;
      }

      if (bestCandidate) {
        sessionState.networkCandidateQueue.splice(i, 1);
        sessionState.networkCandidateIds.delete(queued.videoId);
        return bestCandidate;
      }
    }

    return null;
  }

  function fillCandidateQueue(targetTimestamp, scrollTarget) {
    const queuedKeys = new Set(sessionState.candidateQueue.map((candidate) => candidate.key));
    const freshCandidates = [];

    for (const [card, info] of cardState.entries()) {
      if (!document.contains(card)) {
        continue;
      }

      const candidate = buildCandidateRecord(card, info, targetTimestamp, scrollTarget);
      if (!candidate) {
        continue;
      }

      if (candidate.position <= sessionState.lastSuggestedPosition + 24) {
        continue;
      }

      if (sessionState.visitedKeys.has(candidate.key) || queuedKeys.has(candidate.key)) {
        continue;
      }

      freshCandidates.push(candidate);
    }

    freshCandidates.sort((left, right) => {
      if (left.position !== right.position) {
        return left.position - right.position;
      }
      return left.distance - right.distance;
    });

    sessionState.candidateQueue.push(...freshCandidates);
  }

  function takeNextQueuedCandidate() {
    while (sessionState.candidateQueue.length > 0) {
      const candidate = sessionState.candidateQueue.shift();
      if (!candidate?.card || !document.contains(candidate.card)) {
        continue;
      }
      return candidate;
    }

    return null;
  }

  function resetSession(scrollTarget = null) {
    sessionState = {
      scrollTarget,
      lastSuggestedPosition: -Infinity,
      visitedKeys: new Set(),
      hasStarted: false,
      currentHighlightedKey: null,
      candidateQueue: [],
      networkCandidateQueue: [],
      networkCandidateIds: new Set()
    };
  }

  async function runCandidateSearch({ resetToTop }) {
    if (!updateContextVisibility()) {
      updateStatus("当前不在喜欢列表页，插件已隐藏。请先回到个人主页的喜欢列表。");
      return;
    }

    const targetTimestamp = getTargetTimestamp();
    if (!targetTimestamp) {
      updateStatus("请先选择目标日期。");
      return;
    }

    await saveTargetDate();
    if (searchState?.running) {
      return;
    }

    scanCards();
    searchState = {
      running: true,
      lastCardCount: cardState.size,
      idleRounds: 0,
      steps: 0,
      scrollTarget: null,
      startedAt: Date.now(),
      timedOut: false
    };
    setSearchRunning(true);
    refreshStatus([
      resetToTop
        ? "正在从顶部开始搜索候选视频..."
        : "正在继续向后搜索下一个候选视频..."
    ]);

    try {
      const scrollTarget = resetToTop || !sessionState.scrollTarget
        ? resolveScrollTarget()
        : sessionState.scrollTarget;

      searchState.scrollTarget = scrollTarget;
      sessionState.scrollTarget = scrollTarget;

      if (resetToTop) {
        resetSession(scrollTarget);
        await resetSearchStartPosition(scrollTarget);
        sessionState.hasStarted = true;
        refreshStatus([
          `滚动容器: ${describeScrollTarget(scrollTarget)}`,
          "已自动回到列表顶部，开始搜索候选视频..."
        ]);
      } else {
        await primeAutoLoading(scrollTarget);
        sessionState.hasStarted = true;
        refreshStatus([
          `滚动容器: ${describeScrollTarget(scrollTarget)}`,
          "继续搜索下一个候选视频..."
        ]);
      }

      while (searchState.running) {
        if (Date.now() - searchState.startedAt >= SEARCH_MAX_DURATION_MS) {
          searchState.timedOut = true;
          break;
        }

        fillCandidateQueue(targetTimestamp, searchState.scrollTarget);
        const candidate =
          takeNextNetworkCandidate(targetTimestamp, searchState.scrollTarget) ||
          takeNextQueuedCandidate() ||
          findNextCandidate(
            targetTimestamp,
            searchState.scrollTarget,
            sessionState.lastSuggestedPosition
          );

        if (candidate) {
          const validation = validateCandidateByNeighborhood(candidate, searchState.scrollTarget);

          sessionState.visitedKeys.add(candidate.key);
          sessionState.lastSuggestedPosition = candidate.position;
          sessionState.hasStarted = true;

          if (validation.passed) {
            sessionState.currentHighlightedKey = candidate.key;

            clearTargetHighlight();
            candidate.card.classList.add("dlf-target");
            scrollCardIntoView(candidate.card);
            refreshStatus([
              `滚动容器: ${describeScrollTarget(searchState.scrollTarget)}`,
              `已定位候选视频: ${formatDate(candidate.timestamp)}`,
              `与目标日期相差: ${getDistanceDays(candidate.distance)} 天`,
              `邻域样本数: ${validation.sampleCount} 个`,
              `邻域平均日期: ${validation.averageTimestamp ? formatDate(validation.averageTimestamp) : "无"}`,
              `邻域平均差: ${Number.isFinite(validation.averageDistance) ? getDistanceDays(validation.averageDistance) : "-"} 天`,
              `已缓存候选: ${sessionState.candidateQueue.length} 个`,
              `网络候选: ${sessionState.networkCandidateQueue.length} 个`,
              "邻域校验已通过，已高亮当前视频。"
            ]);
            return;
          }

          sessionState.currentHighlightedKey = null;
          refreshStatus([
            `滚动容器: ${describeScrollTarget(searchState.scrollTarget)}`,
            `候选未通过邻域校验: ${formatDate(candidate.timestamp)}`,
            `邻域样本数: ${validation.sampleCount} 个`,
            `邻域平均日期: ${validation.averageTimestamp ? formatDate(validation.averageTimestamp) : "无"}`,
            `邻域平均差: ${Number.isFinite(validation.averageDistance) ? getDistanceDays(validation.averageDistance) : "-"} 天`,
            "当前候选可能不对应你的点赞时期，继续自动查找..."
          ]);
        }

        searchState.steps += 1;

        const scrollResult = await scrollSearchTarget(searchState.scrollTarget, 1);

        const { stats } = refreshStatus([
          `滚动容器: ${describeScrollTarget(searchState.scrollTarget)}`,
          `已自动扫描: ${searchState.steps} 轮`,
          `已缓存候选: ${sessionState.candidateQueue.length} 个`,
          `网络候选: ${sessionState.networkCandidateQueue.length} 个`,
          "快速扫描中..."
        ]);

        if (stats.totalCards > searchState.lastCardCount) {
          searchState.lastCardCount = stats.totalCards;
          searchState.idleRounds = 0;
        } else {
          searchState.idleRounds += 1;
        }

        if (searchState.idleRounds >= 2) {
          const newTarget = resolveScrollTarget();
          if (newTarget !== searchState.scrollTarget) {
            searchState.scrollTarget = newTarget;
            sessionState.scrollTarget = newTarget;
            searchState.idleRounds = 0;
            await primeAutoLoading(searchState.scrollTarget);
          }
        }

        if (scrollResult.reachedBottom && searchState.idleRounds >= 1) {
          break;
        }

        if (searchState.idleRounds >= SEARCH_IDLE_LIMIT) {
          break;
        }
      }

      if (!searchState.running) {
        refreshStatus(["搜索已停止。"]);
        return;
      }

      const finalLines = [
        `滚动容器: ${describeScrollTarget(searchState.scrollTarget)}`,
        `已缓存候选: ${sessionState.candidateQueue.length} 个`,
        `网络候选: ${sessionState.networkCandidateQueue.length} 个`
      ];

      if (searchState.timedOut) {
        finalLines.push("搜索时间较长，已自动停止。你可以点击“继续查找”从当前位置继续。");
      } else {
        finalLines.push("没有找到新的候选视频。请重新选择日期，或稍后从别的位置再试。");
      }

      refreshStatus(finalLines);
    } finally {
      if (searchState) {
        searchState.running = false;
      }
      setSearchRunning(false);
    }
  }

  async function jumpToClosestVideo() {
    return runCandidateSearch({ resetToTop: true });
  }

  async function continueCandidateSearch() {
    if (!updateContextVisibility()) {
      return;
    }

    if (!sessionState.hasStarted && sessionState.lastSuggestedPosition === -Infinity) {
      updateStatus("请先点击“查找并跳转”，开始一次搜索。");
      return;
    }

    return runCandidateSearch({ resetToTop: false });
  }

  function stopSearch() {
    stopSearchInternal({ message: "已手动停止搜索。" });
  }

  function queueRescan() {
    window.clearTimeout(rescanTimer);
    rescanTimer = window.setTimeout(() => {
      if (updateContextVisibility()) {
        refreshStatus();
      }
    }, 300);
  }

  function createPanel() {
    if (panelReady || document.getElementById(PANEL_ID)) {
      return;
    }

    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.className = "dlf-panel";
    panel.innerHTML = `
      <div class="dlf-panel__body">
        <h2 class="dlf-panel__title">Douyin Like Navigator</h2>
        <p class="dlf-panel__desc">
          选择一个目标日期后，插件会自动向下滚动喜欢列表，并尝试定位发布时间落在目标日期前后 5 天内的视频。
        </p>
        <div class="dlf-panel__field">
          <span>目标日期</span>
          <input type="date" id="dlf-target-date" />
        </div>
        <div class="dlf-panel__actions">
          <button type="button" class="dlf-btn--primary" id="dlf-jump">查找并跳转</button>
          <button type="button" class="dlf-btn--secondary" id="dlf-continue" disabled>继续查找</button>
        </div>
        <div class="dlf-panel__actions">
          <button type="button" class="dlf-btn--secondary" id="dlf-stop" disabled>停止</button>
        </div>
        <div class="dlf-panel__status" id="dlf-status">等待喜欢列表加载中...</div>
      </div>
    `;

    document.body.appendChild(panel);
    panelReady = true;

    statusNode = panel.querySelector("#dlf-status");
    targetInput = panel.querySelector("#dlf-target-date");
    searchButton = panel.querySelector("#dlf-jump");
    continueButton = panel.querySelector("#dlf-continue");
    stopButton = panel.querySelector("#dlf-stop");

    searchButton?.addEventListener("click", () => {
      jumpToClosestVideo().catch((error) => {
        console.error("[Douyin Like Filter] jump failed", error);
        setSearchRunning(false);
        updateStatus(`跳转失败: ${error.message}`);
      });
    });

    continueButton?.addEventListener("click", () => {
      continueCandidateSearch().catch((error) => {
        console.error("[Douyin Like Filter] continue failed", error);
        setSearchRunning(false);
        updateStatus(`继续查找失败: ${error.message}`);
      });
    });

    stopButton?.addEventListener("click", () => {
      stopSearch();
    });
  }

  function observePage() {
    if (mutationObserver) {
      return;
    }

    mutationObserver = new MutationObserver(() => {
      queueRescan();
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function bindNavigationEvents() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function patchedPushState(...args) {
      const result = originalPushState.apply(this, args);
      queueRescan();
      return result;
    };

    history.replaceState = function patchedReplaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      queueRescan();
      return result;
    };

    window.addEventListener("popstate", () => {
      queueRescan();
    });

    window.addEventListener("hashchange", () => {
      queueRescan();
    });
  }

  function bindEvents() {
    window.addEventListener(PAGE_EVENT, (event) => {
      const entries = event.detail?.entries;
      if (!Array.isArray(entries)) {
        return;
      }

      let newEntries = 0;
      for (const entry of entries) {
        const videoId = String(entry.awemeId || "");
        const timestamp = normalizeTimestamp(entry.createTime);
        if (!videoId || !timestamp) {
          continue;
        }
        if (!awemeTimeMap.has(videoId)) {
          newEntries += 1;
        }
        awemeTimeMap.set(videoId, timestamp);
        enqueueNetworkCandidate(videoId, timestamp);
      }

      lastPageEventTick += 1;

      if (newEntries > 0) {
        queueRescan();
      }
    });
  }

  async function init() {
    injectPageHook();
    bindEvents();
    createPanel();
    bindNavigationEvents();
    await restoreTargetDate();
    observePage();
    updateContextVisibility();
    refreshStatus();
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        init().catch((error) => {
          console.error("[Douyin Like Filter] init failed", error);
        });
      },
      { once: true }
    );
  } else {
    init().catch((error) => {
      console.error("[Douyin Like Filter] init failed", error);
    });
  }
})();
