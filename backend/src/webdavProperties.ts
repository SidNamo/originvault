import { SaxesParser } from 'saxes';

export const DAV_NAMESPACE = 'DAV:';
const MICROSOFT_NAMESPACE = 'urn:schemas-microsoft-com:';

export type WebdavDateProperty = {
  namespace: string;
  name: string;
  kind?: 'created' | 'modified';
  value: Date | null;
  status: 200 | 403 | 409 | 424;
};

export function parseWebdavMtime(value: string | undefined): Date | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  let milliseconds: number;
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric)) return null;
    milliseconds = Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric;
  } else milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8_640_000_000_000_000) return null;
  const parsed = new Date(milliseconds);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function parseWebdavDateProperties(body: string): WebdavDateProperty[] {
  if (Buffer.byteLength(body) > 64 * 1024) throw new Error('WebDAV property update is too large');
  const parser = new SaxesParser({ xmlns: true });
  const stack: Array<{ namespace: string; name: string }> = [];
  const properties: WebdavDateProperty[] = [];
  let text = '';
  let sawRoot = false;
  parser.on('doctype', () => { throw new Error('Document types are not supported'); });
  parser.on('opentag', (tag) => {
    const depth = stack.length;
    const structural = tag.uri === DAV_NAMESPACE && (
      (depth === 0 && tag.local === 'propertyupdate' && !sawRoot)
      || (depth === 1 && (tag.local === 'set' || tag.local === 'remove'))
      || (depth === 2 && tag.local === 'prop')
    );
    if (depth !== 3 && !structural) throw new Error('Invalid WebDAV property update structure');
    if (depth === 0) sawRoot = true;
    stack.push({ namespace: tag.uri, name: tag.local });
    if (depth === 3) text = '';
  });
  const collectText = (value: string) => {
    if (stack.length === 4) text += value;
    else if (value.trim()) throw new Error('Unexpected text in WebDAV property update');
  };
  parser.on('text', collectText);
  parser.on('cdata', collectText);
  parser.on('closetag', () => {
    if (stack.length === 4) {
      const property = stack.at(-1)!;
      const kind = property.namespace === DAV_NAMESPACE
        ? property.name === 'getlastmodified' ? 'modified' : property.name === 'creationdate' ? 'created' : undefined
        : property.namespace === MICROSOFT_NAMESPACE
          ? property.name === 'Win32LastModifiedTime' ? 'modified' : property.name === 'Win32CreationTime' ? 'created' : undefined
          : undefined;
      const value = kind ? parseWebdavMtime(text) : null;
      properties.push({ ...property, kind, value, status: !kind || stack[1]!.name === 'remove' ? 403 : value ? 200 : 409 });
      if (properties.length > 32) throw new Error('Too many WebDAV date properties');
    }
    stack.pop();
  });
  parser.write(body).close();
  if (!sawRoot || !properties.length) throw new Error('At least one WebDAV date property is required');
  for (const kind of ['created', 'modified'] as const) {
    const matching = properties.filter((property) => property.kind === kind && property.status === 200);
    if (new Set(matching.map((property) => property.value!.getTime())).size > 1)
      for (const property of matching) property.status = 409;
  }
  // PROPPATCH is atomic: never report success for a subset of a rejected update.
  if (properties.some((property) => property.status !== 200))
    for (const property of properties) if (property.status === 200) property.status = 424;
  return properties;
}
