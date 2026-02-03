async function getToken() {
  return new Promise((resolve) =>
    chrome.storage.sync.get(["github_utils_token"], (r) =>
      resolve(r.github_utils_token || null),
    ),
  );
}

// Cache configuration
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const PERSIST_KEY_LISTS = "gh_bg_lists_cache_v1";
const PERSIST_KEY_CHECK = "gh_bg_check_cache_v1";
const _listsCache = new Map();
const _checkCache = new Map();
let _persistTimer = null;

function schedulePersistSave() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      const lists = {};
      _listsCache.forEach((v, k) => {
        if (v && v.ts && v.data) lists[k] = v;
      });
      const checks = {};
      _checkCache.forEach((v, k) => {
        if (v && v.ts && v.data) checks[k] = v;
      });
      chrome.storage.local.set({
        [PERSIST_KEY_LISTS]: lists,
        [PERSIST_KEY_CHECK]: checks,
      });
    } catch (e) {
      console.warn("[gh-utils] bg schedulePersistSave error", e);
    }
  }, 500);
}

function loadPersistentCache() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([PERSIST_KEY_LISTS, PERSIST_KEY_CHECK], (items) => {
        const now = Date.now();
        const lists = items?.[PERSIST_KEY_LISTS] || {};
        const checks = items?.[PERSIST_KEY_CHECK] || {};
        Object.keys(lists).forEach((k) => {
          const e = lists[k];
          if (e && e.ts && now - e.ts < CACHE_TTL) _listsCache.set(k, e);
        });
        Object.keys(checks).forEach((k) => {
          const e = checks[k];
          if (e && e.ts && now - e.ts < CACHE_TTL) _checkCache.set(k, e);
        });
        console.debug("[gh-utils] bg loadPersistentCache loaded", {
          lists: _listsCache.size,
          checks: _checkCache.size,
        });
        resolve();
      });
    } catch (e) {
      console.warn("[gh-utils] bg loadPersistentCache error", e);
      resolve();
    }
  });
}

// Load persisted cache on startup
loadPersistentCache().catch(() => {});

function parseLinkHeader(header) {
  if (!header) return {};
  const parts = header.split(",");
  const map = {};
  for (const p of parts) {
    const m = p.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (m) map[m[2]] = m[1];
  }
  return map;
}

