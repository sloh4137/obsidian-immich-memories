import { App, Modal, Notice } from "obsidian";
import { ImmichPhoto } from "../types";
import { AssetFileCache } from "../cache";

export class ImmichPhotoModal extends Modal {
	private photos: ImmichPhoto[];
	private currentIndex: number;
	private imgEl: HTMLImageElement | null = null;
	private captionEl: HTMLElement | null = null;
	private counterEl: HTMLElement | null = null;
	private container: HTMLElement | null = null;
	private assetCache?: AssetFileCache;
	private apiKey: string;
	/** Invalidates in-flight loads when the user pages away. */
	private loadToken = 0;

	constructor(
		app: App,
		photos: ImmichPhoto[],
		startIndex = 0,
		assetCache?: AssetFileCache,
		apiKey = "",
	) {
		super(app);
		this.photos = photos;
		this.currentIndex = Math.max(0, Math.min(startIndex, photos.length - 1));
		this.assetCache = assetCache;
		this.apiKey = apiKey;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;

		modalEl.addClass("immich-memories-modal");
		contentEl.addClass("immich-memories-modal-content");
		contentEl.empty();

		const header = contentEl.createDiv({ cls: "immich-memories-modal-header" });
		this.counterEl = header.createDiv({ cls: "immich-memories-modal-counter" });
		this.updateCounter();

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
		wrapper.addEventListener(
			"touchstart",
			(e) => {
				startX = e.touches[0]?.clientX ?? 0;
			},
			{ passive: true },
		);
		wrapper.addEventListener(
			"touchend",
			(e) => {
				const endX = e.changedTouches[0]?.clientX ?? 0;
				const diff = endX - startX;
				if (Math.abs(diff) > 50) {
					if (diff > 0) this.showPrevious();
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

		this.imgEl.classList.add("is-loading");
		this.imgEl.src = immediateUrl;
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

		if (this.captionEl) {
			this.captionEl.empty();
			if (photo.originalFileName) {
				this.captionEl.createSpan({ text: photo.originalFileName, cls: "immich-memories-filename" });
			}
			if (photo.takenAt) {
				const date = this.formatDate(photo.takenAt);
				if (date) {
					this.captionEl.createSpan({ text: date, cls: "immich-memories-taken-at" });
				}
			}
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
