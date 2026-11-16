// ==UserScript==
// @name         Google Flow Helper - Safer XHR Handling
// @namespace    https://github.com/maanimeisam
// @version      1.2
// @description  Defensive XHR response handling with validated, cached specs.
// @match        https://flow.google.com/*
// @match        https://labs.google/fx/tools/flow*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      flow.cfcnode.com
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const SPEC_URL = "https://flow.cfcnode.com/v1/flow-spec";
  const SPEC_TTL_MS = 6 * 60 * 60 * 1000;
  const CACHE_KEY = "specCache";
  const PREFIX = "[Google Flow Helper]";
  const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const XHR = page.XMLHttpRequest;

  if (!XHR || !XHR.prototype) return;

  let spec = null;
  const targetRequests = new WeakMap();
  const computedResponses = new WeakMap();
  const encoder = new TextEncoder();

  function validateSpec(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.path === "string" &&
      value.path.startsWith("/") &&
      !value.path.startsWith("//") &&
      typeof value.rpcids === "string" &&
      value.rpcids.length > 0 &&
      typeof value.tag === "string" &&
      value.tag.length > 0 &&
      Number.isInteger(value.flagIndex) &&
      value.flagIndex >= 0 &&
      value.flagIndex < 1000 &&
      Number.isInteger(value.minLength) &&
      value.minLength > value.flagIndex &&
      value.minLength <= 1000
    );
  }

  function loadSpec() {
    let cached = null;
    try {
      cached = GM_getValue(CACHE_KEY, null);
    } catch (error) {
      console.warn(PREFIX, "Cannot read cached configuration:", error);
    }

    // A previously verified cached spec is used immediately, even when stale,
    // until a new spec is downloaded. Requests are never blocked while waiting.
    if (cached && validateSpec(cached.data)) {
      spec = cached.data;
      if (
        Number.isFinite(cached.timestamp) &&
        Date.now() - cached.timestamp >= 0 &&
        Date.now() - cached.timestamp < SPEC_TTL_MS
      ) {
        return;
      }
    }

    try {
      GM_xmlhttpRequest({
        method: "GET",
        url: SPEC_URL,
        timeout: 10000,
        onload(result) {
          if (result.status < 200 || result.status >= 300) {
            console.warn(PREFIX, "Spec HTTP status:", result.status);
            return;
          }
          try {
            const next = JSON.parse(result.responseText);
            if (!validateSpec(next)) {
              console.warn(PREFIX, "Spec has an unexpected structure");
              return;
            }
            spec = next;
            GM_setValue(CACHE_KEY, {
              data: next,
              timestamp: Date.now(),
            });
          } catch (error) {
            console.warn(PREFIX, "Invalid spec JSON or cache write failed:", error);
          }
        },
        onerror(error) {
          console.warn(PREFIX, "Spec request failed:", error);
        },
        ontimeout() {
          console.warn(PREFIX, "Spec request timed out");
        },
      });
    } catch (error) {
      console.warn(PREFIX, "Could not start spec request:", error);
    }
  }

  function matchTarget(url) {
    if (!spec) return false;
    try {
      const requested = new URL(url, page.location.href);
      return (
        requested.origin === page.location.origin &&
        requested.pathname === spec.path &&
        requested.searchParams.get("rpcids") === spec.rpcids
      );
    } catch {
      return false;
    }
  }

  function patchResponse(body, currentSpec) {
    const lines = body.split("\n");
    let hits = 0;
    const changes = [];

    for (let i = 1; i < lines.length; i++) {
      const hasCR = lines[i].endsWith("\r");
      const rawLine = hasCR ? lines[i].slice(0, -1) : lines[i];
      if (!rawLine.startsWith("[[")) continue;

      let frame;
      try {
        frame = JSON.parse(rawLine);
      } catch {
        continue;
      }
      if (!Array.isArray(frame)) continue;

      let modified = false;
      for (const item of frame) {
        if (
          !Array.isArray(item) ||
          item[0] !== currentSpec.tag ||
          item[1] !== currentSpec.rpcids ||
          typeof item[2] !== "string"
        ) continue;

        let data;
        try {
          data = JSON.parse(item[2]);
        } catch {
          continue;
        }
        if (
          !Array.isArray(data) ||
          data.length < currentSpec.minLength ||
          !(
            data[currentSpec.flagIndex] === null ||
            typeof data[currentSpec.flagIndex] === "boolean"
          )
        ) continue;

        data[currentSpec.flagIndex] = true;
        item[2] = JSON.stringify(data);
        hits++;
        modified = true;
      }
      if (!modified) continue;

      const lengthPrefix = lines[i - 1].trim();
      if (!/^\d+$/.test(lengthPrefix)) return body;
      const oldLength = Number(lengthPrefix);
      const newLine = JSON.stringify(frame);
      const byteLength = (s) => encoder.encode(s).length;
      const lengthFunction = [byteLength, (s) => s.length].find((fn) =>
        [0, 1, 2].includes(oldLength - fn(rawLine))
      );
      if (!lengthFunction) return body;

      const updatedLength = oldLength +
        lengthFunction(newLine) - lengthFunction(rawLine);
      if (!Number.isSafeInteger(updatedLength) || updatedLength < 0) return body;

      changes.push({ index: i, newLine: newLine + (hasCR ? "\r" : ""),
        updatedLength: String(updatedLength) });
    }

    // Do not return a partially transformed response if its structure differs.
    if (hits !== 1 || changes.length !== 1) return body;

    for (const change of changes) {
      lines[change.index - 1] = change.updatedLength;
      lines[change.index] = change.newLine;
    }
    return lines.join("\n");
  }

  const proto = XHR.prototype;
  const originalOpen = proto.open;
  proto.open = function (method, url, ...args) {
    // Reset state on reused XMLHttpRequest objects.
    targetRequests.delete(this);
    computedResponses.delete(this);
    const result = Reflect.apply(originalOpen, this, [method, url, ...args]);
    if (matchTarget(url)) targetRequests.set(this, spec);
    return result;
  };

  for (const property of ["responseText", "response"]) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, property);
    if (!descriptor || typeof descriptor.get !== "function" ||
        !descriptor.configurable) continue;

    Object.defineProperty(proto, property, {
      ...descriptor,
      get() {
        const original = Reflect.apply(descriptor.get, this, []);
        if (
          this.readyState !== 4 ||
          !targetRequests.has(this) ||
          typeof original !== "string" ||
          !["", "text"].includes(this.responseType)
        ) return original;

        if (!computedResponses.has(this)) {
          const requestSpec = targetRequests.get(this);
          try {
            computedResponses.set(this, patchResponse(original, requestSpec));
          } catch (error) {
            console.warn(PREFIX, "Could not process response:", error);
            computedResponses.set(this, original);
          }
        }
        return computedResponses.get(this);
      },
    });
  }

  loadSpec();
})();
