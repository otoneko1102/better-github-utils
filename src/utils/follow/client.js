const pending = new Map();
const cache = new Map();
const pendingLists = new Map();

export function clearCache() {
  pending.clear();
  cache.clear();
  pendingLists.clear();
}

function ensureViewerLists(viewer) {
  if (!viewer) return Promise.resolve({ followers: [] });
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
  return p;
}

export async function getFollowStatusOnce(viewer, target) {
  const key = `${viewer}::${target}`;
  if (cache.has(key)) return cache.get(key);
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
          cache.set(key, fallback);
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
        cache.set(key, direct);
        return direct;
      } catch (e) {
        console.warn("[gh-utils] direct fetch fallback failed", e, {
          viewer,
          target,
        });
      }

      cache.set(key, null);
      return null;
    }

    const result = {
      viewerFollowsTarget: null,
      targetFollowsViewer: (lists.followers || []).includes(vt),
    };
    cache.set(key, result);
    return result;
  })();
  pending.set(key, p);
  p.finally(() => pending.delete(key));
  return p;
}

export function getCachedFollowStatus(viewer, target) {
  const key = `${viewer}::${target}`;
  return cache.has(key) ? cache.get(key) : undefined;
}
