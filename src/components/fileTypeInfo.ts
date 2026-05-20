/**
 * fileTypeInfo.ts
 * Returns Material icon name + label + brand colour for any MIME type / extension.
 * No emoji — icon names are from Material Symbols Rounded.
 */

export interface FileTypeInfo {
  icon: string;
  label: string;
  color: string;
}

export function getFileTypeInfo(mimeType: string, fileName?: string): FileTypeInfo {
  const ext = fileName?.split(".").pop()?.toLowerCase() ?? "";

  if (mimeType.startsWith("image/"))
    return { icon: "image", label: (mimeType.split("/")[1] || "IMG").toUpperCase(), color: "#4CAF50" };

  if (mimeType.startsWith("video/"))
    return { icon: "videocam", label: "VIDEO", color: "#E53935" };

  if (mimeType.startsWith("audio/"))
    return { icon: "audio_file", label: "AUDIO", color: "#8E24AA" };

  if (mimeType === "application/pdf")
    return { icon: "picture_as_pdf", label: "PDF", color: "#F4511E" };

  if (
    ["zip", "tar", "gz", "7z", "rar", "bz2", "xz"].includes(ext) ||
    mimeType.includes("zip") ||
    mimeType.includes("tar")
  )
    return { icon: "folder_zip", label: ext.toUpperCase() || "ZIP", color: "#FB8C00" };

  if (["doc", "docx"].includes(ext))
    return { icon: "description", label: "DOCX", color: "#1E88E5" };

  if (["xls", "xlsx"].includes(ext))
    return { icon: "table_chart", label: "XLSX", color: "#43A047" };

  if (["ppt", "pptx"].includes(ext))
    return { icon: "slideshow", label: "PPTX", color: "#FB8C00" };

  if (ext === "ipynb")
    return { icon: "science", label: "IPYNB", color: "#FB8C00" };

  if (ext === "json")
    return { icon: "data_object", label: "JSON", color: "#FB8C00" };

  if (ext === "csv")
    return { icon: "table_chart", label: "CSV", color: "#43A047" };

  if (ext === "md")
    return { icon: "article", label: "MD", color: "#546E7A" };

  const CODE_EXTS = [
    "py","js","ts","jsx","tsx","rs","go","java","cpp","c","h",
    "rb","php","swift","kt","sh","bash","sql","graphql","vue","svelte","yaml","yml","toml",
  ];
  if (CODE_EXTS.includes(ext))
    return { icon: "code", label: ext.toUpperCase(), color: "#1E88E5" };

  if (mimeType.startsWith("text/"))
    return { icon: "article", label: "TXT", color: "#78909C" };

  return { icon: "attach_file", label: ext.toUpperCase() || "FILE", color: "#78909C" };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
