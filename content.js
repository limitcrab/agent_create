(() => {
  const PANEL_ID = "douyin-like-filter-panel";
  const STORAGE_KEY = "douyin-like-filter-target-date";
  const PAGE_EVENT = "douyin-like-filter:data";
  const SEARCH_STEP_PX = 4200;
  const SEARCH_IDLE_LIMIT = 10;
  const SEARCH_WAIT_MS = 900;
  const SEARCH_POLL_MS = 120;
  const SEARCH_MAX_WAIT_CYCLES = 8;
  const SEARCH_MAX_DURATION_MS = 900000;
  const SEARCH_BOTTOM_CONFIRMATIONS = 3;
  const SEARCH_STALL_RECOVERY_LIMIT = 4;
  const MATCH_WINDOW_DAYS = 5;
  const MATCH_WINDOW_MS = MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const NEARBY_SAMPLE_LIMIT = 10;
  const NEARBY_AVERAGE_WINDOW_DAYS = 10;
  const NEARBY_AVERAGE_WINDOW_MS = NEARBY_AVERAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const DATE_WARNING_WINDOW_DAYS = 365;
  const DATE_WARNING_WINDOW_MS = DATE_WARNING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const awemeTimeMap = new Map();
  const cardState = new Map();
  const videoCardIndex = new Map();

  let lastPageEventTick = 0;
  let panelReady = false;
  let mutationObserver = null;
  let rescanTimer = null;
  let statusNode = null;
  let panelBodyNode = null;
  let targetInput = null;
  let yearSelect = null;
  let monthSelect = null;
  let daySelect = null;
  let collapseButton = null;
  let searchButton = null;
  let continueButton = null;
  let stopButton = null;
  let searchState = null;
  let lastRouteSignature = "";
  let panelCollapsed = false;

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
      /(20\d{2})年(\d{1,2})月(\d{1,2})日?/
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

    const patterns = [/\/video\/(\d+)/, /modal_id=(\d+)/, /aweme_id=(\d+)/];
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

  function getDistanceDays(distance) {
    return Math.round(distance / 86400000);
  }

  function isWithinMatchWindow(distance) {
    return distance <= MATCH_WINDOW_MS;
  }

  function updateStatus(message) {
    if (statusNode) {
      statusNode.textContent = message;
    }
  }

  function getDaysInMonth(year, month) {
    if (!year || !month) {
      return 31;
    }
    return new Date(Number(year), Number(month), 0).getDate();
  }

  function populateDateSelect(select, start, end, formatter) {
    if (!select) {
      return;
    }

    const options = [];
    for (let value = start; value <= end; value += 1) {
      options.push(`<option value="${value}">${formatter ? formatter(value) : value}</option>`);
    }
    select.innerHTML = options.join("");
  }

  function populateYearSelect() {
    if (!yearSelect) {
      return;
    }

    const currentYear = new Date().getFullYear();
    const options = [];
    for (let year = currentYear; year >= 2016; year -= 1) {
      options.push(`<option value="${year}">${year}</option>`);
    }
    yearSelect.innerHTML = options.join("");
  }

  function populateMonthSelect() {
    populateDateSelect(monthSelect, 1, 12, (value) => String(value).padStart(2, "0"));
  }

  function populateDaySelect(preferredDay) {
    const year = Number(yearSelect?.value || 0);
    const month = Number(monthSelect?.value || 0);
    const maxDay = getDaysInMonth(year, month);
    populateDateSelect(daySelect, 1, maxDay, (value) => String(value).padStart(2, "0"));

    if (!daySelect) {
      return;
    }

    const nextDay = Math.min(Number(preferredDay || daySelect.value || 1), maxDay);
    daySelect.value = String(nextDay);
  }

  function syncTargetInputFromSelects() {
    if (!targetInput || !yearSelect || !monthSelect || !daySelect) {
      return;
    }

    const year = yearSelect.value;
    const month = String(monthSelect.value).padStart(2, "0");
    const day = String(daySelect.value).padStart(2, "0");
    targetInput.value = `${year}-${month}-${day}`;
  }

  function getTargetTimestamp() {
    if (!targetInput?.value) {
      return null;
    }
    const timestamp = new Date(`${targetInput.value}T00:00:00`).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function shouldWarnForFarTargetDate(targetTimestamp) {
    if (!targetTimestamp) {
      return false;
    }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return Math.abs(todayStart - targetTimestamp) > DATE_WARNING_WINDOW_MS;
  }

  function applyDateValue(value) {
    if (!value || !yearSelect || !monthSelect || !daySelect) {
      return;
    }

    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      return;
    }

    yearSelect.value = String(Number(match[1]));
    monthSelect.value = String(Number(match[2]));
    populateDaySelect(Number(match[3]));
    daySelect.value = String(Number(match[3]));
    syncTargetInputFromSelects();
  }

  function setDefaultDateParts() {
    const today = new Date();
    if (!yearSelect || !monthSelect || !daySelect) {
      return;
    }

    yearSelect.value = String(today.getFullYear());
    monthSelect.value = String(today.getMonth() + 1);
    populateDaySelect(today.getDate());
    daySelect.value = String(today.getDate());
    syncTargetInputFromSelects();
  }

  async function savePanelState() {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        targetDate: targetInput?.value || "",
        collapsed: panelCollapsed
      }
    });
  }

  async function restorePanelState() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const payload = stored[STORAGE_KEY];
    panelCollapsed = Boolean(payload?.collapsed);

    if (payload?.targetDate) {
      applyDateValue(payload.targetDate);
    } else {
      setDefaultDateParts();
    }
  }

  async function handleDateSelectionChange() {
    populateDaySelect(daySelect?.value);
    syncTargetInputFromSelects();
    await savePanelState();
    refreshStatus();
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

    return /(?:\?|&)(?:tab|showTab)=(?:like|likes|favorite|favourite)/i.test(window.location.search);
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

  function renderPanelCollapsedState() {
    const panel = getPanelNode();
    if (!panel || !panelBodyNode || !collapseButton) {
      return;
    }

    panel.classList.toggle("dlf-panel--collapsed", panelCollapsed);
    panelBodyNode.setAttribute("aria-hidden", panelCollapsed ? "true" : "false");
    collapseButton.textContent = panelCollapsed ? "展开" : "收起";
    collapseButton.setAttribute("aria-label", panelCollapsed ? "展开日期导航插件" : "收起日期导航插件");
  }

  async function togglePanelCollapsed() {
    panelCollapsed = !panelCollapsed;
    renderPanelCollapsedState();
    await savePanelState();
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

  function clearTargetHighlight() {
    for (const card of cardState.keys()) {
      card.classList.remove("dlf-target");
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

  function getAnchorNodes() {
    return Array.from(
      document.querySelectorAll('a[href*="/video/"], a[href*="modal_id="], a[href*="aweme_id="]')
    );
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

    return { totalCards: cardState.size, detectedDates, unknownDates };
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
    sessionState.networkCandidateQueue.push({ key, videoId, timestamp, distance });
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

    const lines = [];
    if (!targetTimestamp) {
      lines.push("选择年、月、日后，开始自动查找。");
    } else {
      lines.push(`目标日期 ${formatDate(targetTimestamp)}`);
    }

    if (sessionState.currentHighlightedKey) {
      lines.push("已锁定一个通过校验的候选视频。");
    } else if (best) {
      if (isWithinMatchWindow(best.distance)) {
        lines.push(`发现接近目标日期的候选，当前相差 ${getDistanceDays(best.distance)} 天。`);
      } else {
        lines.push(`当前最近的视频发布时间相差 ${getDistanceDays(best.distance)} 天。`);
      }
    } else {
      lines.push("等待页面加载更多喜欢视频。");
    }

    updateStatus(lines.concat(extraLines).join("\n"));
    return { stats, best, targetTimestamp };
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
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
      return Math.max(document.documentElement.scrollHeight || 0, document.body.scrollHeight || 0);
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
      // Ignore unsupported environments.
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
      moved: Math.abs(getScrollTop(target) - currentTop),
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

  async function recoverStalledSearch(target) {
    const currentTop = getScrollTop(target);
    const clientHeight = getClientHeight(target);
    const jumpStep = Math.max(1200, Math.floor(clientHeight * 1.35));

    await primeAutoLoading(target);
    setScrollTop(target, currentTop + jumpStep, "auto");
    emitWheelLikeEvents(target, jumpStep);
    await wait(650);

    return getScrollTop(target);
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

    return {
      card,
      key: getCardKey(card, info),
      timestamp,
      distance,
      position: getCardAbsoluteTop(card, scrollTarget),
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
    const timeline = getLoadedTimelineEntries(scrollTarget);
    const index = timeline.findIndex((entry) => entry.key === candidate.key);
    if (index === -1) {
      return [];
    }

    const samples = [];
    let left = index - 1;
    let right = index + 1;

    while (samples.length < NEARBY_SAMPLE_LIMIT && (left >= 0 || right < timeline.length)) {
      const leftEntry = left >= 0 ? timeline[left] : null;
      const rightEntry = right < timeline.length ? timeline[right] : null;
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

  function validateCandidateByNeighborhood(candidate, scrollTarget, targetTimestamp) {
    const nearbySamples = collectNearbySamples(candidate, scrollTarget);
    if (nearbySamples.length === 0) {
      return {
        passed: false,
        sampleCount: 0,
        averageTimestamp: null,
        averageDistance: Number.POSITIVE_INFINITY
      };
    }

    const averageTimestamp =
      nearbySamples.reduce((sum, sample) => sum + sample.timestamp, 0) / nearbySamples.length;
    const averageDistance = Math.abs(averageTimestamp - targetTimestamp);

    return {
      passed: averageDistance <= NEARBY_AVERAGE_WINDOW_MS,
      sampleCount: nearbySamples.length,
      averageTimestamp,
      averageDistance
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

  async function runCandidateSearch({ resetToTop }) {
    if (!updateContextVisibility()) {
      updateStatus("当前不在喜欢列表页，插件已隐藏。请先回到个人主页的喜欢列表。");
      return;
    }

    const targetTimestamp = getTargetTimestamp();
    if (!targetTimestamp) {
      updateStatus("请选择完整的年、月、日后再开始查找。");
      return;
    }

    if (resetToTop && shouldWarnForFarTargetDate(targetTimestamp)) {
      const confirmed = window.confirm(
        `你选择的目标日期 ${formatDate(targetTimestamp)} 与今天相差超过一年。\n\n请确认这不是填错日期。如果确认无误，点击“确定”继续查找。`
      );
      if (!confirmed) {
        updateStatus("已取消搜索。你可以重新确认一下目标日期。");
        return;
      }
    }

    await savePanelState();
    if (searchState?.running) {
      return;
    }

    scanCards();
    searchState = {
      running: true,
      lastCardCount: cardState.size,
      idleRounds: 0,
      bottomHits: 0,
      stallRecoveries: 0,
      steps: 0,
      scrollTarget: null,
      startedAt: Date.now(),
      timedOut: false
    };
    setSearchRunning(true);

    refreshStatus([
      resetToTop ? "正在从顶部自动查找更接近这个日期的候选视频..." : "继续从当前位置往后自动查找..."
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
        refreshStatus(["已回到喜欢列表顶部，开始自动查找。"]);
      } else {
        await primeAutoLoading(scrollTarget);
        sessionState.hasStarted = true;
        refreshStatus(["继续从当前位置往后找下一个候选。"]);
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
          findNextCandidate(targetTimestamp, searchState.scrollTarget, sessionState.lastSuggestedPosition);

        if (candidate) {
          const validation = validateCandidateByNeighborhood(
            candidate,
            searchState.scrollTarget,
            targetTimestamp
          );
          sessionState.visitedKeys.add(candidate.key);
          sessionState.lastSuggestedPosition = candidate.position;
          sessionState.hasStarted = true;

          if (validation.passed) {
            sessionState.currentHighlightedKey = candidate.key;
            clearTargetHighlight();
            candidate.card.classList.add("dlf-target");
            scrollCardIntoView(candidate.card);
            refreshStatus([
              `已找到更可信的候选视频：${formatDate(candidate.timestamp)}`,
              `与目标日期相差 ${getDistanceDays(candidate.distance)} 天，邻域校验已通过。`
            ]);
            return;
          }

          sessionState.currentHighlightedKey = null;
          refreshStatus([
            `跳过 ${formatDate(candidate.timestamp)}，它周围的视频时间分布不够稳定。`,
            "继续自动查找下一个更可信的候选。"
          ]);
        }

        searchState.steps += 1;
        const scrollResult = await scrollSearchTarget(searchState.scrollTarget, 1);
        const { stats } = refreshStatus(["正在自动向下查找，请稍等..."]);

        if (stats.totalCards > searchState.lastCardCount) {
          searchState.lastCardCount = stats.totalCards;
          searchState.idleRounds = 0;
          searchState.bottomHits = 0;
          searchState.stallRecoveries = 0;
        } else {
          searchState.idleRounds += 1;
        }

        if (scrollResult.moved < 24 && searchState.stallRecoveries < SEARCH_STALL_RECOVERY_LIMIT) {
          searchState.stallRecoveries += 1;
          const recoveredTop = await recoverStalledSearch(searchState.scrollTarget);
          if (recoveredTop > scrollResult.afterTop + 24) {
            searchState.idleRounds = Math.max(0, searchState.idleRounds - 1);
            searchState.bottomHits = 0;
            continue;
          }
        }

        if (searchState.idleRounds >= 2) {
          const newTarget = resolveScrollTarget();
          if (newTarget !== searchState.scrollTarget) {
            searchState.scrollTarget = newTarget;
            sessionState.scrollTarget = newTarget;
            searchState.idleRounds = 0;
            searchState.bottomHits = 0;
            await primeAutoLoading(searchState.scrollTarget);
          }
        }

        if (scrollResult.reachedBottom) {
          searchState.bottomHits += 1;
        } else {
          searchState.bottomHits = 0;
        }

        if (
          searchState.bottomHits >= SEARCH_BOTTOM_CONFIRMATIONS &&
          searchState.idleRounds >= 3 &&
          sessionState.candidateQueue.length === 0 &&
          sessionState.networkCandidateQueue.length === 0
        ) {
          break;
        }

        if (
          searchState.idleRounds >= SEARCH_IDLE_LIMIT &&
          searchState.stallRecoveries >= SEARCH_STALL_RECOVERY_LIMIT
        ) {
          break;
        }
      }

      if (!searchState.running) {
        refreshStatus(["搜索已停止。"]);
        return;
      }

      if (searchState.timedOut) {
        refreshStatus(["搜索时间有点长，已自动暂停。点击“继续查找”可以从当前位置接着找。"]);
      } else {
        refreshStatus(["后面暂时没有找到更可信的候选视频。可以换个日期，或者继续往后找。"]);
      }
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
      updateStatus("先点击一次“开始查找”，插件才知道从哪里继续。");
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
      <div class="dlf-panel__particles" aria-hidden="true">
        <span class="dlf-particle dlf-particle--1"></span>
        <span class="dlf-particle dlf-particle--2"></span>
        <span class="dlf-particle dlf-particle--3"></span>
        <span class="dlf-particle dlf-particle--4"></span>
        <span class="dlf-particle dlf-particle--5"></span>
        <span class="dlf-particle dlf-particle--6"></span>
      </div>
      <button type="button" class="dlf-panel__toggle" id="dlf-toggle">收起</button>
      <div class="dlf-panel__body">
        <div class="dlf-panel__eyebrow">Like Date Finder</div>
        <h2 class="dlf-panel__title">喜欢日期导航</h2>
        <p class="dlf-panel__desc">选一个你想回到的日期，让插件在喜欢列表里自动往下找。</p>
        <div class="dlf-panel__date-stage">
          <div class="dlf-panel__glow-ring"></div>
          <div class="dlf-panel__date-head">
            <span class="dlf-panel__label">目标日期</span>
            <span class="dlf-panel__hint">年 / 月 / 日 分开选，更顺手</span>
          </div>
          <div class="dlf-panel__picker-row">
            <label class="dlf-picker">
              <span class="dlf-picker__tag">年</span>
              <select id="dlf-year"></select>
            </label>
            <label class="dlf-picker">
              <span class="dlf-picker__tag">月</span>
              <select id="dlf-month"></select>
            </label>
            <label class="dlf-picker">
              <span class="dlf-picker__tag">日</span>
              <select id="dlf-day"></select>
            </label>
          </div>
          <input type="hidden" id="dlf-target-date" />
        </div>
        <div class="dlf-panel__actions">
          <button type="button" class="dlf-btn dlf-btn--primary" id="dlf-jump">开始查找</button>
          <button type="button" class="dlf-btn dlf-btn--ghost" id="dlf-continue" disabled>继续查找</button>
        </div>
        <div class="dlf-panel__actions">
          <button type="button" class="dlf-btn dlf-btn--secondary" id="dlf-stop" disabled>停止查找</button>
        </div>
        <div class="dlf-panel__status" id="dlf-status">选择一个日期后开始自动查找。</div>
      </div>
    `;

    document.body.appendChild(panel);
    panelReady = true;

    panelBodyNode = panel.querySelector(".dlf-panel__body");
    statusNode = panel.querySelector("#dlf-status");
    targetInput = panel.querySelector("#dlf-target-date");
    yearSelect = panel.querySelector("#dlf-year");
    monthSelect = panel.querySelector("#dlf-month");
    daySelect = panel.querySelector("#dlf-day");
    collapseButton = panel.querySelector("#dlf-toggle");
    searchButton = panel.querySelector("#dlf-jump");
    continueButton = panel.querySelector("#dlf-continue");
    stopButton = panel.querySelector("#dlf-stop");

    populateYearSelect();
    populateMonthSelect();
    populateDaySelect(1);

    collapseButton?.addEventListener("click", () => {
      togglePanelCollapsed().catch((error) => {
        console.error("[Douyin Like Filter] toggle failed", error);
      });
    });

    yearSelect?.addEventListener("change", () => {
      handleDateSelectionChange().catch((error) => {
        console.error("[Douyin Like Filter] year change failed", error);
      });
    });

    monthSelect?.addEventListener("change", () => {
      handleDateSelectionChange().catch((error) => {
        console.error("[Douyin Like Filter] month change failed", error);
      });
    });

    daySelect?.addEventListener("change", () => {
      handleDateSelectionChange().catch((error) => {
        console.error("[Douyin Like Filter] day change failed", error);
      });
    });

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
    await restorePanelState();
    renderPanelCollapsedState();
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
