# Pronounced Kyle

Static personal site plus a live admin for books and timeline editing.

## Stack

- Static HTML/CSS/JS frontend
- Vercel Functions for auth and admin APIs
- Vercel Blob for persisted live content
- Local file fallbacks in `data/` for offline/dev use

## Required env vars

- `PKYLE_ADMIN_USERNAME`
- `PKYLE_ADMIN_PASSWORD`
- `PKYLE_SESSION_SECRET`
- `BLOB_READ_WRITE_TOKEN`

Optional:

- `PKYLE_STATE_BLOB_PATH`

## Deploy notes

1. Create a Vercel Blob store and add `BLOB_READ_WRITE_TOKEN` to the project.
2. Add the admin credentials/session secret env vars in Vercel.
3. Import the repo into Vercel.
4. The public site will read `/api/books` and `/api/site-data` when deployed.
5. The admin lives at `/admin/`.

Without `BLOB_READ_WRITE_TOKEN`, reads fall back to the checked-in seed files, but live admin writes are intentionally blocked on Vercel.
