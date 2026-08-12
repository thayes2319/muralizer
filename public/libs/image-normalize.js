// ============================================================
// Image normalization pipeline
//
// Android cameras/galleries hand us files that lie about what they are:
// HEIC saved with a .jpg name, HEIF mislabeled as image/jpeg, Ultra HDR
// gain-map JPEGs, Motion Photo JPEGs with an MP4 appended after the JPEG
// EOI marker, RAW/DNG shared via a generic picker, etc. Trusting
// file.type or the filename extension has repeatedly let bad files reach
// the decode step and fail there with a confusing error.
//
// This module treats every incoming file as opaque binary, sniffs the
// real format from its magic bytes, decodes it with whatever means that
// format needs (native browser decode, or a lazy-loaded HEIC/HEIF
// decoder), then re-renders the result onto a canvas. That canvas step is
// what actually normalizes things: it strips EXIF/ICC/HDR metadata,
// bakes in EXIF orientation, forces 8-bit sRGB, and re-encodes to a
// single canonical JPEG within safe dimension/size limits. Everything
// downstream in the app only ever has to deal with that one predictable
// shape.
//
// Exposes: window.normalizeImageFile(file, options) -> Promise<{
//   blob, dataUrl, width, height, format, sourceType, sourceName, sourceSize
// }>
// and window.ImageNormalizeError (Error subclass with a `.code`).
//
// heic2any (libs/heic2any.min.js, MIT licensed, vendored from npm) is
// loaded on demand -- only HEIC/HEIF files pay for that ~1.3 MB decoder.
// ============================================================

