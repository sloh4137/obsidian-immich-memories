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

	constructor(app: App, photos: ImmichPhoto[], startIndex = 0, assetCache?: AssetFileCache) {
		super(app);
		this.photos = photos;
		this.currentIndex = Math.max(0, Math.min(startIndex, photos.length - 1));
		this.assetCache = assetCache;
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

	private async loadCurrent(): Promise<void> {
		const photo = this.photos[this.currentIndex];
		if (!photo || !this.imgEl) return;

		this.updateCounter();

		// Try to use local fullsize if cached, else remote, and attempt to cache in background
		let fullUrl = photo.fullsizeUrl;

		if (this.assetCache?.isEnabled()) {
			const localFull = this.assetCache.getFullsizeLocalUrl(photo.assetId);
			if (localFull) {
				fullUrl = localFull;
			} else {
				// Attempt to cache fullsize now (await with timeout)
				try {
					// Note: we don't have apiKey here directly, but cache stores remoteUrl which already includes key in query,
					// and requestUrl will be called with apiKey from settings via assetCache's ensure method which needs key.
					// We'll rely on the cache method to fetch using query param url (which includes apiKey) even without header.
					// For proper behavior, assetCache's ensureFullsizeCached expects remoteUrl and apiKey – we pass empty apiKey and rely on query param
					const cached = await this.assetCache.ensureFullsizeCached(photo.assetId, photo.fullsizeUrl, "");
					if (cached) fullUrl = cached;
				} catch {
					// ignore
				}
			}
		}

		if (!this.imgEl) return;
		this.imgEl.classList.add("is-loading");
		// Update src
		this.imgEl.src = fullUrl;
		this.imgEl.alt = photo.originalFileName || `Photo ${photo.assetId}`;

		this.imgEl.onload = () => {
			this.imgEl?.classList.remove("is-loading");
		};
		this.imgEl.onerror = () => {
			this.imgEl?.classList.remove("is-loading");
			if (this.imgEl && this.imgEl.src !== photo.thumbnailUrl) {
				const previewUrl = photo.thumbnailUrl.includes("size=thumbnail")
					? photo.thumbnailUrl.replace("size=thumbnail", "size=preview")
					: photo.thumbnailUrl;
				if (previewUrl !== this.imgEl.src) {
					this.imgEl.src = previewUrl;
					return;
				}
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
