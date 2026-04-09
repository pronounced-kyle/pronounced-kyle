import { errorResponse, json } from "./_lib/http.js";
import { getPublicSiteData, readAppState } from "./_lib/store.js";

export async function GET() {
  try {
    return json(getPublicSiteData(await readAppState()));
  } catch (error) {
    return errorResponse(error);
  }
}
