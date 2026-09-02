import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "CourtMate_Pitch_Deck/**",
    ],
  },
  ...nextVitals,
  {
    rules: {
      // Existing async UI flows are intentionally state-driven; surface these
      // React Compiler advisories without blocking a release on a broad rewrite.
      "react-hooks/immutability": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default eslintConfig;
