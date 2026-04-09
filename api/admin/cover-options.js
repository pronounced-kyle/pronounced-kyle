import { requireUser } from "../_lib/auth.js";
import { errorResponse, json, readJson } from "../_lib/http.js";
import { buildCoverOptions } from "../_lib/store.js";

export async function POST(request) {
  try {
    requireUser(request);
    const payload = await readJson(request);
    const title = String(payload.title || "").trim();
    const author = String(payload.author || "").trim();
    const coverUrl = String(payload.coverUrl || "").trim();
    const coverOptions = title ? await buildCoverOptions(title, author, coverUrl, { includeRemote: true }) : uniqueStrings([coverUrl]);
    const selected = coverUrl && coverOptions.includes(coverUrl) ? coverUrl : coverOptions[0] || coverUrl;
    return json({
      coverOptions,
      coverUrl: selected
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}
