const CONFIG = {
  summaryCrons: ["30 0 * * *", "30 13 * * *"],
  defaultLoginPath: "/login/?next=/",
  defaultSuccessPath: "/",
  telegramMaxLength: 3900,
  githubApi: "https://api.github.com"
};

export default {
  async scheduled(event, env, ctx) {
    const summary = CONFIG.summaryCrons.includes(event.cron);
    ctx.waitUntil(runKeepalive(env, { summary, source: event.cron }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/git" || url.searchParams.get("git") === "1") {
      if (request.method !== "POST") {
        return jsonResponse({ ok: false, error: "Use POST to publish to GitHub" }, 405);
      }

      try {
        const result = await publishToGitHub(request, env, url);
        if (env.NOTIFY_GIT_SUCCESS !== "false") {
          await sendTG(env, [
            "[Git publish success]",
            `Repo: ${result.owner}/${result.repo}`,
            `Path: ${result.path}`,
            `Branch: ${result.branch}`,
            `Commit: ${result.commit?.html_url || result.content?.html_url || "created"}`
          ].join("\n"));
        }
        return jsonResponse(result);
      } catch (error) {
        await sendTG(env, `[Git publish failed]\n${error.message}`);
        return jsonResponse({ ok: false, error: error.message }, 500);
      }
    }

    if (url.searchParams.get("run") === "1") {
      const summary = url.searchParams.get("summary") === "1";
      await runKeepalive(env, { summary, source: "manual" });
      return new Response(summary ? "keepalive summary ok" : "keepalive run ok");
    }

    return new Response("ok");
  }
};

async function publishToGitHub(request, env, url) {
  assertPublishAuth(request, env, url);

  const payload = await readPublishPayload(request);
  const owner = payload.owner || env.GITHUB_OWNER;
  const repo = payload.repo || env.GITHUB_REPO;
  const path = cleanGitPath(payload.path || env.GITHUB_PATH || "index.html");
  const branch = payload.branch || env.GITHUB_BRANCH || "main";
  const message = payload.message || env.GITHUB_COMMIT_MESSAGE || `Publish ${path}`;
  const token = env.GITHUB_TOKEN;

  if (!token) throw new Error("Missing GITHUB_TOKEN");
  if (!owner) throw new Error("Missing GitHub owner. Set GITHUB_OWNER or send owner.");
  if (!repo) throw new Error("Missing GitHub repo. Set GITHUB_REPO or send repo.");
  if (!path) throw new Error("Missing target file path");

  const content = payload.content ?? payload.body ?? "";
  if (!content && payload.allowEmpty !== true) {
    throw new Error("Missing content. Send JSON { content } or a raw request body.");
  }

  const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeGitPath(path)}`;
  const existing = await githubFetch(`${apiPath}?ref=${encodeURIComponent(branch)}`, token, { method: "GET" }, true);
  const body = {
    message,
    content: payload.base64 ? content : base64Encode(content),
    branch
  };

  if (existing.ok && existing.data?.sha) body.sha = existing.data.sha;
  if (payload.committer || env.GITHUB_COMMITTER_NAME || env.GITHUB_COMMITTER_EMAIL) {
    body.committer = {
      name: payload.committer?.name || env.GITHUB_COMMITTER_NAME || "Cloudflare Worker",
      email: payload.committer?.email || env.GITHUB_COMMITTER_EMAIL || "worker@example.com"
    };
  }

  const saved = await githubFetch(apiPath, token, {
    method: "PUT",
    body: JSON.stringify(body)
  });

  return {
    ok: true,
    owner,
    repo,
    path,
    branch,
    action: existing.ok ? "updated" : "created",
    content: saved.content,
    commit: saved.commit
  };
}

function assertPublishAuth(request, env, url) {
  if (!env.PUBLISH_TOKEN) return;

  const auth = request.headers.get("authorization") || "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = bearer || url.searchParams.get("token") || request.headers.get("x-publish-token");

  if (supplied !== env.PUBLISH_TOKEN) {
    throw new Error("Unauthorized publish request");
  }
}

async function readPublishPayload(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return await request.json();

  const text = await request.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { content: text };
  }
}

async function githubFetch(path, token, init = {}, allow404 = false) {
  const response = await fetch(`${CONFIG.githubApi}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "ct8-worker-git-publisher",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {})
    }
  });

  const data = await safeJson(response);
  if (allow404 && response.status === 404) return { ok: false, status: 404, data };
  if (!response.ok) {
    const detail = data?.message ? `: ${data.message}` : "";
    throw new Error(`GitHub API ${response.status}${detail}`);
  }
  return data;
}

