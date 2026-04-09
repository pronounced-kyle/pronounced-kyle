import { logoutResponse } from "./_lib/auth.js";

export async function POST(request) {
  return logoutResponse(request);
}
