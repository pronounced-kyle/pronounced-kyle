import { errorResponse, json } from "./_lib/http.js";
import { getPublicBooks, readAppState } from "./_lib/store.js";

export async function GET() {
  try {
    return json(getPublicBooks(await readAppState()));
  } catch (error) {
    return errorResponse(error);
  }
}
