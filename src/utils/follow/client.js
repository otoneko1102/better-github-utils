const pending = new Map();
const cache = new Map();
const pendingLists = new Map();
const listsCache = new Map();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PERSIST_KEY_CACHE = "gh_follow_cache_v1";
const PERSIST_KEY_LISTS = "gh_lists_cache_v1";
let _persistTimer = null;

function schedulePersistSave() {
  try {
    if (_persistTimer) return;
    _persistTimer = setTimeout(() => {
      _persistTimer = null;
      try {
        const c = {};
        cache.forEach((v, k) => {
          try {
            if (v && v.ts && typeof v.value !== "undefined") c[k] = v;
          } catch (e) {}
        });
        const l = {};
        listsCache.forEach((v, k) => {
          try {
            if (v && v.ts && typeof v.value !== "undefined") l[k] = v;
          } catch (e) {}
        });
        try {
          chrome.storage.local.set({
            [PERSIST_KEY_CACHE]: c,
            [PERSIST_KEY_LISTS]: l,
          });
        } catch (e) {}
      } catch (e) {}
    }, 600);
  } catch (e) {}
}

function loadPersistentCache() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(
        [PERSIST_KEY_CACHE, PERSIST_KEY_LISTS],
        (items) => {
          try {
            const now = Date.now();
            const c =
              items && items[PERSIST_KEY_CACHE] ? items[PERSIST_KEY_CACHE] : {};
            const l =
              items && items[PERSIST_KEY_LISTS] ? items[PERSIST_KEY_LISTS] : {};
            Object.keys(c || {}).forEach((k) => {
              try {
                const e = c[k];
                if (e && e.ts && now - e.ts < CACHE_TTL_MS) cache.set(k, e);
              } catch (e) {}
            });
            Object.keys(l || {}).forEach((k) => {
              try {
                const e = l[k];
                if (e && e.ts && now - e.ts < CACHE_TTL_MS)
                  listsCache.set(k, e);
              } catch (e) {}
            });
          } catch (e) {}
          resolve();
        },
      );
    } catch (e) {
      resolve();
    }
  });
}

// load persisted entries on module init
try {
  loadPersistentCache().catch(() => {});
} catch (e) {}

export function clearCache() {
  pending.clear();
  cache.clear();
  pendingLists.clear();
  listsCache.clear();
}

function ensureViewerLists(viewer) {
  if (!viewer) return Promise.resolve({ followers: [] });
  // prefer cached lists if fresh
  try {
    if (listsCache.has(viewer)) {
      const entry = listsCache.get(viewer);
      if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
        return Promise.resolve(entry.value);
      }
      listsCache.delete(viewer);
    }
  } catch (e) {}
  if (pendingLists.has(viewer)) return pendingLists.get(viewer);

  const attemptSend = async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const resp = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: "getLists", viewer }, (resp) => {
            const lastError = chrome.runtime.lastError;
            if (lastError) {
              console.warn(
                "[gh-utils] ensureViewerLists: runtime.lastError",
                lastError,
                { viewer, attempt },
              );
              resolve(null);
              return;
            }
            resolve(resp || null);
          });
        } catch (e) {
          console.warn("[gh-utils] ensureViewerLists: sendMessage threw", e, {
            viewer,
            attempt,
          });
          resolve(null);
        }
      });

      if (resp && resp.followers && resp.followers.length >= 0) {
        try {
          console.debug("[gh-utils] ensureViewerLists response", {
            viewer,
            resp,
          });
        } catch (e) {}
        return resp;
      }

      await new Promise((r) => setTimeout(r, 200 * attempt));
    }

    return { followers: [] };
  };

  const p = attemptSend().finally(() => pendingLists.delete(viewer));
  pendingLists.set(viewer, p);
  // When resolved, cache the lists for TTL
  p.then((res) => {
    try {
      if (res) {
        listsCache.set(viewer, { value: res, ts: Date.now() });
        schedulePersistSave();
      }
    } catch (e) {}
  }).catch(() => {});
  return p;
}

export async function getFollowStatusOnce(viewer, target) {
  const key = `${viewer}::${target}`;
  if (cache.has(key)) {
    try {
      const entry = cache.get(key);
      if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.value;
      cache.delete(key);
    } catch (e) {}
  }
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    const lists = await ensureViewerLists(viewer);
    const vt = (target || "").toLowerCase();

    if (lists.error || !(lists.followers && lists.followers.length)) {
      try {
        let attempts = 0;
        let fallback = null;
        while (attempts < 3 && !fallback) {
          attempts++;
          try {
            fallback = await new Promise((resolve) => {
              try {
                chrome.runtime.sendMessage(
                  { type: "checkFollow", viewer, target },
                  (resp) => {
                    const lastError = chrome.runtime.lastError;
                    if (lastError) {
                      console.warn(
                        "[gh-utils] fallback checkFollow runtime.lastError",
                        lastError,
                        { viewer, target, attempt: attempts },
                      );
                      resolve(null);
                      return;
                    }
                    resolve(resp || null);
                  },
                );
              } catch (e) {
                console.warn(
                  "[gh-utils] fallback checkFollow sendMessage threw",
                  e,
                  { viewer, target, attempt: attempts },
                );
                resolve(null);
              }
            });
          } catch (e) {
            console.warn("[gh-utils] fallback checkFollow promise error", e, {
              viewer,
              target,
              attempt: attempts,
            });
            fallback = null;
          }

          if (!fallback && attempts < 3)
            await new Promise((r) => setTimeout(r, 200));
        }
        if (fallback) {
          cache.set(key, { value: fallback, ts: Date.now() });
          schedulePersistSave();
          return fallback;
        }
      } catch (e) {
        console.warn("[gh-utils] fallback checkFollow error", e, {
          viewer,
          target,
        });
      }

      try {
        const headers = { Accept: "application/vnd.github.v3+json" };
        const res1 = await fetch(
          `https://api.github.com/users/${encodeURIComponent(viewer)}/following/${encodeURIComponent(target)}`,
          { method: "GET", headers, cache: "no-store" },
        );
        const res2 = await fetch(
          `https://api.github.com/users/${encodeURIComponent(target)}/following/${encodeURIComponent(viewer)}`,
          { method: "GET", headers, cache: "no-store" },
        );
        const viewerFollowsTarget = res1.status === 204;
        const targetFollowsViewer = res2.status === 204;
        const direct = { viewerFollowsTarget, targetFollowsViewer };
        console.debug("[gh-utils] direct fetch fallback", {
          viewer,
          target,
          status1: res1.status,
          status2: res2.status,
        });
        cache.set(key, { value: direct, ts: Date.now() });
        schedulePersistSave();
        return direct;
      } catch (e) {
        console.warn("[gh-utils] direct fetch fallback failed", e, {
          viewer,
          target,
        });
      }

      cache.set(key, { value: null, ts: Date.now() });
      schedulePersistSave();
      return null;
    }

    const result = {
      viewerFollowsTarget: null,
      targetFollowsViewer: (lists.followers || []).includes(vt),
    };
    cache.set(key, { value: result, ts: Date.now() });
    schedulePersistSave();
    return result;
  })();
  pending.set(key, p);
  p.finally(() => pending.delete(key));
  return p;
}

export function getCachedFollowStatus(viewer, target) {
  const key = `${viewer}::${target}`;
  try {
    if (!cache.has(key)) return undefined;
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts >= CACHE_TTL_MS) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  } catch (e) {
    return undefined;
  }
}
