export interface EmbedTextConfig {
  prompt: string;
  buttonText: string;
  title: string;
}

export const DEFAULT_EMBED_TEXT: EmbedTextConfig = {
  prompt: "সাহায্য দরকার?",
  buttonText: "কল শুরু করুন",
  title: "ভয়েস সহকারী",
};

const MAX_TEXT_LENGTH = 120;

function readText(params: URLSearchParams, key: keyof EmbedTextConfig): string {
  const value = params.get(key)?.trim() ?? "";
  return value === "" ? DEFAULT_EMBED_TEXT[key] : value.slice(0, MAX_TEXT_LENGTH);
}

/** Reads the public, display-only configuration forwarded by embed.js. */
export function parseEmbedTextConfig(search: string): EmbedTextConfig {
  const params = new URLSearchParams(search);
  return {
    prompt: readText(params, "prompt"),
    buttonText: readText(params, "buttonText"),
    title: readText(params, "title"),
  };
}
