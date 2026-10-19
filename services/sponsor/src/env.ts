/**
 * One environment variable, with an empty value read as unset.
 *
 * docker compose forwards `${NAME:-}` as an empty string when the operator sets
 * nothing, and `??` does not treat that as missing, so every default in main.ts
 * would be replaced by an empty value: an RPC URL of "", no allowed origins,
 * port 0.
 */
export function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}
