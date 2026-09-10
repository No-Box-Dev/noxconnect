export const DEFAULT_NOXSPOT_BLOCKS = [
  { id: "default-title", type: "title", required: true },
  { id: "default-description", type: "description", required: false },
  { id: "default-reporter", type: "reporter", required: true },
  { id: "default-contact-email", type: "contact_email", required: false },
  { id: "default-element-picker", type: "element_picker", required: false },
  { id: "default-metadata", type: "metadata", required: false },
  { id: "default-console-logs", type: "console_logs", required: false },
] as const;
