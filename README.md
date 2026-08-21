# Obsidian Immich Memories

Load photos from your [Immich](https://immich.app) instance for a specific calendar day, parsed from a note's frontmatter. Display them with a single small preview image, a collapsible thumbnail gallery, and a full-size modal viewer.

Codeblock tag: `obsidian-immich-memories` (alias `immich-memories`).

## Features

- **Frontmatter-driven date**: Reads a date field (default `date`) and timezone field (default `timezone`) from the current note's frontmatter.
- **Timezone-aware search**: Computes UTC `takenAfter`/`takenBefore` for the whole calendar day in the note's timezone using only `Intl.DateTimeFormat` (handles DST – e.g. `America/New_York` EST -5 vs EDT -4).
- **Preview + collapsible gallery**: Single 160px preview on top, `<details>` section underneath with grid of thumbnails. Click any thumbnail or preview to open full-size viewer.
- **Modal viewer**: Keyboard (ArrowLeft/Right, Escape), click-to-next, and touch swipe navigation. Shows filename and taken date. Falls back to preview if original fails.
- **Local filesystem cache**:
  - **Asset cache**: Thumbnails and originals cached under `.obsidian/plugins/obsidian-immich-memories/cache/assets/` (or custom vault-relative folder). LRU eviction based on configurable size in MB.
  - **Date cache**: `date|timezone → assetIds[]` with `timeLastSearched`. Background cleanup evicts entries older than configurable retention days, plus hourly interval and size limit.
- **Explicit error handling**: Connection failures, 401/403 auth errors, 404 endpoint-not-found (with guidance about base URL vs `/api` suffix and Immich v1.90+ requirement), 400 bad request, and 5xx server errors all show server URL, attempted endpoint/range, server response body, and troubleshooting checklist instead of generic "not found".
- **Public API** for other plugins/scripts.

## Requirements

- Immich server (v1.90+ recommended for `/api/search/metadata`)
- Obsidian 1.3.0+ (uses `setDisabled`, `setHeading`)

## Installation

### Manual

1. Build or download release assets `main.js`, `manifest.json`, `styles.css`.
2. Copy them to `<Vault>/.obsidian/plugins/obsidian-immich-memories/`.
3. Reload Obsidian and enable **Immich Memories** in **Settings → Community plugins**.

### Development

```bash
npm install
npm run dev   # watch
npm run build # production
npm run lint
```

## Usage

Add frontmatter to a daily note:

```yaml
---
date: 2023-07-15
timezone: America/New_York
---
```

Then in the note body:

````markdown
```obsidian-immich-memories
```
````

Override inside the block (optional):

````markdown
```obsidian-immich-memories
date: 2024-01-02
timezone: Europe/London
```
````

Or JSON:

````markdown
```obsidian-immich-memories
{"date": "2023-07-15", "timezone": "Asia/Tokyo"}
```
````

- First render shows `Memory from YYYY-MM-DD` small preview.
- Click preview or any thumbnail to open modal.
- Open the `<details>` to reveal full gallery.

## Settings

**Settings → Immich Memories**

- **Immich server URL**: e.g. `https://immich.example.com`. No trailing slash, no `/api` suffix.
- **Immich API key**: Create in Immich → Account Settings → API Keys. The plugin sends `x-api-key` header and also appends `?apiKey=` for direct `<img>` loading.
- **Date field**: Frontmatter field holding date (default `date`). Accepts `YYYY-MM-DD` or ISO.
- **Timezone field**: Frontmatter field holding IANA timezone (default `timezone`). Falls back to UTC.

### Asset cache

- **Enable asset cache**: Cache thumbs and originals locally.
- **Asset cache size (MB)**: Max total bytes. LRU eviction.
- **Asset cache folder**: Custom vault-relative path, e.g. `ImmichCache/assets`. Empty = default inside plugin folder.
- **Clear asset cache**: Deletes `thumbs/`, `full/`, and `asset-cache.json`. Shows current usage `X MB / limit`.

How it works:
- Thumbnails cached eagerly after a date search.
- Fullsize cached on demand when modal opens.
- `getThumbnailUrl(assetId)` / `getFullsizeUrl(assetId)` return local `app://` resource path if cached, otherwise remote URL.

### Date cache

- **Enable date cache**: Cache `date|timezone → assetIds[]`.
- **Date cache retention (days)**: Evict entries where `timeLastSearched` older than N days. `0` = never auto-evict.
- **Clear date cache**: Removes `date-cache.json` mappings (shows entry count).
- **Run date cleanup now**: Manually triggers LRU by age.

Cleanup runs on startup and every hour; asset size enforced every 30 min.

## Explicit error messages

Instead of generic "not found", the plugin distinguishes:

- **Not configured**: Server URL and/or API key missing – points to Settings.
- **Network failure**: `Failed to connect to Immich server at <url>. Network error: <cause>. Check URL correctness (no /api), server running, network, self-signed cert`.
- **401**: Authentication failed – key invalid/expired, regenerate in Immich.
- **403**: Access forbidden – key lacks permissions.
- **404**: API endpoint not found – clarifies this is NOT "no photos", but URL/version wrong. Suggests base URL example, Immich v1.90+, reverse proxy blocking POST `/api/search/metadata`.
- **400**: Bad request – invalid date format/payload.
- **5xx**: Server error – check Immich logs.

UI displays title, full body, `Server: <url>` and `Requested: <date> in <tz>`, plus bullet-point troubleshooting. Successful empty search shows `No photos found in Immich for <date> – connection succeeded but no assets matched`.

## Public API

Other plugins can access via `app.plugins.plugins['obsidian-immich-memories'].api`:

```ts
interface ImmichPhoto {
  assetId: string;
  thumbnailUrl: string; // local app:// path if cached, else remote URL with ?apiKey
  fullsizeUrl: string;
  takenAt?: string;
  originalFileName?: string;
}

interface ImmichPublicApi {
  getPhotosForDate(dateStr: string, timeZone: string): Promise<ImmichPhoto[]>;
  findPhotos(dateStr: string, timeZone: string): Promise<ImmichPhoto[]>; // alias
  getThumbnailUrl(assetId: string): string; // local if cached
  getFullsizeUrl(assetId: string): string;  // local if cached
  searchByDateRangeTaken(takenAfter: string, takenBefore: string): Promise<ImmichPhoto[]>;
  clearAssetCache(): Promise<void>;
  clearDateCache(): Promise<void>;
  getAssetCacheSizeMB(): number;
}
```

- `getPhotosForDate` uses date cache if enabled, otherwise queries Immich, populates date cache, and background-caches thumbnails.
- URLs can be local filesystem resource paths or remote URLs per spec.

Additional utility exposed on plugin instance: `getDayRangeUtc(dateStr, timeZone)` → `{ takenAfter, takenBefore, startUtc, endUtc }`.

## Security & Privacy

- All requests go directly to your configured Immich server, no third-party services.
- API key stored in Obsidian's `data.json` inside plugin folder (local only), sent as `x-api-key` header and `?apiKey=` query for image tags.
- No telemetry.

## Styles

`styles.css` is theme-aware, uses Obsidian CSS variables, minimal layout, no heavy dependencies. Gallery grid, preview, modal nav, and explicit error block with left red border.

## Versioning

Bump version in `manifest.json`, update `versions.json`, create GitHub release with tag matching version (no `v` prefix), attach `manifest.json`, `main.js`, `styles.css`.

## License

0-BSD (see LICENSE)
