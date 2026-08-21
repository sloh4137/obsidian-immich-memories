# Obsidian Immich Memories

Load photos from your [Immich](https://immich.app) instance for a specific calendar day, parsed from a note's frontmatter. Display them with a single small preview image, a collapsible thumbnail gallery, and a full-size modal viewer. Also supports automatic banner rendering when a note has `cssclasses: immichBanner`.

Codeblock tag: `obsidian-immich-memories` (alias `immich-memories`).

## Features

- **Frontmatter-driven date**: Reads a date field (default `date`) and timezone field (default `timezone`) from the current note's frontmatter.
- **Timezone-aware search**: Computes UTC `takenAfter`/`takenBefore` for the whole calendar day in the note's timezone using only `Intl.DateTimeFormat` (handles DST – e.g. `America/New_York` EST -5 vs EDT -4).
- **Preview + collapsible gallery**: Single 160px preview on top, `<details>` section underneath with grid of thumbnails. Click any thumbnail or preview to open full-size viewer. Gallery thumbnails have rounded corners (8px) and grow slightly on hover (`scale(1.06)`) with a subtle shadow to indicate hover.
- **Banner mode (`cssclasses: immichBanner`)**: When a note's frontmatter contains `cssclasses: immichBanner` (or `cssclass`), the plugin automatically renders the first photo from `getPhotosForDate()` as a top banner in both reading and live-preview modes. Mirrors `obsidian-immich-sync/src/render/banner.ts` pattern – mounts into `.markdown-preview-sizer` / `.cm-sizer`, uses `requestAnimationFrame` double-pass refresh (`file-open`, `layout-change`, `active-leaf-change`, `metadataCache.changed`, markdown post-processor). Signature-based dedup (`path + date + timezone`) prevents flicker, race-guarded with request counters. Click banner to open modal gallery, photo count badge in bottom-right.
- **Live-photo aware**: Immich links a still (HEIC/JPEG) to its motion video via `livePhotoVideoId`. The gallery filters out those MOV video components while keeping standalone videos. Fallback: if `livePhotoVideoId` is absent, a `*.HEIC/*.HEIF` + same-basename `*.MOV` pair (e.g. `IMG_1234.HEIC` + `IMG_1234.MOV`) is treated as live-photo and the MOV is dropped.
- **HEIC high-quality JPEG in modal**: For `.heic/.heif` originals, the full-size modal loads Immich's `size=preview` JPEG (via `getPreviewUrl()`) instead of the raw HEIC, which renders better and is higher quality than the thumbnail. The JPEG preview is cached as the "fullsize" entry for HEIC.
- **Modal viewer**: Keyboard (ArrowLeft/Right, Escape), click-to-next, and touch swipe navigation. Shows filename and taken date. Fallback chain on error: full/original → preview JPEG → thumbnail.
- **Local filesystem cache**:
  - **Asset cache**: Thumbnails and originals (and JPEG previews for HEIC) cached under `.obsidian/plugins/obsidian-immich-memories/cache/assets/` (or custom vault-relative folder). LRU eviction based on configurable size in MB.
  - **Date cache**: `date|timezone → assetIds[]` with `lastSearched`. Background cleanup evicts entries older than configurable retention days, plus hourly interval and size limit. Centralized in `getPhotosForDate()` so both the renderer and external plugins using the public API benefit from the same cache.
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

### Codeblock (memories gallery)

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
- Open the `<details>` to reveal full gallery (rounded thumbnails, hover grow).

### Banner mode (`immichBanner` cssclass)

Add `immichBanner` to your note's `cssclasses` to automatically render the first photo for that note's date as a banner at the top of the view:

```yaml
---
date: 2023-07-15
timezone: America/New_York
cssclasses:
  - immichBanner
---
```

Or inline:

```yaml
---
date: 2023-07-15
cssclasses: immichBanner
---
```

Also supports singular `cssclass`:

```yaml
cssclass: immichBanner
```

- Checks `frontmatter.cssclasses` / `cssclass` (string or array, space/comma-separated).
- If it contains `immichBanner`, extracts `date` (from `settings.dateField` or fallback `date`) and `timezone` (`timezoneField` or `timezone` or `UTC`).
- Calls `getPhotosForDate(dateStr, timezone)` – uses date cache + asset cache, same path as the codeblock.
- Renders first photo as `.immich-banner` with blurred background (`-bg`) and sharp foreground (`-fg`), mounted into `.markdown-preview-sizer` (reading) or `.cm-sizer` (live preview) via `host.prepend()`.
- Bottom-right badge shows total count: `12 photos` (managed via `.immich-banner-count`, hidden until count known).
- Click banner (or Enter/Space on focused image) opens `ImmichPhotoModal` with all photos for that day.
- Implements same lifecycle as `obsidian-immich-sync` banner: `file-open`, `layout-change`, `active-leaf-change`, `metadataCache.changed`, markdown post-processor with `requestAnimationFrame` double-pass, signature dedup (`path\ndate\ntimezone`), and removal of stray banners outside current host.

## Settings

**Settings → Immich Memories**

- **Immich server URL**: e.g. `https://immich.example.com`. No trailing slash, no `/api` suffix.
- **Immich API key**: Create in Immich → Account Settings → API Keys. The plugin sends `x-api-key` header and also appends `?apiKey=` for direct `<img>` loading.
- **Date field**: Frontmatter field holding date (default `date`). Accepts `YYYY-MM-DD` or ISO.
- **Timezone field**: Frontmatter field holding IANA timezone (default `timezone`). Falls back to UTC.

### Asset cache

- **Enable asset cache**: Cache thumbs and originals (and HEIC preview JPEGs) locally.
- **Asset cache size (MB)**: Max total bytes. LRU eviction.
- **Asset cache folder**: Custom vault-relative path, e.g. `ImmichCache/assets`. Empty = default inside plugin folder.
- **Clear asset cache**: Deletes `thumbs/`, `full/`, and `asset-cache.json`. Shows current usage `X MB / limit`.

How it works:
- Thumbnails cached eagerly after a date search.
- Fullsize cached on demand when modal opens; for HEIC, the preview JPEG (`size=preview`) is cached as fullsize.
- `getThumbnailUrl(assetId)` / `getFullsizeUrl(assetId)` return local `app://` resource path if cached, otherwise remote URL.
- `getPreviewUrl(assetId)` returns remote preview JPEG URL (used for HEIC in modal).

### Date cache

- **Enable date cache**: Cache `date|timezone → assetIds[]`.
- **Date cache retention (days)**: Evict entries where `lastSearched` older than N days. `0` = never auto-evict.
- **Clear date cache**: Removes `date-cache.json` mappings (shows entry count).
- **Run date cleanup now**: Manually triggers LRU by age.

Cleanup runs on startup and every hour; asset size enforced every 30 min. The date cache is now centralized in `plugin.getPhotosForDate()` – both the block renderer and external plugins calling the public API benefit from it.

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
  fullsizeUrl: string;  // local app:// if cached, else remote original; for HEIC this may be cached JPEG preview
  previewUrl?: string;  // remote JPEG preview (size=preview) – ideal for HEIC fullsize modal
  takenAt?: string;
  originalFileName?: string;
  type?: string; // IMAGE, VIDEO, etc.
  livePhotoVideoId?: string | null; // if image is live-photo, points to its MOV assetId
}