(function (global) {
  "use strict";

  class ImageNormalizeError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ImageNormalizeError";
      this.code = code;
    }
  }

  const MAX_INPUT_BYTES = 60 * 1024 * 1024;

  function bytesToAscii(bytes, offset, length) {
    let out = "";
    for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] || 0);
    return out;
  }

  // Identifies the real container format from magic bytes alone, ignoring
  // whatever file.type/extension claimed. Distinguishes the two cases that
  // actually need special handling (HEIC needs a decoder browsers don't
  // ship; TIFF-based RAW/DNG we can't decode at all) from everything else,
  // which Chromium's native image decoder already handles -- including
  // Motion Photo JPEGs (valid JPEG with an MP4 appended after EOI, decoders
  // just stop at the JPEG) and Ultra HDR gain-map JPEGs (valid baseline
  // JPEG with an extra embedded image decoders ignore).
  function sniffImageFormat(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
    if (bytes.length >= 12 && bytesToAscii(bytes, 0, 4) === "RIFF" && bytesToAscii(bytes, 8, 4) === "WEBP") return "webp";
    if (bytes.length >= 6 && (bytesToAscii(bytes, 0, 6) === "GIF87a" || bytesToAscii(bytes, 0, 6) === "GIF89a")) return "gif";
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
    if (
      bytes.length >= 4 &&
      ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
        (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
    ) {
      return "tiff"; // covers TIFF and virtually all RAW/DNG variants (DNG is TIFF-based)
    }
    if (bytes.length >= 12 && bytesToAscii(bytes, 4, 4) === "ftyp") {
      const brand = bytesToAscii(bytes, 8, 4).toLowerCase().trim();
      const heicBrands = ["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"];
      const avifBrands = ["avif", "avis"];
      if (heicBrands.indexOf(brand) !== -1) return "heic";
      if (avifBrands.indexOf(brand) !== -1) return "avif";
      return "heic"; // unrecognized ftyp brand: most likely an HEIF variant we haven't listed -- try the HEIC path
    }
    return "unknown";
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new ImageNormalizeError("read-failed", "This file could not be read. Try a different photo."));
      reader.readAsDataURL(blob);
    });
  }

  let heic2anyLoadPromise = null;
  function loadHeic2Any() {
    if (global.heic2any) return Promise.resolve(global.heic2any);
    if (heic2anyLoadPromise) return heic2anyLoadPromise;
    heic2anyLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "libs/heic2any.min.js";
      script.onload = () => {
        if (global.heic2any) resolve(global.heic2any);
        else reject(new Error("heic2any did not attach to window"));
      };
      script.onerror = () => reject(new Error("Could not load the HEIC decoder script."));
      document.head.appendChild(script);
    }).catch((error) => {
      heic2anyLoadPromise = null; // allow a retry on a later upload instead of caching the failure forever
      throw error;
    });
    return heic2anyLoadPromise;
  }

  async function decodeHeicToJpegBlob(blob, quality) {
    let heic2any;
    try {
      heic2any = await loadHeic2Any();
    } catch (error) {
      console.error("HEIC decoder failed to load:", error);
      throw new ImageNormalizeError(
        "heic-decoder-unavailable",
        "The HEIC photo decoder could not be loaded. Check your connection and try again, or switch your camera's format to JPEG in Settings."
      );
    }
    try {
      const result = await heic2any({ blob, toType: "image/jpeg", quality: quality || 0.92 });
      return Array.isArray(result) ? result[0] : result;
    } catch (error) {
      console.error("HEIC decode failed:", error);
      throw new ImageNormalizeError(
        "heic-decode-failed",
        "This HEIC photo could not be converted. Try switching your camera's format to “Most Compatible” (JPEG) in Settings, then retake or reshare the photo."
      );
    }
  }

  // Prefers createImageBitmap: it decodes the Blob's bytes directly with no
  // blob: URL involved, and imageOrientation:"from-image" bakes in EXIF
  // rotation deterministically. Falls back to FileReader->dataURL->Image,
  // the path already proven to work around content-provider-backed Files
  // failing to resolve through URL.createObjectURL in the Android WebView
  // (see handleReferenceReimagineFile's history) -- that fallback is safe
  // here because by this point `blob` is always an in-memory Blob we built
  // ourselves from arrayBuffer, never the original content:// File.
  async function decodeToBitmap(blob) {
    if (global.createImageBitmap) {
      try {
        return await global.createImageBitmap(blob, { imageOrientation: "from-image" });
      } catch (error) {
        console.warn("createImageBitmap failed, falling back to Image element:", error);
      }
    }
    const dataUrl = await blobToDataUrl(blob);
    return new Promise((resolve, reject) => {
      const image = new Image();
      const timeout = setTimeout(() => reject(new Error("Image decode timed out.")), 15000);
      image.onload = () => {
        clearTimeout(timeout);
        resolve(image);
      };
      image.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Image element could not decode file."));
      };
      image.src = dataUrl;
    });
  }

  function drawToCanvas(bitmap, maxDimension) {
    const sourceWidth = bitmap.width || bitmap.naturalWidth;
    const sourceHeight = bitmap.height || bitmap.naturalHeight;
    if (!sourceWidth || !sourceHeight) throw new ImageNormalizeError("decode-failed", "This image appears to be empty or corrupted.");
    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    if (typeof bitmap.close === "function") bitmap.close();
    return { canvas, width, height };
  }

  async function canvasToBlobWithSizeLimit(canvas, mimeType, quality, maxBytes) {
    let currentQuality = quality;
    for (let attempt = 0; attempt < 5; attempt++) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, mimeType, currentQuality));
      if (!blob) throw new ImageNormalizeError("encode-failed", "This image could not be prepared. Try a different photo.");
      if (blob.size <= maxBytes || currentQuality <= 0.5) return blob;
      currentQuality -= 0.15;
    }
    throw new ImageNormalizeError("encode-failed", "This image could not be compressed enough to upload. Try a smaller photo.");
  }

  // Normalizes any incoming image File/Blob into a single canonical,
  // metadata-stripped JPEG (or PNG if requested) within safe dimension and
  // byte-size limits. Rejects early -- with a specific, actionable message
  // -- for formats that genuinely can't be handled client-side (RAW/DNG).
  async function normalizeImageFile(file, options) {
    const opts = Object.assign(
      { maxDimension: 2560, quality: 0.9, maxOutputBytes: 6 * 1024 * 1024, outputType: "image/jpeg" },
      options
    );
    if (!file) throw new ImageNormalizeError("no-file", "No file was provided.");
    if (file.size > MAX_INPUT_BYTES) {
      throw new ImageNormalizeError(
        "too-large",
        `This file is larger than ${Math.round(MAX_INPUT_BYTES / (1024 * 1024))} MB and can't be processed. Choose a smaller photo.`
      );
    }

    let arrayBuffer;
    try {
      arrayBuffer = await file.arrayBuffer();
    } catch (error) {
      // Android content:// URIs from the file/photo picker carry a
      // temporary read grant that can expire (e.g. the picker's originating
      // Activity lifecycle ended, or the app was backgrounded/closed long
      // enough) -- reading then throws a native NotReadableError whose raw
      // message ("...permission problems that have occurred after a
      // reference to a file was acquired") is meaningless to a user and
      // impossible for this app to prevent client-side. This is the very
      // first read of the file, done immediately on selection, so there's
      // no delay on our end contributing to it. Re-selecting the file gets
      // a fresh grant, so point there instead of showing the raw browser text.
      console.error("File handle unreadable (likely an expired platform read grant):", { name: file.name, type: file.type || "(empty)", size: file.size, error });
      throw new ImageNormalizeError(
        "stale-file-handle",
        "This file couldn't be read -- its access may have expired. Please choose the photo again from your gallery."
      );
    }
    const header = new Uint8Array(arrayBuffer.slice(0, 32));
    const format = sniffImageFormat(header);

    if (format === "tiff") {
      throw new ImageNormalizeError(
        "unsupported-raw",
        "This looks like a RAW or TIFF camera file, which isn't supported here. Please export or share it as a JPEG or HEIC photo instead."
      );
    }
    if (format === "unknown") {
      throw new ImageNormalizeError(
        "unrecognized-format",
        "This file doesn't look like a photo this app can read. Try a JPEG, PNG, WebP, or HEIC image."
      );
    }

    let workingBlob = new Blob([arrayBuffer], { type: file.type || "application/octet-stream" });
    if (format === "heic") {
      workingBlob = await decodeHeicToJpegBlob(workingBlob, opts.quality);
    }

    let bitmap;
    try {
      bitmap = await decodeToBitmap(workingBlob);
    } catch (error) {
      console.error("Image decode failed:", { name: file.name, type: file.type || "(empty)", size: file.size, sniffedFormat: format, error });
      throw new ImageNormalizeError(
        "decode-failed",
        `This image could not be opened (detected as ${format}). Try a JPEG, PNG, WebP, or HEIC photo.`
      );
    }

    const { canvas, width, height } = drawToCanvas(bitmap, opts.maxDimension);
    const blob = await canvasToBlobWithSizeLimit(canvas, opts.outputType, opts.quality, opts.maxOutputBytes);
    const dataUrl = await blobToDataUrl(blob);

    return {
      blob,
      dataUrl,
      width,
      height,
      format,
      sourceType: file.type || "",
      sourceName: file.name || "",
      sourceSize: file.size
    };
  }

  global.normalizeImageFile = normalizeImageFile;
  global.ImageNormalizeError = ImageNormalizeError;
})(window);
