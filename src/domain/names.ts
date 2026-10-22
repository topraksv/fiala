/**
 * A shape check on an address: enough to catch a slip, and the server
 * decides the rest. The same pattern `send-feedback` holds a signed-out reply
 * address to, so nothing passes here that spends a send and is refused there.
 */
export function isEmail(email: string): boolean {
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email.trim());
}
