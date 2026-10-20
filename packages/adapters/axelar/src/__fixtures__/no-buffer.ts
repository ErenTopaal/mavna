/**
 * Take Node's Buffer global away from this package's own code, as a browser does.
 *
 * Deleting the global outright is not a faithful browser: under Node, dependencies
 * resolve to their Node entries, and some of those (base32.js under the Stellar
 * SDK) read the global where their browser entry does not. So the global stays
 * for code outside src/, and any read from a file under `root` throws the same
 * ReferenceError a browser would.
 */
export function hideBufferFrom(root: string): () => void {
  const nodeBuffer = globalThis.Buffer;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
  const ours = root.replace(/\/$/, "");
  Object.defineProperty(globalThis, "Buffer", {
    configurable: true,
    get() {
      const caller = new Error().stack?.split("\n")[2] ?? "";
      if (caller.includes(`${ours}/`) && !/\.test\.ts|__fixtures__/.test(caller)) {
        throw new ReferenceError(`Buffer is not defined (read from ${caller.trim()})`);
      }
      return nodeBuffer;
    },
  });
  return () => {
    if (descriptor !== undefined) Object.defineProperty(globalThis, "Buffer", descriptor);
  };
}
