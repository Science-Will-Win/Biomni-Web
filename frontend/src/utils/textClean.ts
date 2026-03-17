/** Recover broken UTF-8 checkmarks: consecutive replacement chars → ✓ */
export function recoverBrokenChars(s: string): string {
  return s
    .replace(/\ufffd{2,}/g, '✓')
    .replace(/[●◆◇○■□]{2,}/g, '✓');
}
