# OriginVault architecture

## Upload-byte preservation

The uploaded byte stream is written directly to `DATA/files/{storage-key}/{folder}/...`.
No image decoder, compressor, transcoder, EXIF writer, or thumbnail tool appears in
the write path. A SHA-256 digest is calculated while streaming and returned in the
`X-Content-SHA256` response header on download.

ExifTool runs only after the atomic rename and only with read flags. Its JSON output
is an index in PostgreSQL; the file remains the source of truth. Filesystem mtime is
restored when the client exposes it. Embedded EXIF/XMP/IPTC, video atoms, document
metadata, and unknown binary fields survive because the upload path does not transform
the bytes. Volatile host fields such as the server path, access time, and inode change
time are omitted from the metadata index because ordinary reads and moves invalidate
them; canonical file details are read from OriginVault's file record instead.

Two operations intentionally replace those bytes: saving in the text editor and a
write-capable WebDAV `PUT`. Both operations write a new staged file, verify its hash
and quota, and publish a durable mutation journal. Replacements preserve a hard-linked
backup before replacing the path atomically and updating PostgreSQL. The stored SHA-256, size, encoding,
and extracted metadata identify the currently saved version rather than the first
uploaded version.

```text
device bytes -> HTTP multipart -> temporary file + SHA-256 -> atomic rename -> original file
                                                       |
                                                       +-> read-only ExifTool -> PostgreSQL index
```

## Storage

```text
DATA/
  files/
    .upload-sessions/
    .originvault-preview-staging/
    .dav-staging/
    alice/
      Camera Uploads/
        IMG_0001.HEIC
      documents/
        contract.pdf
  logs/
    originvault-2026-08-03.log
  postgresql/
    # PostgreSQL physical cluster data
```

Usernames are restricted to safe lowercase characters. Each account receives a stable
storage key, initially equal to its username, so an account rename does not move its
files. Every resolved path is checked against that storage root. Duplicate names
receive ` (1)`, ` (2)`, etc. instead of overwriting an original.

PostgreSQL is an index, not the original-file store. The `DATA` tree is bind-mounted
from the host and uses readable user/folder/file names rather than database IDs.
If PostgreSQL, the API, or Docker is unavailable, an administrator can copy the
complete originals directly from this tree. Folder uploads reproduce their browser-
provided relative directory hierarchy; folder renames update both the physical tree
and indexed descendant paths.

The physical layout is an operational detail and may evolve as long as it remains
human-recoverable. Product references use stable database UUIDs rather than physical
paths. This is especially important for sharing: renaming or reorganizing a
folder must not invalidate its share URL or access-control entries. See
[SHARING.md](SHARING.md).

## Replacement recovery

Text and WebDAV replacements use fsynced journals under the reserved staging
directories. The backup directory entry is synced before the visible target is
replaced. On startup, journals are processed newest-first and repeatedly until the
filesystem SHA-256 and PostgreSQL row converge. Startup fails closed when a journal,
backup, user storage-key collision, or third-party filesystem change cannot be
reconciled safely.

WebDAV `MOVE` also writes a durable path journal before renaming. If a process stops
between the filesystem rename and PostgreSQL commit, startup rolls the rename forward
or backward according to the indexed resource path before accepting requests.

A PostgreSQL advisory lock permits only one backend process for a database. This is a
deliberate recovery barrier: do not horizontally scale backend replicas against the
same database and `DATA` tree. Read paths open file descriptors while holding a shared
per-user advisory lock, so an atomic replacement cannot mix old index metadata with
new bytes.

## Observability

The backend emits the same structured JSON events to stdout and `DATA/logs`, a bind-mounted
daily file. Log filenames use the UTC date (`originvault-YYYY-MM-DD.log`), and a
calendar-day retention sweep runs at startup and rotation. `LOG_LEVEL` accepts
`trace`, `debug`, `info`, `warn`, `error`, or `fatal`; `LOG_RETENTION_DAYS` controls
retention. Request IDs correlate receipt, authentication, domain operations, and
completion without persisting passwords, bearer tokens, or raw extracted EXIF.

## Deliberately deferred

- Installable app builds and mobile background backup
- Trash, deduplication policy, selected-user sharing, encryption at rest
- Generated thumbnails and media transcoding
- XMP sidecar pairing and Live Photo pairing
