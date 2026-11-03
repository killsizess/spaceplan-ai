import type { Underlay } from "@/domain/floor-plan/types";

export const MAX_UNDERLAY_FILE_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_EDGE = 2048;
const MAX_DATA_URL_LENGTH = 1_200_000;

function checkedDimensions(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error(
      "Не удалось прочитать размеры изображения. Выберите другой JPG или PNG.",
    );
  }
  if (width * height > MAX_PIXELS || width > 40_000 || height > 40_000) {
    throw new Error(
      "Изображение слишком большое: допустимо до 40 мегапикселей.",
    );
  }
  return { width, height };
}

/** Inspect dimensions before asking the browser to allocate decoded pixels. */
export function inspectUnderlayImage(bytes: Uint8Array, mime: string) {
  if (mime === "image/png") {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (
      bytes.length < 33 ||
      !signature.every((value, index) => bytes[index] === value) ||
      bytes[12] !== 73 ||
      bytes[13] !== 72 ||
      bytes[14] !== 68 ||
      bytes[15] !== 82
    ) {
      throw new Error("Содержимое файла не соответствует PNG.");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(8) !== 13) throw new Error("Повреждён заголовок PNG.");
    return checkedDimensions(view.getUint32(16), view.getUint32(20));
  }
  if (mime === "image/jpeg") {
    if (
      bytes.length < 4 ||
      bytes[0] !== 255 ||
      bytes[1] !== 216 ||
      bytes[2] !== 255
    ) {
      throw new Error("Содержимое файла не соответствует JPG.");
    }
    let position = 2;
    while (position < bytes.length) {
      if (bytes[position] !== 255) break;
      while (bytes[position] === 255) position += 1;
      const marker = bytes[position++];
      if (marker === 218 || marker === 217 || marker === undefined) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (position + 2 > bytes.length) break;
      const length = bytes[position] * 256 + bytes[position + 1];
      if (length < 2 || position + length > bytes.length) break;
      const isFrame =
        marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker);
      if (isFrame) {
        if (length < 8) break;
        return checkedDimensions(
          bytes[position + 5] * 256 + bytes[position + 6],
          bytes[position + 3] * 256 + bytes[position + 4],
        );
      }
      position += length;
    }
    throw new Error(
      "Не удалось прочитать размеры JPG: файл повреждён или имеет неподдерживаемый формат.",
    );
  }
  throw new Error(
    "Выберите изображение JPG или PNG. Другие форматы пока не поддерживаются.",
  );
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(
        new Error(
          "Браузер не смог открыть изображение. Проверьте файл JPG или PNG.",
        ),
      );
    image.src = url;
  });
}

function optimizeUnderlay(
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  name: string,
): Underlay {
  checkedDimensions(sourceWidth, sourceHeight);
  const ratio = Math.min(1, MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  let width = Math.max(1, Math.round(sourceWidth * ratio));
  let height = Math.max(1, Math.round(sourceHeight * ratio));
  const canvas = document.createElement("canvas");
  try {
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("Не удалось подготовить изображение в этом браузере.");
    let dataUrl = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      canvas.width = width;
      canvas.height = height;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      for (const quality of [0.88, 0.74, 0.6, 0.46]) {
        dataUrl = canvas.toDataURL("image/jpeg", quality);
        if (dataUrl.length <= MAX_DATA_URL_LENGTH) break;
      }
      if (dataUrl.length <= MAX_DATA_URL_LENGTH) break;
      width = Math.max(1, Math.round(width * 0.75));
      height = Math.max(1, Math.round(height * 0.75));
    }
    if (
      !dataUrl.startsWith("data:image/jpeg;base64,") ||
      dataUrl.length > MAX_DATA_URL_LENGTH
    ) {
      throw new Error(
        "Не удалось уменьшить изображение для хранения. Попробуйте более простой или меньший файл.",
      );
    }
    return {
      name: name.slice(0, 160) || "План помещения",
      dataUrl,
      pixelWidth: canvas.width,
      pixelHeight: canvas.height,
      x: 0,
      y: 0,
      metersPerPixel: 10 / Math.max(canvas.width, canvas.height / 50),
      opacity: 0.65,
      visible: true,
      calibrated: false,
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Reuse image storage limits for rendered PDF pages without changing the source canvas. */
export function underlayFromCanvas(
  canvas: HTMLCanvasElement,
  name: string,
): Underlay {
  return optimizeUnderlay(canvas, canvas.width, canvas.height, name);
}

/** Local-only optimized image; the returned pixels are embedded in project JSON. */
export async function readUnderlayImage(file: File): Promise<Underlay> {
  if (!["image/jpeg", "image/png"].includes(file.type)) {
    throw new Error(
      "Выберите изображение JPG или PNG. Другие форматы пока не поддерживаются.",
    );
  }
  if (!file.size || file.size > MAX_UNDERLAY_FILE_BYTES) {
    throw new Error("Выберите непустое изображение размером до 12 МБ.");
  }
  inspectUnderlayImage(new Uint8Array(await file.arrayBuffer()), file.type);
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    return optimizeUnderlay(
      image,
      image.naturalWidth,
      image.naturalHeight,
      file.name,
    );
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
