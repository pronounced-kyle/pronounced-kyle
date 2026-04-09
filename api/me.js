import { getCurrentUser } from "./_lib/auth.js";
import { json } from "./_lib/http.js";

export async function GET(request) {
  const user = getCurrentUser(request);
  if (!user) {
    return json({ authenticated: false });
  }
  return json({ authenticated: true, username: user.username });
}
