import { requireUser } from "../../_lib/auth.js";
import { errorResponse, json, readJson } from "../../_lib/http.js";
import { createTimelineEntry, getTimelineEntries, readAppState } from "../../_lib/store.js";

export async function GET(request) {
  try {
    requireUser(request);
    return json(getTimelineEntries(await readAppState()));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request) {
  try {
    requireUser(request);
    return json(await createTimelineEntry(await readJson(request)), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
