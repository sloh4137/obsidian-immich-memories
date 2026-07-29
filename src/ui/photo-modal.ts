import { App, Modal } from "obsidian";
import { ImmichPhoto } from "../types";

export class ImmichPhotoModal extends Modal {
	private photos: ImmichPhoto[];
	private currentIndex: number;
	private imgEl: HTMLImageElement | null = null;
	private captionEl: HTMLElement | null = null;
	private counterEl: HTMLElement | null = null;
	private container: HTMLElement | null = null;

	constructor(app: App, photos: ImmichPhoto[], startIndex = 0) {
		super(app);
		this.photos = photos;
		this.currentIndex = Math.max(0, Math.min(startIndex, photos.length - 1));
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;

		modalEl.addClass("immich-memories-modal");
		contentEl.addClass("immich-memories-modal-content");
		contentEl.empty();

		// Header with counter and close hint
		const header = contentEl.createDiv({ cls: "immich-memories-modal-header" });
		this.counterEl = header.createDiv({ cls: "immich-memories-modal-counter" });
		this.updateCounter();

		// Image wrapper
		const wrapper = contentEl.createDiv({ cls: "immich-memories-modal-wrapper" });

		// Nav buttons
		const prevBtn = wrapper.createEl("button", {
			cls: "immich-memories-modal-nav immich-memories-modal-prev",
			text: "‹",
		});
		prevBtn.setAttr("aria-label", "Previous photo");
		prevBtn.addEventListener("click", () => this.showPrevious());

		this.imgEl = wrapper.createEl("img", { cls: "immich-memories-modal-image" });
		this.imgEl.addEventListener("click", () => {
			// Click on image to go next, consistent with typical lightbox
			if (this.photos.length > 1) this.showNext();
		});

		const nextBtn = wrapper.createEl("button", {
			cls: "immich-memories-modal-nav immich-memories-modal-next",
			text: "›",
		});
		nextBtn.setAttr("aria-label", "Next photo");
		nextBtn.addEventListener("click", () => this.showNext());

		// Caption
		this.captionEl = contentEl.createDiv({ cls: "immich-memories-modal-caption" });

		this.container = wrapper;

		this.loadCurrent();

		// Keyboard navigation
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

		// Touch swipe support
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

	private loadCurrent(): void {
		const photo = this.photos[this.currentIndex];
		if (!photo || !this.imgEl) return;

		this.updateCounter();

		// Show loading state
		this.imgEl.classList.add("is-loading");
		this.imgEl.src = photo.fullsizeUrl;
		this.imgEl.alt = photo.originalFileName || `Photo ${photo.assetId}`;

		this.imgEl.onload = () => {
			this.imgEl?.classList.remove("is-loading");
		};
		this.imgEl.onerror = () => {
			this.imgEl?.classList.remove("is-loading");
			// Fallback to thumbnail if original fails (maybe original is too large or endpoint differs)
			// Try preview variant by swapping size
			if (this.imgEl && this.imgEl.src !== photo.thumbnailUrl) {
				// Second attempt with preview? We attempt to derive preview URL from thumbnail pattern
				// If thumbnail contains size=thumbnail, replace with size=preview; else keep original logic
				const previewUrl = photo.thumbnailUrl.includes("size=thumbnail")
					? photo.thumbnailUrl.replace("size=thumbnail", "size=preview")
					: photo.thumbnailUrl;
				// Avoid infinite loop
				if (previewUrl !== this.imgEl.src) {
					this.imgEl.src = previewUrl;
					return;
				}
			}
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
		this.loadCurrent();
	}

	private showNext(): void {
		if (this.photos.length <= 1) return;
		this.currentIndex = (this.currentIndex + 1) % this.photos.length;
		this.loadCurrent();
	}
}
