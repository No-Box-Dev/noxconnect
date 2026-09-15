// Shared helpers for the Spec attachments feature.

export interface SpecAttachmentRow {
  id: number;
  org_id: number;
  project_id: string;
  spec_id: number;
  filename: string;
  content_type: string;
  size: number;
  r2_key: string;
  uploaded_by: string;
  uploaded_at: string;
}

export interface SpecAttachmentDto {
  id: number;
  projectId: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
  /** Sniffed from the filename extension so the client can pick a viewer
   * without re-parsing the filename. */
  kind: SpecAttachmentKind;
}

export type SpecAttachmentKind = "markdown" | "pdf" | "docx" | "html" | "other";

// Whitelist — matches the extension against the allowed set. Kept explicit
// rather than a content-type check because docx / pdf mime detection is
// notoriously unreliable across upload paths.
export const ATTACHMENT_EXTENSIONS = [".md", ".pdf", ".docx", ".html"] as const;

export function kindFromFilename(filename: string): SpecAttachmentKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".html")) return "html";
  return "other";
}

// The user-supplied filename is stored + echoed back on GET, so sanitize
// hard: strip path segments, cap length, refuse anything without one of
// the allowed extensions. Preserves case for display but the extension
// check itself is case-insensitive.
export function sanitizeFilename(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Drop any path prefix — filenames from browsers can carry backslashes
  // on Windows, forward slashes on Unix.
  const base = trimmed.split(/[/\\]/).pop() ?? "";
  if (!base) return null;
  if (base.length > 200) return null;
  const lower = base.toLowerCase();
  if (!ATTACHMENT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return null;
  // Reject anything with a null byte or control chars — most storage
  // layers tolerate them but R2 keys should be printable.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(base)) return null;
  return base;
}

export function contentTypeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx"))
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

export function rowToDto(row: SpecAttachmentRow): SpecAttachmentDto {
  return {
    id: row.id,
    projectId: row.project_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    kind: kindFromFilename(row.filename),
  };
}

/** Deterministic R2 key so tenants can't accidentally read each other. */
export function buildR2Key(orgId: number, specId: number, attachmentId: number): string {
  return `spec/${orgId}/${specId}/${attachmentId}`;
}

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const MAX_ATTACHMENTS_PER_SPEC = 20;
