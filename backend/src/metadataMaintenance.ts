import type { QueryResult } from 'pg';
import { db } from './db.js';
import { isHiddenResource, ORIGINAL_CREATION_METADATA_KEYS, originalCreatedAtFromMetadata } from './storage.js';

type MetadataBackfillFile = { id: string; storedName: string; metadata: Record<string, unknown> };

export async function backfillOriginalCreationTimes(): Promise<void> {
  let cursor: string | null = null;
  while (true) {
    const rows: QueryResult<MetadataBackfillFile> = await db.query(`
      SELECT id,stored_name AS "storedName",extracted_metadata AS metadata FROM files
      WHERE ($1::uuid IS NULL OR id > $1::uuid) AND ((original_created_at IS NULL
        AND (extracted_metadata ?| $2::text[] OR extracted_metadata::text ~ '"Track[0-9]+:(Media|Track)CreateDate"'))
        OR (NOT is_hidden AND (
          stored_name LIKE '.%'
          OR extracted_metadata::text ILIKE '%hidden%'
          OR extracted_metadata::text ILIKE '%fileattributes%'
          OR extracted_metadata::text ILIKE '%dosattrib%'
        )))
      ORDER BY id LIMIT 1000
    `, [cursor, ORIGINAL_CREATION_METADATA_KEYS]);
    if (!rows.rows.length) break;
    for (const file of rows.rows) {
      const originalCreatedAt = originalCreatedAtFromMetadata(file.metadata);
      const isHidden = isHiddenResource(file.storedName, file.metadata);
      if (originalCreatedAt || isHidden)
        await db.query(`UPDATE files
          SET original_created_at=COALESCE(original_created_at,$1),is_hidden=is_hidden OR $2
          WHERE id=$3`, [originalCreatedAt ?? null, isHidden, file.id]);
    }
    cursor = rows.rows.at(-1)!.id;
  }
  await db.query("UPDATE folders SET is_hidden=true WHERE NOT is_hidden AND name LIKE '.%'");
}
