import crypto from "node:crypto";

import { createHttpError, json } from "./http.js";

const SESSION_COOKIE = "pkyle_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

function sessionSecret() {
  return (
    process.env.PKYLE_SESSION_SECRET ||
    `${process.env.PKYLE_ADMIN_USERNAME || "admin"}:${process.env.PKYLE_ADMIN_PASSWORD || "changeme"}`
  );
}

function parseCookies(header = "") {
  return Object.fromEntries(
    String(header)
      .split(/;\s*/)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const index = chunk.indexOf("=");
        if (index === -1) {
          return [chunk, ""];
        }
        return [chunk.slice(0, index), decodeURIComponent(chunk.slice(index + 1))];
      })
  );
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodePayload(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function serializeCookie(name, value, request, overrides = {}) {
  const url = new URL(request.url);
  const parts = [`${name}=${encodeURIComponent(value)}`];
  const options = {
    httpOnly: true,
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
    sameSite: "Lax",
    secure: url.protocol === "https:" || Boolean(process.env.VERCEL),
    ...overrides
  };

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.path) {
    parts.push(`Path=${options.path}`);
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function createSessionValue(username) {
  const payload = {
    username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  };
  const encoded = encodePayload(payload);
  return `${encoded}.${sign(encoded)}`;
}

function verifySessionValue(value) {
  const [encoded, signature] = String(value || "").split(".", 2);
  if (!encoded || !signature) {
    return null;
  }

  const expected = sign(encoded);
  if (signature.length !== expected.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }

  let payload;
  try {
    payload = decodePayload(encoded);
  } catch {
    return null;
  }

  if (!payload || !payload.username || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  return { username: String(payload.username) };
}

export function getCurrentUser(request) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const session = verifySessionValue(cookies[SESSION_COOKIE]);
  return session ? { username: session.username } : null;
}

export function requireUser(request) {
  const user = getCurrentUser(request);
  if (!user) {
    throw createHttpError(401, "Unauthorized");
  }
  return user;
}

export function credentialsAreValid(username, password) {
  return (
    String(username || "").trim() === (process.env.PKYLE_ADMIN_USERNAME || "admin") &&
    String(password || "") === (process.env.PKYLE_ADMIN_PASSWORD || "changeme")
  );
}

export function loginResponse(username, request) {
  const headers = new Headers();
  headers.set("Set-Cookie", serializeCookie(SESSION_COOKIE, createSessionValue(username), request));
  return json({ ok: true, username }, { headers });
}

export function logoutResponse(request) {
  const headers = new Headers();
  headers.set(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE, "", request, {
      maxAge: 0
    })
  );
  return json({ ok: true }, { headers });
}
