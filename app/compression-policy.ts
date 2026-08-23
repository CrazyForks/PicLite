export type SmartCompressionMode = "balanced" | "small";

/**
 * The output-format selector is an explicit constraint. Smart optimisation may
 * explore quality and scale, but it must not silently turn "keep" into WebP.
 * Keeping this rule in a small pure helper also prevents platform-specific
 * encoders from drifting into different batch-export behaviour.
 */
export function smartCandidateOutputFormats<T extends string>(requestedFormat: T): T[] {
  return [requestedFormat];
}

export function isRequestedMimeType(actualType: string, requestedType: string) {
  const normalize = (value: string) => value.toLowerCase() === "image/jpg" ? "image/jpeg" : value.toLowerCase();
  return normalize(actualType) === normalize(requestedType);
}

/**
 * Lossy smart compression should save enough bytes to justify changing the
 * decoded image. Tiny, already-optimised assets otherwise lose visible detail
 * for only a few bytes of container overhead.
 */
export function minimumSmartSavingsBytes(originalBytes: number, mode: SmartCompressionMode) {
  const ratio = mode === "balanced" ? 0.05 : 0.02;
  const floor = mode === "balanced" ? 256 : 128;
  return Math.max(floor, Math.ceil(originalBytes * ratio));
}

export function isSmartCompressionWorthwhile(
  originalBytes: number,
  outputBytes: number,
  mode: SmartCompressionMode,
) {
  if (originalBytes <= 0 || outputBytes >= originalBytes) return false;
  return originalBytes - outputBytes >= minimumSmartSavingsBytes(originalBytes, mode);
}
