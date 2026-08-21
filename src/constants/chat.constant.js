/** Chat media / document limits (enforced server + client). */
module.exports = Object.freeze({
  MAX_FILES_PER_MESSAGE: 5,
  MAX_LINKS_PER_MESSAGE: 5,
  /** Images (png/jpeg/webp/gif) */
  IMAGE_MAX_BYTES: 10 * 1024 * 1024,
  /** Documents & other allowed files */
  DOCUMENT_MAX_BYTES: 15 * 1024 * 1024,
  /** Multer hard cap (must be >= DOCUMENT_MAX_BYTES) */
  UPLOAD_MAX_BYTES: 15 * 1024 * 1024,
  IMAGE_MIME_TYPES: Object.freeze([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  ]),
});