async function safeJson(response) {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

function cleanGitPath(path) {
  return String(path || "").trim().replace(/^\/+/, "");
}

function encodeGitPath(path) {
  return cleanGitPath(path).split("/").map(encodeURIComponent).join("/");
}

function base64Encode(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

async function runKeepalive(env, options = {}) {
  const accounts = parseAccounts(env.KEEPALIVE_ACCOUNTS_JSON);
  if (!accounts.length) {
    await sendTG(env, "[CT8/Serv00 keepalive]\nNo accounts found. Check KEEPALIVE_ACCOUNTS_JSON.");
    return;
  }

  const results = [];
  for (const account of accounts) {
    const result = await keepAccountAlive(account, env);
    results.push(result);
    await notifyStateChange(env, result, options.summary);
  }

  if (options.summary) {
    await sendSummary(env, results, options.source);
  }
}

async function keepAccountAlive(account, env) {
  const started = Date.now();
  const name = account.name || account.username || "unknown";
  const type = account.type || inferType(account.panel);
  const panel = normalizePanel(account.panel);

  if (!account.username || !account.password || !panel) {
    return failResult({ name, type, panel, started, error: "Missing username/password/panel" });
  }

  const jar = new CookieJar();

  try {
    const loginUrl = new URL(account.loginPath || CONFIG.defaultLoginPath, panel).toString();
    const loginPage = await fetchWithCookies(loginUrl, { method: "GET" }, jar);
    const loginHtml = await loginPage.text();

    if (!loginPage.ok) {
      return failResult({ name, type, panel, started, status: loginPage.status, error: "Login page cannot be opened" });
    }

    const csrf = extractCsrf(loginHtml, jar);
    if (!csrf) {
      return failResult({ name, type, panel, started, status: loginPage.status, error: "CSRF token not found" });
    }

    const loginAction = extractFormAction(loginHtml) || "/login/";
    const postUrl = new URL(loginAction, panel).toString();
    const form = new URLSearchParams();
    form.set("csrfmiddlewaretoken", csrf);
    form.set("username", account.username);
    form.set("password", account.password);
    form.set("next", account.next || "/");

    const loginRes = await fetchWithCookies(postUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": loginUrl,
        "Origin": new URL(panel).origin
      },
      body: form.toString()
    }, jar);

    const loginText = await safeText(loginRes);
    const location = loginRes.headers.get("location") || "";
    const redirectedAwayFromLogin = loginRes.status >= 300 && loginRes.status < 400 && !location.includes("/login");
    const hasSession = jar.hasLikelySession();
    const looksFailed = /invalid|incorrect|nieprawid|blad|errorlist|alert-danger|haslo|password/i.test(loginText)
      && /login/i.test(loginText);

    const successUrl = new URL(account.successPath || CONFIG.defaultSuccessPath, panel).toString();
    const homeRes = await fetchWithCookies(successUrl, {
      method: "GET",
      redirect: "manual",
      headers: { "Referer": loginUrl }
    }, jar);
    const homeLocation = homeRes.headers.get("location") || "";
    const stillOnLogin = homeLocation.includes("/login") || homeRes.url.includes("/login");
    const ok = (redirectedAwayFromLogin || hasSession) && !looksFailed && !stillOnLogin;

    if (!ok) {
      return failResult({
        name,
        type,
        panel,
        started,
        status: loginRes.status,
        error: `Login was not confirmed${stillOnLogin ? ", homepage still redirects to login" : ""}`
      });
    }

    return {
      ok: true,
      name,
      type,
      username: maskUser(account.username),
      panel,
      ssh: account.ssh || "",
      status: loginRes.status,
      ms: Date.now() - started,
      message: "Login keepalive succeeded"
    };
  } catch (error) {
    return failResult({ name, type, panel, started, error: error.message });
  }
}

async function notifyStateChange(env, result, summary) {
  const key = `keepalive:${result.name}:${result.panel}`;
  const previous = await stateGet(env, key, "unknown");
  const current = result.ok ? "ok" : "down";

  await statePut(env, key, current);

  if (summary) return;

  if (!result.ok && previous !== "down") {
    await sendTG(env, [
      "[CT8/Serv00 keepalive failed]",
      `Account: ${result.name}`,
      `Type: ${result.type}`,
      `Panel: ${result.panel}`,
      `Error: ${result.error || result.message || "unknown error"}`,
      `Time: ${result.ms}ms`
    ].join("\n"));
  }

  if (result.ok && shouldNotifySuccess(env)) {
    await sendTG(env, [
      "[CT8/Serv00 keepalive success]",
      `Account: ${result.name}`,
      `Type: ${result.type}`,
      `Panel: ${result.panel}`,
      "Status: Login keepalive succeeded",
      `Time: ${result.ms}ms`
    ].join("\n"));
    return;
  }

  if (result.ok && previous === "down") {
    await sendTG(env, [
      "[CT8/Serv00 keepalive recovered]",
      `Account: ${result.name}`,
      `Type: ${result.type}`,
      `Panel: ${result.panel}`,
      "Status: Login keepalive succeeded",
      `Time: ${result.ms}ms`
    ].join("\n"));
  }
}