interface ImmichPublicApi {
  getPhotosForDate(dateStr: string, timeZone: string): Promise<ImmichPhoto[]>;
  findPhotos(dateStr: string, timeZone: string): Promise<ImmichPhoto[]>; // alias, uses same date+asset cache
  getThumbnailUrl(assetId: string): string; // local if cached
  getFullsizeUrl(assetId: string): string;  // local if cached, for HEIC local is JPEG preview after first modal open
  getPreviewUrl(assetId: string): string;   // remote preview JPEG, never local-cached separately
  searchByDateRangeTaken(takenAfter: string, takenBefore: string): Promise<ImmichPhoto[]>;
  clearAssetCache(): Promise<void>;
  clearDateCache(): Promise<void>;
  getAssetCacheSizeMB(): number;
}
```

- `getPhotosForDate` is the centralized entry point:
  - Checks date cache `date|timezone → assetIds[]` if `useDateCache` enabled, returns via `buildPhotosFromAssetIds` with local URLs when available.
  - Otherwise queries Immich `POST /api/search/metadata`, filters out live-photo motion videos (`livePhotoVideoId` set + HEIC/MOV basename fallback), populates date cache with filtered IDs, and background-caches thumbnails.
  - Returns `ImmichPhoto[]` with `thumbnailUrl`/`fullsizeUrl` as local `app://` resource paths when cached, else remote URLs; `previewUrl` always remote preview JPEG.
  - Both the codeblock renderer and external plugins use this same path, so caching and filtering are shared.
- `searchByDateRangeTaken` also filters live-photo videos and applies local URLs.
- `getPreviewUrl` is useful for HEIC handling – higher-quality JPEG than thumbnail, smaller than original, transcoded by Immich.

Additional utility exposed on plugin instance: `getDayRangeUtc(dateStr, timeZone)` → `{ takenAfter, takenBefore, startUtc, endUtc }`.

## Security & Privacy

- All requests go directly to your configured Immich server, no third-party services.
- API key stored in Obsidian's `data.json` inside plugin folder (local only), sent as `x-api-key` header and `?apiKey=` query for image tags.
- No telemetry.

## Styles

`styles.css` is theme-aware, uses Obsidian CSS variables:
- Gallery grid with 96px min cells, 6px gap
- Thumbnails: `border-radius: 8px`, `overflow: hidden`, `transition: transform 0.18s ease`; on hover `scale(1.06)` + shadow, inner image brightens – clear hover affordance.
- Preview, modal nav, and explicit error block with left red border.
- Banner: `.immich-banner` 280px height, flex centered, blurred background layer `.immich-banner-bg` (`blur(20px) brightness(0.85) scale(1.1)`) and sharp foreground `.immich-banner-fg` (`object-fit: contain`), hover scale, scrim gradient via `::after`, bottom-right count pill `.immich-banner-count` (`rgba(0,0,0,0.62)`, `backdrop-filter: blur(2px)`, `tabular-nums`), hidden variant `--hidden`. Also supports legacy `.immich-banner-image` single-image fallback. Mounted inside sizer selectors with `width:100%; margin-bottom:12px`.

## Versioning

Bump version in `manifest.json`, update `versions.json`, create GitHub release with tag matching version (no `v` prefix), attach `manifest.json`, `main.js`, `styles.css`.

## License

0-BSD (see LICENSE)
