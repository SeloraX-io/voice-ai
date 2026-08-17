import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),

  // Vendored third-party UI, copied in from LiveKit's Agents UI shadcn registry
  // and adapted only enough to drop its LiveKit transport dependency.
  //
  // Held to upstream's standards rather than ours on purpose: the value of
  // vendored code is that it stays a small, legible diff against the source it
  // came from, so it can be re-synced when upstream changes. Reformatting it to
  // satisfy our lint rules would destroy that, to fix warnings in code we did
  // not write and do not maintain.
  //
  // NOTE: agent-audio-visualizer-aura.tsx is Polyform Non-Resale (© UNCRN LLC),
  // not Apache-2.0. react-shader-toy.tsx is MIT. Both carry their own headers.
  {
    files: ["components/agents-ui/**", "hooks/agents-ui/**"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
]);

export default eslintConfig;
