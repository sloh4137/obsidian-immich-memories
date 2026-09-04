import { App, Modal, Notice } from "obsidian";
import { ImmichPhoto } from "../types";
import { AssetFileCache } from "../cache";

export class ImmichPhotoModal extends Modal {
	private photos: ImmichPhoto[];
	private currentIndex: number;
	private imgEl: HTMLImageElement | null = null;
	private captionEl: HTMLElement | null = null;
	private counterEl: HTMLElement | null = null;
	private filenameEl: HTMLElement | null = null;
	private takenAtEl: HTMLElement | null = null;
	private container: HTMLElement | null = null;
	private assetCache?: AssetFileCache;
	private apiKey: string;
	private swipeUpToClose: boolean;
	/** Invalidates in-flight loads when the user pages away. */
	private loadToken = 0;

	constructor(
		app: App,
		photos: ImmichPhoto[],
		startIndex = 0,
		assetCache?: AssetFileCache,
		apiKey = "",
		options?: { swipeUpToClose?: boolean },
	) {
		super(app);
		this.photos = photos;
		this.currentIndex = Math.max(0, Math.min(startIndex, photos.length - 1));
		this.assetCache = assetCache;
		this.apiKey = apiKey;
		this.swipeUpToClose = options?.swipeUpToClose ?? true;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;

		modalEl.addClass("immich-memories-modal");
		contentEl.addClass("immich-memories-modal-content");
		contentEl.empty();

		const header = contentEl.createDiv({ cls: "immich-memories-modal-header" });
		this.counterEl = header.createDiv({ cls: "immich-memories-modal-counter" });
		this.updateCounter();

		// In-flow close button: Obsidian's floating .modal-close-button sits
		// under the iPhone status bar / top bar on small screens, so the
		// reachable close control lives in the header layout instead.
		const closeBtn = header.createEl("button", {
			cls: "immich-memories-modal-close",
			text: "✕",
		});
		closeBtn.setAttr("aria-label", "Close");
		closeBtn.addEventListener("click", () => this.close());

		const wrapper = contentEl.createDiv({ cls: "immich-memories-modal-wrapper" });

		const prevBtn = wrapper.createEl("button", {
			cls: "immich-memories-modal-nav immich-memories-modal-prev",
			text: "‹",
		});
		prevBtn.setAttr("aria-label", "Previous photo");
		prevBtn.addEventListener("click", () => this.showPrevious());

		this.imgEl = wrapper.createEl("img", { cls: "immich-memories-modal-image" });
		this.imgEl.addEventListener("click", () => {
			if (this.photos.length > 1) this.showNext();
		});

		const nextBtn = wrapper.createEl("button", {
			cls: "immich-memories-modal-nav immich-memories-modal-next",
			text: "›",
		});
		nextBtn.setAttr("aria-label", "Next photo");
		nextBtn.addEventListener("click", () => this.showNext());

		this.captionEl = contentEl.createDiv({ cls: "immich-memories-modal-caption" });
		// Create persistent caption children once so navigating does not destroy/recreate
		// DOM nodes and cause a flash, especially when images are already cached locally.
		this.filenameEl = this.captionEl.createSpan({ cls: "immich-memories-filename" });
		this.takenAtEl = this.captionEl.createSpan({ cls: "immich-memories-taken-at" });

		this.container = wrapper;

		void this.loadCurrent();

		this.scope.register([], "ArrowLeft", () => {
			this.showPrevious();
			return false;
		});
		this.scope.register([], "ArrowRight", () => {
			this.showNext();
			return false;
		});
		this.scope.register([], "Escape", () => {
			this.close();
			return false;
		});

		let startX = 0;
		let startY = 0;
		wrapper.addEventListener(
			"touchstart",
			(e) => {
				startX = e.touches[0]?.clientX ?? 0;
				startY = e.touches[0]?.clientY ?? 0;
			},
			{ passive: true },
		);
		wrapper.addEventListener(
			"touchend",
			(e) => {
				const endX = e.changedTouches[0]?.clientX ?? 0;
				const endY = e.changedTouches[0]?.clientY ?? 0;
				const diffX = endX - startX;
				const diffY = endY - startY;
				// Swipe up (vertical, dominant axis) closes when enabled.
				if (
					this.swipeUpToClose &&
					diffY < -75 &&
					Math.abs(diffY) > Math.abs(diffX)
				) {
					this.close();
					return;
				}
				// Horizontal paging only when horizontal motion dominates,
				// so a vertical swipe never accidentally changes photo.
				if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY)) {
					if (diffX > 0) this.showPrevious();
					else this.showNext();
				}
			},
			{ passive: true },
		);
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.imgEl = null;
		this.captionEl = null;
		this.filenameEl = null;
		this.takenAtEl = null;
		this.counterEl = null;
		this.container = null;
	}

	private updateCounter(): void {
		if (this.counterEl) {
			this.counterEl.setText(`${this.currentIndex + 1} / ${this.photos.length}`);
		}
	}

	private isHeicImage(photo: ImmichPhoto): boolean {
		const name = photo.originalFileName?.toLowerCase() ?? "";
		return name.endsWith(".heic") || name.endsWith(".heif");
	}

	private async loadCurrent(): Promise<void> {
		const photo = this.photos[this.currentIndex];
		if (!photo || !this.imgEl) return;

		const token = ++this.loadToken;

		this.updateCounter();

		// For HEIC originals, prefer the higher-quality JPEG preview (size=preview)
		// because HEIC may not render well in some environments and the preview
		// is a transcoded JPEG. This gives a better experience than the small thumbnail.
		const isHeic = this.isHeicImage(photo);
		const remoteHighQualityUrl = isHeic && photo.previewUrl ? photo.previewUrl : photo.fullsizeUrl;

		// Paint whatever is already warm before touching the network. requestUrl
		// buffers the entire response before resolving, so awaiting the download
		// first leaves the modal blank for seconds on a large original.
		// Order matters: a locally cached thumbnail costs no network at all,
		// whereas previewUrl is a fresh (if quick) fetch.
		const localFull = !isHeic ? (this.assetCache?.getFullsizeLocalUrl(photo.assetId) ?? null) : null;
		const localThumb = this.assetCache?.getThumbnailLocalUrl(photo.assetId) ?? null;
		const immediateUrl =
			localFull ?? localThumb ?? photo.previewUrl ?? photo.thumbnailUrl ?? remoteHighQualityUrl;

		// If the immediate URL is already a local file (cached), avoid the loading flash
		// — the image will paint synchronously from disk, so keeping opacity 1 prevents
		// a brief dimmed state. For remote URLs we keep the loading indicator.
		const isImmediateRemote = immediateUrl.startsWith("http://") || immediateUrl.startsWith("https://");
		if (isImmediateRemote) {
			this.imgEl.classList.add("is-loading");
		} else {
			this.imgEl.classList.remove("is-loading");
		}
		// Only assign if changed to avoid spurious reloads when navigating quickly
		if (this.imgEl.src !== immediateUrl) {
			this.imgEl.src = immediateUrl;
		}
		this.imgEl.alt = photo.originalFileName || `Photo ${photo.assetId}`;

		this.imgEl.onload = () => {
			this.imgEl?.classList.remove("is-loading");
		};
		this.imgEl.onerror = () => {
			this.imgEl?.classList.remove("is-loading");
			if (!this.imgEl) return;

			const currentSrc = this.imgEl.src;
			const thumbUrl = photo.thumbnailUrl;
			const previewUrl = photo.previewUrl ?? (thumbUrl.includes("size=thumbnail") ? thumbUrl.replace("size=thumbnail", "size=preview") : thumbUrl);
			const fullUrlFallback = photo.fullsizeUrl;

			// Fallback chain: if we failed on fullsize/original, try preview JPEG, then thumbnail
			if (currentSrc !== previewUrl && currentSrc !== thumbUrl) {
				// First try the JPEG preview (especially useful for HEIC)
				if (previewUrl && previewUrl !== currentSrc) {
					this.imgEl.src = previewUrl;
					return;
				}
			}
			if (currentSrc !== thumbUrl && thumbUrl) {
				this.imgEl.src = thumbUrl;
				return;
			}
			// If we were already on thumbnail and still failed, try fullsize as last resort if different
			if (currentSrc !== fullUrlFallback && fullUrlFallback) {
				this.imgEl.src = fullUrlFallback;
				return;
			}
			new Notice("Failed to load fullsize image; showing thumbnail if available");
		};

		// Update persistent caption elements without destroying/recreating nodes
		// to avoid flashing when loading from cache and to keep layout stable.
		if (this.filenameEl) {
			this.filenameEl.setText(photo.originalFileName ?? "");
			this.filenameEl.style.display = photo.originalFileName ? "" : "none";
		}
		if (this.takenAtEl) {
			const date = photo.takenAt ? this.formatDate(photo.takenAt) : "";
			this.takenAtEl.setText(date);
			this.takenAtEl.style.display = date ? "" : "none";
		}

		// Still called when localFull is set: it verifies the file and records
		// the LRU access, then returns the same URL so no reassignment happens.
		let fullUrl = localFull ?? remoteHighQualityUrl;
		if (this.assetCache?.isEnabled()) {
			try {
				// Cache the chosen high-quality URL as the "fullsize" entry.
				// For HEIC this means we cache the JPEG preview, overwriting any
				// previously cached HEIC original.
				const cached = await this.assetCache.ensureFullsizeCached(
					photo.assetId,
					remoteHighQualityUrl,
					this.apiKey,
				);
				if (cached) fullUrl = cached;
			} catch {
				fullUrl = localFull ?? remoteHighQualityUrl;
			}
		}

		// The user may have paged away while the original downloaded
		if (token !== this.loadToken || !this.imgEl) return;
		if (fullUrl && fullUrl !== immediateUrl) {
			this.imgEl.src = fullUrl;
		}
	}

	private formatDate(iso: string): string {
		try {
			const d = new Date(iso);
			if (isNaN(d.getTime())) return iso;
			return d.toLocaleString();
		} catch {
			return iso;
		}
	}

	private showPrevious(): void {
		if (this.photos.length <= 1) return;
		this.currentIndex = (this.currentIndex - 1 + this.photos.length) % this.photos.length;
		void this.loadCurrent();
	}

	private showNext(): void {
		if (this.photos.length <= 1) return;
		this.currentIndex = (this.currentIndex + 1) % this.photos.length;
		void this.loadCurrent();
	}
}
