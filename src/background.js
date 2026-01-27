async function getToken() {
  return new Promise((resolve) =>
    chrome.storage.sync.get(["github_utils_token"], (r) =>
      resolve(r.github_utils_token || null),
    ),
  );
}

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
  return { viewerFollowsTarget, targetFollowsViewer };
}

async function getListsForUser(username) {
  const key = (username || "").toLowerCase();
  const token = await getToken();
  try {
    if (token) {
      const authLogin = await getAuthenticatedUser(token);
      if (authLogin && authLogin.toLowerCase() === key) {
        const [followers, following] = await Promise.all([
          getAuthFollowers(token),
          getAuthFollowing(token),
        ]);
        return {
          followers: Array.from(followers),
          following: Array.from(following),
          fetchedAt: Date.now(),
        };
      }
    }
    const followers = await getFollowersList(username, token);
    return { followers: Array.from(followers), fetchedAt: Date.now() };
  } catch (e) {
    console.warn("[gh-utils] bg getListsForUser failed", e, { username });
    return { followers: [], fetchedAt: Date.now(), error: true };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.type !== "checkFollow" && msg.type !== "getLists")) return;

  if (msg && msg.type === "checkFollow") {
    const { viewer, target } = msg;
    if (!viewer || !target) {
      sendResponse(null);
      return true;
    }
    (async () => {
      try {
        console.debug("[gh-utils] background: checkFollow (direct)", {
          viewer,
          target,
        });
        const res = await checkFollowing(viewer, target);
        if (!res) {
          console.warn("[gh-utils] background: checkFollowing returned null", {
            viewer,
            target,
          });
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
    })();
    return true;
  }

  if (msg && msg.type === "getLists") {
    const { viewer } = msg;
    if (!viewer) {
      sendResponse({ followers: [] });
      return true;
    }
    (async () => {
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
    })();
    return true;
  }

  return true;
});
