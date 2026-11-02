// Shrinks tool-generated images before they're relayed to the room, so a 4K render
// doesn't become a multi-megabyte WebSocket frame.

const MAX_SIDE = 1600;
const QUALITY = 0.88;
/** Largest GIF (base64 length) sent unchanged; well under the relay's 6,000,000 cap. */
const MAX_GIF_B64 = 1_500_000;

export interface PreparedImage {
  mime: string;
  /** Base64 without the data: prefix. */
  data: string;
  width: number;
  height: number;
}

function base64ToBlob(data: string, mime: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function prepareImage(mime: string, data: string): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(base64ToBlob(data, mime));
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  // Small images and GIFs (which would lose their animation) are sent as they are.
  // A GIF that is too large (in bytes or pixels) is re-encoded as a still WebP instead.
  const keepGif = mime === "image/gif" && scale === 1 && data.length <= MAX_GIF_B64;
  if (keepGif || (mime !== "image/gif" && scale === 1 && data.length < 600_000)) {
    bitmap.close();
    return { mime, data, width, height };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode image"))), "image/webp", QUALITY),
  );
  return { mime: "image/webp", data: await blobToBase64(blob), width, height };
}
