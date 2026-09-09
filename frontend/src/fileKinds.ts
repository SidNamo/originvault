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
const VIDEO_EXTENSIONS = new Set([
  "mp4", "m4v", "mov", "qt", "3gp", "3g2", "f4v", "mkv", "webm",
  "avi", "divx", "wmv", "asf", "flv", "m2ts", "mpg", "mpeg", "mpe",
  "m2v", "vob", "ogv", "rm", "rmvb", "mxf", "nut", "dv",
]);

function fileExtension(name: string): string {
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

export function isImageFile(name: string, mimeType?: string | null): boolean {
  const extension = fileExtension(name);
  if (extension === "svgz") return false;
  const mime = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mime.startsWith("image/") || mime === "application/dicom") return true;
  return IMAGE_EXTENSIONS.has(extension);
}

export function isVideoFile(name: string, mimeType?: string | null): boolean {
  const extension = fileExtension(name);
  const mime = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if ((extension === "ts" || extension === "mts") && mime !== "video/mp2t") return false;
  return mime.startsWith("video/") || VIDEO_EXTENSIONS.has(extension);
}
