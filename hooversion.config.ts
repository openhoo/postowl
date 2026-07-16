export default {
  branches: ["main"],
  packages: [
    {
      name: "postowl",
      path: ".",
      type: "rust",
      manifest: "src-tauri/Cargo.toml",
      changelog: "CHANGELOG.md",
      scopes: ["postowl", "desktop", "tauri", "release"],
      dependencies: [],
    },
  ],
  hooks: {
    afterVersion: ["node scripts/sync-version.ts"],
  },
  github: {
    releases: true,
  },
};
