/**
 * Which surface a call came in on.
 *
 * Kept separate from `types.ts` because this is the one place both the
 * gateway (writing the field) and the console (reading it) need to agree on
 * what an unrecognised or absent value means — everywhere else just imports
 * the function.
 */

export type CallChannel = "browser" | "phone";

/**
 * Defaults to `"browser"` for anything that isn't exactly `"phone"`.
 *
 * ~500 records on disk were written before this field existed, and network
 * input can carry any string in a `channel` query parameter — both cases must
 * read as the safe default rather than throwing or producing a bogus value.
 */
export function readCallChannel(value: string | null | undefined): CallChannel {
  return value === "phone" ? "phone" : "browser";
}
