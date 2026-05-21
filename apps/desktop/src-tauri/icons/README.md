# Desktop Shell Icons

`icon.png` is the **canonical 512×512 RGBA source icon** consumed by Tauri's
bundler. The current file is a flat brand-blue placeholder generated via
`python3` (stdlib only). Replace it with the final brand asset before
tagging `v0.1.0` (Task 14).

To regenerate platform-specific icon variants (`icon.icns`, `icon.ico`, etc.)
once a final PNG is in place, run:

```sh
pnpm --filter desktop tauri icon icons/icon.png
```

The generated derivatives are git-ignored (see `apps/desktop/.gitignore`).
