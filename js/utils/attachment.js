// ==========================================================================
// Finora — utils/attachment.js
// Attachments are stored inline on the ledger record as a data URL — no
// separate blob store needed. Capped at 1.5MB so a single receipt photo
// doesn't bloat IndexedDB or a backup file unreasonably.
// ==========================================================================

const MAX_BYTES = 1.5 * 1024 * 1024;

/**
 * @param {File} file
 * @returns {Promise<{name: string, type: string, size: number, dataUrl: string}>}
 */
export function readFileAsAttachment(file) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_BYTES) {
      reject(new Error('Attachment must be under 1.5 MB.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve({
      name: file.name,
      type: file.type,
      size: file.size,
      dataUrl: reader.result,
    });
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}
