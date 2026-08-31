# Sharing and WebDAV

Sharing is independent from the physical `DATA` path. Files and folders keep stable
UUIDs in PostgreSQL; public URLs and permission records refer to those UUIDs, never
to a username, folder name, or disk path. A physical rename therefore does not break
an existing share.

## Share Types

- **Private**: owner only.
- **Unlisted public link**: no account is needed; possession of the opaque signed
  link is required.
- **Optional password**: a link can additionally require an owner-defined password.
- **Folder access**: folder links are either `보기` or `보기 및 수정`.

File links are always read-only. A `보기 및 수정` folder link permits upload to the
currently opened shared folder and deletion of selected items in the shared subtree.
It intentionally does not permit rename, move, folder creation, text editing, share
setting changes, or any action outside the shared root.

Folder membership is dynamic: newly uploaded or moved-in descendants become
available, while items moved outside the shared tree become unavailable on the next
request.

## Security Rules

1. Nginx must never expose or alias the host `DATA` directory.
2. Every public listing, detail view, original download, preview range, text read,
   archive request, upload, and deletion rechecks the signed-link version, owner
   status, expiry, hidden/revoked/paused state, password authorization, and share
   subtree membership in the backend.
3. Passwords are bcrypt hashes. They are never stored in a URL, browser storage, or
   API response. Successful verification creates a share-specific, `HttpOnly`,
   `SameSite=Lax` cookie scoped to that share API path for up to 12 hours.
4. Changing a share password, stopping a share, or resuming a share increments the
   password-session version. A password-protected link must therefore be unlocked
   again after any of those actions.
5. Original relative paths, account identifiers, storage names, and extracted EXIF
   metadata are omitted from anonymous responses. Original downloads naturally still
   contain metadata embedded in the original bytes.
6. Folder membership and authorization are evaluated under a per-owner PostgreSQL
   advisory lock. Moving an item outside the shared tree removes access on the next
   request.
7. Shared file delivery opens and validates a regular, non-symlinked descriptor
   under the owner storage root. Public archives validate every source path, size,
   and containment before response headers are written.
8. Existing streams whose file descriptors were already opened may finish after a
   share is stopped. New requests are blocked immediately.
9. The WebDAV endpoint is `/webdav/`; the deprecated `/dav/` endpoint is not served.

## Lifecycle

- **공유 중지** sets `paused_at` and blocks new public requests without creating a
  second share record or changing the URL.
- **공유 재개** clears `paused_at` for the same available, unexpired target and URL.
- **링크 변경** increments `token_version`, invalidating previous URLs.
- **내역 삭제** sets `hidden_at` and revokes the URL while retaining audit data.
- The legacy `재공유` endpoint and UI are removed. A stopped link is resumed instead
  of creating a replacement link.
- Target type and name are snapshotted. If the original is deleted, the share remains
  in owner history as unavailable.

## Public Recipient Features

- Folder navigation, Ctrl/Cmd click, Shift click, Ctrl/Cmd+Shift range selection,
  checkbox selection, and blank-space drag selection.
- Original download for one file, selected-item ZIP download, and complete shared
  target ZIP download.
- Read-only safe details for files and folders.
- Read-only image, video, audio, PDF, text, and subtitle preview. Public text preview
  wraps long lines automatically. Text source is limited to 2 MiB and supports the
  listed legacy encodings; it cannot be edited publicly.
- Context menus include preview, details, original download, selected ZIP, and full
  ZIP only. Public menus never expose move, rename, copy, or private deletion actions.
- Writable folder shares add upload and selection-toolbar deletion actions.

## Public ZIP Limits

Public ZIP downloads stream from the server and are constrained to reduce anonymous
resource abuse:

- 100 submitted selections
- 5,000 expanded archive entries
- 10 GiB total source bytes
- 2 concurrent public archive streams per backend process
- 4 KiB maximum archive entry path

ZIP paths are rebased to the shared root, sanitized, collision-resolved, and preserve
empty folders. The current browser client receives the streamed ZIP as a Blob before
opening its download, so very large archives may require substantial recipient memory.
Server-side archive streaming remains bounded, but deployments that expose links to
untrusted public audiences should additionally enforce reverse-proxy rate and
bandwidth limits.

## Data Model

- `shares`: owner, nullable target UUID, target type/name, expiry, permanent
  revocation, hidden history, `paused_at`, token version, optional password hash and
  version, and `read`/`readwrite` access.
- `share_events`: append-only successful view/download and failed password attempt
  audit records with IP, user agent, optional target file, byte count, and timestamp.
- `webdav_tokens`: hashed token secret, account/folder scope, access mode, expiry,
  revocation, and last-use timestamp.

Public uploads and deletions are logged structurally by the backend. They do not add
new `share_events` action kinds, so existing owner metrics continue to represent
views and downloads only.