async function fetchPaged(url, token) {
  const headers = { Accept: "application/vnd.github.v3+json" };
  if (token) headers["Authorization"] = `token ${token}`;
  const results = [];
  let next = url;
  try {
    while (next) {
      const res = await fetch(next, {
        method: "GET",
        headers,
        cache: "no-store",
      });
      try {
        const remaining = res.headers.get("x-ratelimit-remaining");
        const limit = res.headers.get("x-ratelimit-limit");
        const reset = res.headers.get("x-ratelimit-reset");
        console.debug("[gh-utils] bg fetchPaged", {
          url: next,
          status: res.status,
          remaining,
          limit,
          reset,
        });
      } catch (e) {}
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.warn("[gh-utils] bg fetchPaged non-ok", {
          url: next,
          status: res.status,
          body: txt && txt.slice ? txt.slice(0, 300) : txt,
        });
        const err = new Error(`fetchPaged failed: ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const json = await res.json();
      if (Array.isArray(json)) results.push(...json);
      const links = parseLinkHeader(res.headers.get("link") || "");
      next = links.next || null;
    }
  } catch (e) {
    console.warn("[gh-utils] bg fetchPaged error", e, { url });
  }
  return results;
}

function itemsToSet(items) {
  const set = new Set();
  for (const i of items) if (i && i.login) set.add(i.login.toLowerCase());
  return set;
}

async function getAuthenticatedUser(token) {
  if (!token) return null;
  try {
    const headers = {
      Accept: "application/vnd.github.v3+json",
      Authorization: `token ${token}`,
    };
    const res = await fetch("https://api.github.com/user", {
      method: "GET",
      headers,
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn("[gh-utils] bg getAuthenticatedUser failed", {
        status: res.status,
      });
      return null;
    }
    const json = await res.json();
    return json && json.login ? json.login.toLowerCase() : null;
  } catch (e) {
    console.warn("[gh-utils] bg getAuthenticatedUser error", e);
    return null;
  }
}

async function getAuthFollowers(token) {
  const items = await fetchPaged(
    "https://api.github.com/user/followers",
    token,
  );
  return itemsToSet(items);
}

async function getAuthFollowing(token) {
  const items = await fetchPaged(
    "https://api.github.com/user/following",
    token,
  );
  return itemsToSet(items);
}

async function getFollowersList(username, token) {
  const url = `https://api.github.com/users/${encodeURIComponent(username)}/followers`;
  const items = await fetchPaged(url, token);
  return itemsToSet(items);
}

async function checkFollowing(viewer, target) {
  const cacheKey = `${viewer.toLowerCase()}::${target.toLowerCase()}`;
  const now = Date.now();

  // Check cache first
  if (_checkCache.has(cacheKey)) {
    const cached = _checkCache.get(cacheKey);
    if (cached && now - cached.ts < CACHE_TTL) {
      console.debug("[gh-utils] bg checkFollowing cache hit", { viewer, target, age: now - cached.ts });
      return cached.data;
    }
    _checkCache.delete(cacheKey);
  }

  const token = await getToken();
  const headers = { Accept: "application/vnd.github.v3+json" };
  if (token) headers["Authorization"] = `token ${token}`;
  let viewerFollowsTarget = false;
  let targetFollowsViewer = false;
  try {
    const res1 = await fetch(
      `https://api.github.com/users/${encodeURIComponent(viewer)}/following/${encodeURIComponent(target)}`,
      { method: "GET", headers, cache: "no-store" },
    );
    console.debug("[gh-utils] bg checkFollowing res", {
      viewer,
      target,
      status: res1.status,
    });
    viewerFollowsTarget = res1.status === 204;
  } catch (e) {
    console.warn(
      "[gh-utils] bg checkFollowing error (viewer->target)",
      viewer,
      target,
      e,
    );
  }
  try {
    const res2 = await fetch(
      `https://api.github.com/users/${encodeURIComponent(target)}/following/${encodeURIComponent(viewer)}`,
      { method: "GET", headers, cache: "no-store" },
    );
    console.debug("[gh-utils] bg checkFollowing res reverse", {
      viewer,
      target,
      status: res2.status,
    });
    targetFollowsViewer = res2.status === 204;
  } catch (e) {
    console.warn(
      "[gh-utils] bg checkFollowing error (target->viewer)",
      viewer,
      target,
      e,
    );
  }

  const result = { viewerFollowsTarget, targetFollowsViewer };
  _checkCache.set(cacheKey, { data: result, ts: Date.now() });
  schedulePersistSave();
  return result;
}

async function getListsForUser(username) {
  const key = (username || "").toLowerCase();
  const now = Date.now();

  // Check cache first
  if (_listsCache.has(key)) {
    const cached = _listsCache.get(key);
    if (cached && now - cached.ts < CACHE_TTL) {
      console.debug("[gh-utils] bg getListsForUser cache hit", { username: key, age: now - cached.ts });
      return cached.data;
    }
    _listsCache.delete(key);
  }

  const token = await getToken();
  try {
    let result;
    if (token) {
      const authLogin = await getAuthenticatedUser(token);
      if (authLogin && authLogin.toLowerCase() === key) {
        const [followers, following] = await Promise.all([
          getAuthFollowers(token),
          getAuthFollowing(token),
        ]);
        result = {
          followers: Array.from(followers),
          following: Array.from(following),
          fetchedAt: Date.now(),
        };
        _listsCache.set(key, { data: result, ts: Date.now() });
        schedulePersistSave();
        return result;
      }
    }
    const followers = await getFollowersList(username, token);
    result = { followers: Array.from(followers), fetchedAt: Date.now() };
    _listsCache.set(key, { data: result, ts: Date.now() });
    schedulePersistSave();
    return result;
  } catch (e) {
    console.warn("[gh-utils] bg getListsForUser failed", e, { username });
    return { followers: [], fetchedAt: Date.now(), error: true };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.type !== "checkFollow" && msg.type !== "getLists")) return;

  (async () => {
    try {
      const token = await getToken();
      if (!token) {
        try {
          console.warn(
            "[gh-utils] background: token missing — refusing to operate",
          );
        } catch (e) {}
        if (msg.type === "checkFollow") {
          sendResponse(null);
          return;
        }
        if (msg.type === "getLists") {
          sendResponse({ followers: [] });
          return;
        }
      }

      if (msg && msg.type === "checkFollow") {
        const { viewer, target } = msg;
        if (!viewer || !target) {
          sendResponse(null);
          return;
        }
        try {
          console.debug("[gh-utils] background: checkFollow (direct)", {
            viewer,
            target,
          });
          const res = await checkFollowing(viewer, target);
          if (!res) {
            console.warn(
              "[gh-utils] background: checkFollowing returned null",
              {
                viewer,
                target,
              },
            );
          } else {
            console.debug("[gh-utils] background: checkFollowing", {
              viewer,
              target,
              res,
            });
          }
          sendResponse(res);
        } catch (e) {
          console.warn("[gh-utils] background: checkFollowing error", e, {
            viewer,
            target,
          });
          sendResponse(null);
        }
        return;
      }

      if (msg && msg.type === "getLists") {
        const { viewer } = msg;
        if (!viewer) {
          sendResponse({ followers: [] });
          return;
        }
        try {
          const lists = await getListsForUser(viewer);
          console.debug("[gh-utils] background: getLists", {
            viewer,
            counts: {
              followers: lists.followers.length,
            },
          });
          sendResponse(lists);
        } catch (e) {
          console.warn("[gh-utils] background: getLists failed", e, { viewer });
          sendResponse({ followers: [] });
        }
        return;
      }
    } catch (e) {
      console.warn("[gh-utils] background: onMessage handler error", e);
      // ensure we always respond to avoid leaving the sender waiting
      try {
        if (msg && msg.type === "checkFollow") sendResponse(null);
        else if (msg && msg.type === "getLists")
          sendResponse({ followers: [] });
      } catch (e2) {}
    }
  })();

  return true;
});
