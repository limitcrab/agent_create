(() => {
  const PAGE_EVENT = "douyin-like-filter:data";
  const seenSignature = new Set();

  function emit(entries) {
    if (!entries.length) {
      return;
    }

    const deduped = [];
    for (const entry of entries) {
      const signature = `${entry.awemeId}:${entry.createTime}`;
      if (seenSignature.has(signature)) {
        continue;
      }
      seenSignature.add(signature);
      deduped.push(entry);
    }

    if (!deduped.length) {
      return;
    }

    window.dispatchEvent(new CustomEvent(PAGE_EVENT, { detail: { entries: deduped } }));
  }

  function normalizeEntry(candidate) {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }

    const awemeId = candidate.aweme_id || candidate.awemeId || candidate.group_id || candidate.item_id;
    const createTime =
      candidate.create_time ||
      candidate.createTime ||
      candidate.author_create_time ||
      candidate.publish_time;

    if (!awemeId || !createTime) {
      return null;
    }

    return {
      awemeId: String(awemeId),
      createTime: Number(createTime)
    };
  }

  function collectEntries(root) {
    const result = [];
    const queue = [root];
    const visited = new WeakSet();

    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== "object") {
        continue;
      }
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);

      if (Array.isArray(current)) {
        for (const item of current) {
          queue.push(item);
        }
        continue;
      }

      const normalized = normalizeEntry(current);
      if (normalized) {
        result.push(normalized);
      }

      for (const value of Object.values(current)) {
        if (value && typeof value === "object") {
          queue.push(value);
        }
      }
    }

    return result;
  }

  function inspectPayload(payload) {
    try {
      const entries = collectEntries(payload);
      emit(entries);
    } catch (error) {
      console.debug("[Douyin Like Filter] inspect payload failed", error);
    }
  }

  async function inspectResponse(response, url) {
    try {
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("json")) {
        return;
      }

      const looksRelevant =
        /aweme|favorite|like|profile|user/i.test(url) ||
        /aweme|favorite|like|profile|user/i.test(response.url || "");

      if (!looksRelevant) {
        return;
      }

      const data = await response.clone().json();
      inspectPayload(data);
    } catch (error) {
      console.debug("[Douyin Like Filter] inspect response failed", error);
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
    inspectResponse(response, requestUrl);
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__dlf_url = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    this.addEventListener("load", () => {
      try {
        const contentType = this.getResponseHeader("content-type") || "";
        if (!contentType.includes("json")) {
          return;
        }

        const url = String(this.__dlf_url || "");
        if (!/aweme|favorite|like|profile|user/i.test(url)) {
          return;
        }

        const payload = JSON.parse(this.responseText);
        inspectPayload(payload);
      } catch (error) {
        console.debug("[Douyin Like Filter] inspect xhr failed", error);
      }
    }, { once: true });

    return originalSend.apply(this, args);
  };

  window.addEventListener("load", () => {
    try {
      const candidates = [
        window.__INITIAL_STATE__,
        window.__INIT_PROPS__,
        window._ROUTER_DATA
      ];
      for (const candidate of candidates) {
        inspectPayload(candidate);
      }
    } catch (error) {
      console.debug("[Douyin Like Filter] inspect initial state failed", error);
    }
  }, { once: true });
})();
