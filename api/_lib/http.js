export function json(payload, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  return Response.json(payload, { ...init, headers });
}

export function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function errorResponse(error) {
  if (error instanceof Response) {
    return error;
  }

  const status = error && Number.isFinite(error.status) ? error.status : 500;
  const message = error && error.message ? error.message : "Request failed";
  return json({ error: message }, { status });
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