async function sendSummary(env, results, source) {
  const okCount = results.filter(r => r.ok).length;
  const failCount = results.length - okCount;
  const lines = [
    "[CT8/Serv00 keepalive summary]",
    `Time: ${beijingTime()}`,
    `Source: ${source || "scheduled"}`,
    `Total: ${results.length}`,
    `Success: ${okCount}`,
    `Failed: ${failCount}`,
    "",
    ...results.map(r => [
      `${r.ok ? "Success" : "Failed"} ${r.name}`,
      `Type: ${r.type}`,
      `Account: ${r.username || "-"}`,
      `Panel: ${r.panel}`,
      r.ssh ? `SSH: ${r.ssh}` : "",
      `Time: ${r.ms}ms`,
      r.ok ? "Status: Login keepalive succeeded" : `Error: ${r.error || "unknown error"}`
    ].filter(Boolean).join("\n"))
  ];

  await sendTG(env, lines.join("\n\n"));
}

function parseAccounts(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((account, index) => ({
      ...account,
      name: account.name || `${account.type || inferType(account.panel)}-${index + 1}`
    }));
  } catch {
    return [];
  }
}

function normalizePanel(panel) {
  if (!panel) return "";
  const text = String(panel).trim();
  if (!text) return "";
  return /^https?:\/\//i.test(text) ? text.replace(/\/+$/, "/") : `https://${text.replace(/\/+$/, "")}/`;
}

function inferType(panel) {
  const text = String(panel || "").toLowerCase();
  if (text.includes("ct8")) return "ct8";
  if (text.includes("serv00")) return "serv00";
  return "panel";
}

function shouldNotifySuccess(env) {
  return String(env.NOTIFY_KEEPALIVE_SUCCESS || "true").toLowerCase() === "true";
}

function extractCsrf(html, jar) {
  const input = html.match(/name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)["']/i)
    || html.match(/value=["']([^"']+)["'][^>]*name=["']csrfmiddlewaretoken["']/i);
  if (input?.[1]) return decodeHtml(input[1]);

  const cookie = jar.get("csrftoken");
  return cookie || "";
}

function extractFormAction(html) {
  const form = html.match(/<form[^>]+data-login-form[^>]*>/i)?.[0]
    || html.match(/<form[^>]+action=["'][^"']*\/login\/[^"']*["'][^>]*>/i)?.[0]
    || "";
  const action = form.match(/action=["']([^"']+)["']/i)?.[1];
  return action ? decodeHtml(action) : "";
}

async function fetchWithCookies(url, init, jar) {
  const headers = new Headers(init.headers || {});
  headers.set("User-Agent", "Mozilla/5.0 CloudflareWorker CT8 Serv00 Keepalive");
  headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  headers.set("Accept-Language", "en-US,en;q=0.8,pl;q=0.7");

  const cookie = jar.header();
  if (cookie) headers.set("Cookie", cookie);

  const res = await fetch(url, { ...init, headers });
  jar.store(res.headers);
  return res;
}

async function safeText(res) {
  try {
    return await res.clone().text();
  } catch {
    return "";
  }
}

function failResult({ name, type, panel, started, status, error }) {
  return {
    ok: false,
    name,
    type,
    username: "",
    panel,
    ssh: "",
    status: status || 0,
    ms: Date.now() - started,
    error
  };
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(headers) {
    const values = getSetCookie(headers);
    for (const value of values) {
      const first = value.split(";")[0];
      const index = first.indexOf("=");
      if (index <= 0) continue;
      const name = first.slice(0, index).trim();
      const val = first.slice(index + 1).trim();
      if (name) this.cookies.set(name, val);
    }
  }

  get(name) {
    return this.cookies.get(name) || "";
  }

  header() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  hasLikelySession() {
    return [...this.cookies.keys()].some(name => /session|sessionid|sid/i.test(name));
  }
}

function getSetCookie(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  if (!single) return [];
  return splitSetCookie(single);
}

function splitSetCookie(value) {
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g).map(x => x.trim()).filter(Boolean);
}

async function sendTG(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: text.slice(0, CONFIG.telegramMaxLength)
    })
  });
}

async function stateGet(env, key, fallback) {
  if (!env.STATE_KV) return fallback;
  return await env.STATE_KV.get(key) || fallback;
}

async function statePut(env, key, value, ttl) {
  if (!env.STATE_KV) return;
  if (ttl) await env.STATE_KV.put(key, value, { expirationTtl: ttl });
  else await env.STATE_KV.put(key, value);
}

function maskUser(username) {
  const text = String(username || "");
  if (text.length <= 3) return text ? "***" : "";
  return `${text.slice(0, 2)}***${text.slice(-1)}`;
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function beijingTime() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
}
