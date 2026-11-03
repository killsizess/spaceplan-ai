import { useEffect, useRef, useState } from "react";
import type { Underlay } from "@/domain/floor-plan/types";
import { inspectUnderlayImage } from "./underlay-image";

/**
 * Decodes the underlay image for the canvas. The stored header is checked against the
 * project's pixel size before decoding, and again after; any mismatch is reported and
 * the image stays hidden. Returns the image only while it matches the current underlay.
 */
export function useUnderlayImage(
  underlay: Underlay | undefined,
  onError: (message: string) => void,
): HTMLImageElement | null {
  const errorRef = useRef(onError);
  const [loaded, setLoaded] = useState<{ source: string; image: HTMLImageElement } | null>(null);
  const source = underlay?.dataUrl;
  const width = underlay?.pixelWidth;
  const height = underlay?.pixelHeight;
  useEffect(() => {
    errorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    if (!source) return;
    try {
      const binary = window.atob(source.slice(source.indexOf(",") + 1));
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const dimensions = inspectUnderlayImage(
        bytes,
        source.startsWith("data:image/png;") ? "image/png" : "image/jpeg",
      );
      if (dimensions.width !== width || dimensions.height !== height) {
        throw new Error(
          "Размеры изображения не совпадают с данными проекта. Замените подложку исправным JPG или PNG.",
        );
      }
    } catch (error) {
      errorRef.current(error instanceof Error ? error.message : "Не удалось прочитать подложку.");
      return;
    }
    const image = new window.Image();
    image.onload = () => {
      if (image.naturalWidth !== width || image.naturalHeight !== height) {
        errorRef.current("Размеры подложки не совпадают с данными проекта. Загрузите изображение заново.");
        return;
      }
      setLoaded({ source, image });
    };
    image.onerror = () =>
      errorRef.current("Не удалось показать изображение подложки. Загрузите исправный JPG или PNG.");
    image.src = source;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [source, width, height]);
  return underlay?.visible &&
    loaded &&
    loaded.source === source &&
    loaded.image.naturalWidth === width &&
    loaded.image.naturalHeight === height
    ? loaded.image
    : null;
}
