(function (global) {
  const hostname = global.location && global.location.hostname ? String(global.location.hostname).toLowerCase() : "";
  const isLocalHost = hostname === "localhost" || hostname === "127.0.0.1";
  const isGohwHost = hostname === "gohw.net" || hostname.endsWith(".gohw.net");
  const isFileLikeOrigin = !global.location || global.location.protocol === "file:" || global.location.origin === "null";
  const remoteDefaultBase = "https://muralizer.onrender.com";
  const localDefaultBase = "http://127.0.0.1:8787";
  const forceLocalBackend = Boolean(global.SCENIQUE_FORCE_LOCAL_API);
  const originBase = global.location && global.location.origin && global.location.origin !== "null"
    ? global.location.origin
    : remoteDefaultBase;
  const defaultBase = forceLocalBackend
    ? localDefaultBase
    : ((isLocalHost || isFileLikeOrigin || isGohwHost) ? remoteDefaultBase : originBase);
  const rawBase = global.SCENIQUE_API_BASE_URL || defaultBase;
  const baseUrl = rawBase.replace(/\/+$/, "");
  const ownerStorageKey = "sceniqueOwnerId";

  function getAnonymousOwnerId() {
    try {
      const existing = global.localStorage && global.localStorage.getItem(ownerStorageKey);
      if (existing && String(existing).trim()) return String(existing).trim();
    } catch (err) {
      // localStorage may be unavailable in strict modes.
    }

    const nextId = (global.crypto && typeof global.crypto.randomUUID === "function")
      ? global.crypto.randomUUID()
      : `anon_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    try {
      if (global.localStorage) {
        global.localStorage.setItem(ownerStorageKey, nextId);
      }
    } catch (err) {
      // Continue with in-memory id even if persistence fails.
    }

    return nextId;
  }

  function toUrl(path) {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    return `${baseUrl}${cleanPath}`;
  }

  function toUrlWithParams(path, params) {
    const url = new URL(toUrl(path));
    const entries = params && typeof params === "object" ? Object.entries(params) : [];
    entries.forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      url.searchParams.set(key, String(value));
    });
    return url.toString();
  }

  async function post(path, payload) {
    try {
      const response = await fetch(toUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const text = await response.text();
      if (!text) return { ok: true };

      try {
        return JSON.parse(text);
      } catch {
        return { ok: true, text };
      }
    } catch (err) {
      console.warn(`[SceniqueBackend] Failed to sync ${path}:`, err);
      return null;
    }
  }

  function queue(path, payload) {
    void post(path, payload);
  }

  async function get(path, params) {
    try {
      const response = await fetch(toUrlWithParams(path, params), {
        method: "GET",
        headers: { "Content-Type": "application/json" }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const text = await response.text();
      if (!text) return null;
      return JSON.parse(text);
    } catch (err) {
      console.warn(`[SceniqueBackend] Failed to load ${path}:`, err);
      return null;
    }
  }

  async function del(path, params) {
    try {
      const response = await fetch(toUrlWithParams(path, params), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const text = await response.text();
      if (!text) return { ok: true };
      return JSON.parse(text);
    } catch (err) {
      console.warn(`[SceniqueBackend] Failed to delete ${path}:`, err);
      return null;
    }
  }

  function withOwner(payload) {
    const ownerId = getAnonymousOwnerId();
    return {
      ...(payload || {}),
      ownerId: (payload && payload.ownerId) ? payload.ownerId : ownerId
    };
  }

  function resolveOwnerId(candidateOwnerId) {
    const provided = String(candidateOwnerId || "").trim();
    return provided || getAnonymousOwnerId();
  }

  global.SceniqueBackend = {
    baseUrl,
    ownerStorageKey,
    getAnonymousOwnerId,
    toUrl,
    toUrlWithParams,
    post,
    get,
    del,
    saveConceptImage(payload) {
      return post("/api/concept-images", withOwner(payload));
    },
    saveMeasurementRequest(payload) {
      return post("/api/measurement-requests", withOwner(payload));
    },
    loadConceptImages(ownerId) {
      const resolvedOwnerId = resolveOwnerId(ownerId);
      return get("/api/concept-images", { ownerId: resolvedOwnerId });
    },
    deleteConceptImages(params) {
      const safeParams = params && typeof params === "object" ? { ...params } : {};
      safeParams.ownerId = resolveOwnerId(safeParams.ownerId);
      return del("/api/concept-images", safeParams);
    },
    renameConceptImages(payload) {
      const safePayload = payload && typeof payload === "object" ? payload : {};
      const safeFilters = safePayload.filters && typeof safePayload.filters === "object"
        ? { ...safePayload.filters }
        : {};

      safeFilters.ownerId = resolveOwnerId(safeFilters.ownerId);

      return post("/api/concept-images/rename", {
        ...safePayload,
        filters: safeFilters
      });
    },
    ensureDefaultConceptSeed(payload) {
      return post("/api/concept-images/seed-defaults", withOwner(payload));
    },
    queueConceptImage(payload) {
      queue("/api/concept-images", withOwner(payload));
    },
    queueMeasurementRequest(payload) {
      queue("/api/measurement-requests", withOwner(payload));
    }
  };
})(window);
