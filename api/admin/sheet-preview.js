import { requireUser } from "../_lib/auth.js";
import { errorResponse, json } from "../_lib/http.js";
import { getSheetPreviewBooks } from "../_lib/store.js";

export async function GET(request) {
  try {
    requireUser(request);
    return json(await getSheetPreviewBooks());
  } catch (error) {
    return errorResponse(error);
  }
}
