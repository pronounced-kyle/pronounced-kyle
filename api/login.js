import { credentialsAreValid, loginResponse } from "./_lib/auth.js";
import { createHttpError, errorResponse, readJson } from "./_lib/http.js";

export async function POST(request) {
  try {
    const payload = await readJson(request);
    const username = String(payload.username || "").trim();
    const password = String(payload.password || "");

    if (!credentialsAreValid(username, password)) {
      throw createHttpError(401, "Invalid credentials");
    }

    return loginResponse(username, request);
  } catch (error) {
    return errorResponse(error);
  }
}
