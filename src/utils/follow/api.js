async function getToken() {
  return new Promise((resolve) =>
    chrome.storage.sync.get(["github_utils_token"], (r) =>
      resolve(r.github_utils_token || null),
    ),
  );
}

const _listCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

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
        console.debug("[gh-utils] fetchPaged", {
          url: next,
          status: res.status,
          remaining,
          limit,
          reset,
        });
      } catch (e) {}

      if (!res.ok) {
        try {
          const txt = await res.text();
          console.warn("[gh-utils] fetchPaged non-ok", {
            url: next,
            status: res.status,
            body: txt && txt.slice ? txt.slice(0, 300) : txt,
          });
        } catch (e) {
          console.warn("[gh-utils] fetchPaged non-ok and failed to read body", {
            url: next,
            status: res.status,
          });
        }

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
    console.warn("[gh-utils] fetchPaged error", e, { url });
  }
  console.debug("[gh-utils] fetchPaged completed", {
    url,
    count: results.length,
  });
  return results;
}

function itemsToSet(items) {
  const set = new Set();
  for (const i of items) if (i && i.login) set.add(i.login.toLowerCase());
  return set;
}

async function getFollowersList(username, token) {
  const url = `https://api.github.com/users/${encodeURIComponent(username)}/followers`;
  const items = await fetchPaged(url, token);
  const set = itemsToSet(items);
  console.debug("[gh-utils] getFollowersList", { username, count: set.size });
  return set;
}

const _authCache = { login: null, fetchedAt: 0 };
async function getAuthenticatedUser(token) {
  if (!token) return null;
  const now = Date.now();
  if (_authCache.login && now - _authCache.fetchedAt < CACHE_TTL)
    return _authCache.login;
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
      console.warn("[gh-utils] getAuthenticatedUser failed", {
        status: res.status,
      });
      return null;
    }
    const json = await res.json();
    _authCache.login = json && json.login ? json.login.toLowerCase() : null;
    _authCache.fetchedAt = Date.now();
    console.debug("[gh-utils] authenticated user", _authCache.login);
    return _authCache.login;
  } catch (e) {
    console.warn("[gh-utils] getAuthenticatedUser error", e);
    return null;
  }
}

async function getAuthFollowers(token) {
  const url = `https://api.github.com/user/followers`;
  const items = await fetchPaged(url, token);
  const set = itemsToSet(items);
  console.debug("[gh-utils] getAuthFollowers", { count: set.size });
  return set;
}

async function getAuthFollowing(token) {
  const url = `https://api.github.com/user/following`;
  const items = await fetchPaged(url, token);
  const set = itemsToSet(items);
  console.debug("[gh-utils] getAuthFollowing", { count: set.size });
  return set;
}

async function ensureListsForUser(username) {
  const key = username.toLowerCase();
  const now = Date.now();
  const token = await getToken();
  const cached = _listCache.get(key);
  if (cached && now - cached.fetchedAt < CACHE_TTL) {
    try {
      console.debug("[gh-utils] ensureListsForUser: cache hit", {
        username: key,
        fetchedAt: new Date(cached.fetchedAt).toISOString(),
        error: !!cached.error,
        followers: cached.followers
          ? cached.followers.size || cached.followers.length || 0
          : 0,
      });
    } catch (e) {}
    return cached;
  }

  if (token) {
    try {
      console.debug(
        "[gh-utils] ensureListsForUser: token present, attempting authenticated route",
        { username: key },
      );
      const authLogin = await getAuthenticatedUser(token);
      console.debug(
        "[gh-utils] ensureListsForUser: authenticated login",
        authLogin,
      );
      if (authLogin && authLogin.toLowerCase() === key) {
        try {
          console.debug(
            "[gh-utils] ensureListsForUser: using /user endpoints for followers/following",
            { username: key },
          );
          const [followers, following] = await Promise.all([
            getAuthFollowers(token),
            getAuthFollowing(token),
          ]);
          const obj = { followers, following, fetchedAt: Date.now() };
          _listCache.set(key, obj);
          console.debug("[gh-utils] ensureListsForUser: set cache (auth)", {
            username: key,
            followers: followers.size || followers.length,
            following: following.size || following.length,
          });
          return obj;
        } catch (e) {
          console.warn(
            "[gh-utils] authenticated lists fetch failed, falling back",
            key,
            e,
          );
        }
      }
    } catch (e) {
      console.warn("[gh-utils] getAuthenticatedUser error", e);
    }
  } else {
    console.debug(
      "[gh-utils] ensureListsForUser: no token present; using unauthenticated /users endpoints",
      { username: key },
    );
  }

  try {
    console.debug("[gh-utils] ensureListsForUser: fetching followers for", key);
    const followers = await getFollowersList(username, token);
    const obj = { followers, fetchedAt: Date.now() };
    _listCache.set(key, obj);
    console.debug("[gh-utils] ensureListsForUser: set cache (unauth)", {
      username: key,
      followers: followers.size || followers.length,
    });
    return obj;
  } catch (e) {
    console.warn("[gh-utils] ensureListsForUser failed for", username, e);

    const obj = {
      followers: new Set(),
      fetchedAt: Date.now(),
      error: true,
    };
    _listCache.set(key, obj);
    return obj;
  }
}

export async function getFollowStatus(viewer, target) {
  if (!viewer || !target) return null;

  try {
    const lists = await ensureListsForUser(viewer);
    const vt = (target || "").toLowerCase();

    const viewerFollowsTarget = null;
    const targetFollowsViewer = lists.followers.has(vt);
    return { viewerFollowsTarget, targetFollowsViewer };
  } catch (e) {
    return null;
  }
}

export async function checkFollowing(viewer, target) {
  if (!viewer || !target) return null;
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
    console.debug("[gh-utils] checkFollowing res", {
      viewer,
      target,
      status: res1.status,
    });
    viewerFollowsTarget = res1.status === 204;
  } catch (e) {
    console.warn(
      "[gh-utils] checkFollowing error (viewer->target)",
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
    console.debug("[gh-utils] checkFollowing res reverse", {
      viewer,
      target,
      status: res2.status,
    });
    targetFollowsViewer = res2.status === 204;
  } catch (e) {
    console.warn(
      "[gh-utils] checkFollowing error (target->viewer)",
      viewer,
      target,
      e,
    );
  }
  return { viewerFollowsTarget, targetFollowsViewer };
}

export async function getListsForUser(username) {
  if (!username) return { followers: [], fetchedAt: Date.now() };
  try {
    const lists = await ensureListsForUser(username);
    return {
      followers: Array.from(lists.followers),
      fetchedAt: lists.fetchedAt,
      error: !!lists.error,
    };
  } catch (e) {
    console.warn("[gh-utils] getListsForUser failed", username, e);
    return { followers: [], fetchedAt: Date.now(), error: true };
  }
}
