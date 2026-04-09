import { requireUser } from "../../_lib/auth.js";
import { errorResponse, json, readJson } from "../../_lib/http.js";
import { deleteBook, updateBook } from "../../_lib/store.js";

function routeId(request) {
  return decodeURIComponent(new URL(request.url).pathname.split("/").pop() || "");
}

export async function PUT(request) {
  try {
    requireUser(request);
    return json(await updateBook(routeId(request), await readJson(request)));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request) {
  try {
    requireUser(request);
    return json(await deleteBook(routeId(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
