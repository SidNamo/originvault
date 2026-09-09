const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "jpe", "jfif", "pjpeg", "png", "apng", "gif", "webp", "avif",
  "bmp", "dib", "ico", "cur", "svg", "tif", "tiff",
  "heic", "heics", "heif", "heifs", "hif", "jxl",
  "jp2", "j2c", "j2k", "jpc", "jpf", "jpm", "jpx", "jpt",
  "psd", "psb", "xcf", "exr", "hdr", "rgbe", "tga", "icb", "vda", "vst",
  "dds", "qoi", "dcm", "pnm", "pbm", "pgm", "ppm", "pam", "pcx", "dcx",
  "fits", "fts", "mpo", "jps", "3fr", "arw", "cr2", "cr3", "crw", "dcr",
  "dng", "erf", "fff", "iiq", "k25", "kdc", "mdc", "mef", "mos", "mrw",
  "nef", "nrw", "orf", "pef", "raf", "raw", "rw2", "rwl", "sr2", "srf",
  "srw", "sti", "x3f",
]);

export function isImageFile(name: string, mimeType?: string | null): boolean {
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (extension === "svgz") return false;
  const mime = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mime.startsWith("image/") || mime === "application/dicom") return true;
  return IMAGE_EXTENSIONS.has(extension);
}
