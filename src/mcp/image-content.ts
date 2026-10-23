const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_MCP_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_MCP_IMAGE_BUNDLE_BYTES = 6 * 1024 * 1024;

export type ImageToolCallResult = {
  structuredContent: Record<string, unknown>;
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' }>;
};

/** Build an MCP result with JSON metadata and, when allowed and bounded, a real PNG image block. */
export function imageToolCallResult(
  envelope: Record<string, unknown>,
  imageBytes: Uint8Array,
  options: { enabled?: boolean; maxBytes?: number } = {},
): ImageToolCallResult {
  const result = { ...envelope };
  const bytes = Buffer.from(imageBytes);
  const maxBytes = options.maxBytes ?? MAX_MCP_IMAGE_BYTES;
  const canAttach = options.enabled !== false && bytes.length <= maxBytes && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  if (!canAttach) {
    result.image_delivery = {
      status: 'artifact_only',
      code: options.enabled === false ? 'VISION_UNAVAILABLE' : bytes.length > maxBytes ? 'image_payload_too_large' : 'invalid_png',
      message: options.enabled === false
        ? 'MCP image delivery is disabled by desktop configuration; use the artifact reference and structural diagnostics.'
        : bytes.length > maxBytes
          ? 'PNG exceeds the MCP image payload limit; use the artifact reference and structural diagnostics.'
          : 'Screenshot bytes are not a valid PNG; no image content was returned.',
    };
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  result.image_delivery = { status: 'included_in_mcp_result', mime_type: 'image/png', bytes: bytes.length };
  return {
    structuredContent: result,
    content: [
      { type: 'text', text: JSON.stringify(result) },
      { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
    ],
  };
}

/** Attach an all-or-none ordered PNG bundle under the visual comparison budget. */
export function imageBundleToolCallResult(
  envelope: Record<string, unknown>,
  images: Array<{ name: string; bytes: Uint8Array }>,
  options: { enabled?: boolean; maxBytes?: number } = {},
): ImageToolCallResult {
  const result = { ...envelope };
  const bytes = images.map(image => Buffer.from(image.bytes));
  const total = bytes.reduce((sum, image) => sum + image.length, 0);
  const maxBytes = Math.min(options.maxBytes ?? MAX_MCP_IMAGE_BUNDLE_BYTES, MAX_MCP_IMAGE_BUNDLE_BYTES);
  const valid = images.length > 0 && bytes.every(image => image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE));
  const included = options.enabled !== false && total <= maxBytes && valid;
  result.image_delivery = included
    ? { status: 'included_in_mcp_result', mime_type: 'image/png', images: images.map((image, i) => ({ name: image.name, bytes: bytes[i]!.length })), total_bytes: total }
    : {
      status: 'artifact_only',
      code: options.enabled === false ? 'VISION_UNAVAILABLE' : total > maxBytes ? 'image_bundle_too_large' : 'invalid_png',
      message: options.enabled === false
        ? 'MCP image delivery is disabled by desktop configuration; use all artifact references.'
        : total > maxBytes
          ? 'The aggregate PNG bundle exceeds the MCP image payload limit; use all artifact references.'
          : 'One or more PNG artifacts are invalid; no image bundle was returned.',
    };
  return {
    structuredContent: result,
    content: [
      { type: 'text', text: JSON.stringify(result) },
      ...(included ? images.map((image, i) => ({ type: 'image' as const, data: bytes[i]!.toString('base64'), mimeType: 'image/png' as const })) : []),
    ],
  };
}
