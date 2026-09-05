const ORIGIN = "https://yostar-serverinfo.bluearchiveyostar.com";
const CLIENTPATCH_ORIGIN = "https://prod-clientpatch.bluearchiveyostar.com";
const CLIENTPATCH_PROXY_ORIGIN = "https://prod-clientpatch.bluearchive.help";

const DEFAULT_USER = {
  text: "CN",
  voice: "Default",
  media: "JP",
  management: "https://prod-noticeindex.bluearchiveyostar.com/prod/index.json",
  api: "https://prod-game.bluearchiveyostar.com:5000/api/",
  gateway: "https://prod-gateway.bluearchiveyostar.com:5100/api/",
  use: 1
};

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie");

  if (!cookie) {
    return null;
  }

  const cookies = cookie.split(";");

  for (const item of cookies) {
    const index = item.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();

    if (key === name) {
      return decodeURIComponent(value);
    }
  }

  return null;
}

function generateUid() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);

  let uid = "";

  for (const byte of bytes) {
    uid += String(byte % 10);
  }

  return uid;
}

async function createUser(env, uid) {
  await env.resource_db
    .prepare(
      `INSERT INTO users (user, text, voice, media, management, api, gateway, use)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      uid,
      DEFAULT_USER.text,
      DEFAULT_USER.voice,
      DEFAULT_USER.media,
      DEFAULT_USER.management,
      DEFAULT_USER.api,
      DEFAULT_USER.gateway,
      DEFAULT_USER.use
    )
    .run();
}

async function getOrCreateUser(env, request) {
  let uid = getCookie(request, "uid");
  let newUser = false;

  if (!uid) {
    for (;;) {
      uid = generateUid();

      const exists = await env.resource_db
        .prepare("SELECT user FROM users WHERE user = ?")
        .bind(uid)
        .first();

      if (!exists) {
        break;
      }
    }

    await createUser(env, uid);
    newUser = true;
  }

  let user = await env.resource_db
    .prepare(
      `SELECT user, text, voice, media, management, api, gateway, use
       FROM users
       WHERE user = ?`
    )
    .bind(uid)
    .first();

  if (!user) {
    await createUser(env, uid);

    user = await env.resource_db
      .prepare(
        `SELECT user, text, voice, media, management, api, gateway, use
         FROM users
         WHERE user = ?`
      )
      .bind(uid)
      .first();

    newUser = true;
  }

  return {
    uid,
    user,
    newUser
  };
}

function rewriteClientPatchUrl(url, user) {
  if (typeof url !== "string") {
    return url;
  }

  if (!url.startsWith(CLIENTPATCH_ORIGIN)) {
    return url;
  }

  const rest = url.slice(CLIENTPATCH_ORIGIN.length);

  const prefix = `text=${user.text}/voice=${user.voice}/media=${user.media}`;

  return `${CLIENTPATCH_PROXY_ORIGIN}${rest}/${prefix}`;
}

function rewriteObject(value, user) {
  if (Array.isArray(value)) {
    return value.map(item => rewriteObject(item, user));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result = {};

  for (const [key, currentValue] of Object.entries(value)) {
    if (key === "ManagementDataUrl") {
      result[key] = user.management;
      continue;
    }

    if (key === "ApiUrl") {
      result[key] = user.api;
      continue;
    }

    if (key === "GatewayUrl") {
      result[key] = user.gateway;
      continue;
    }

    if (key === "AddressablesCatalogUrlRoot") {
      result[key] = rewriteClientPatchUrl(currentValue, user);
      continue;
    }

    result[key] = rewriteObject(currentValue, user);
  }

  return result;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        Allow: "GET, HEAD"
      }
    });
  }

  const { uid, user, newUser } = await getOrCreateUser(env, request);

  const originUrl = new URL(
    url.pathname + url.search,
    ORIGIN
  );

  const originResponse = await fetch(originUrl.toString(), {
    method: request.method,
    headers: request.headers,
    redirect: "follow"
  });

  const responseHeaders = new Headers(originResponse.headers);

  if (newUser) {
    responseHeaders.append(
      "Set-Cookie",
      `uid=${encodeURIComponent(uid)}; Path=/; Domain=bluearchive.help; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`
    );
  }

  if (request.method === "HEAD") {
    return new Response(null, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders
    });
  }

  if (!user || Number(user.use) !== 1) {
    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders
    });
  }

  const contentType = originResponse.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders
    });
  }

  let data;

  try {
    data = await originResponse.json();
  } catch {
    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders
    });
  }

  const rewritten = rewriteObject(data, user);

  responseHeaders.delete("Content-Length");
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(rewritten), {
    status: originResponse.status,
    statusText: originResponse.statusText,
    headers: responseHeaders
  });
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: "Internal Server Error"
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json; charset=utf-8"
          }
        }
      );
    }
  }
};
