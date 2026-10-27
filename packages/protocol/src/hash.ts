const encoder = new TextEncoder();

/** Lowercase hex SHA-256 of the UTF-8 encoding of `text`, via Web Crypto. */
export async function sha256Hex(text: string): Promise<string> {
  // Global Web Crypto: present in Obsidian (desktop and mobile), Node 22, and Workers.
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  let hex = '';
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
