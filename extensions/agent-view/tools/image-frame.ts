import { deleteAllKittyImages, deleteKittyImage } from "@earendil-works/pi-tui";
import {
  deleteAllKittyPlacements,
  getKittyImagePlacement,
} from "@earendil-works/pi-tui/dist/terminal-image.js";

/** The standalone watcher owns its alt screen; Pi's overlay uses Pi's image manager. */
export class WatchImageFrame {
  private uploaded = new Set<number>();

  render(lines: string[]) {
    let cleanup = "";
    const output = lines.map((line) => {
      const image = getKittyImagePlacement(line);
      if (!image) return line;
      if (this.uploaded.has(image.imageId)) return image.replacementLine;
      this.uploaded.add(image.imageId);
      return line;
    });
    // Retain at most 512 uploads; avatar row caches are separately capped at 400.
    while (this.uploaded.size > 512) {
      const oldest = this.uploaded.values().next().value;
      if (oldest === undefined) break;
      this.uploaded.delete(oldest);
      cleanup += deleteKittyImage(oldest);
    }
    return {
      lines: output,
      cleanup: this.uploaded.size
        ? `${cleanup}${deleteAllKittyPlacements()}`
        : cleanup,
    };
  }

  dispose() {
    const sequence = this.uploaded.size ? deleteAllKittyImages() : "";
    this.uploaded.clear();
    return sequence;
  }
}
