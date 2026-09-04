export type OperationFeedbackTone = "success" | "error";

export async function copyImageWithFeedback(
  copyImagePath: (path: string) => Promise<void>,
  output: string | undefined,
  language: "zh" | "en",
  notify: (text: string, tone?: OperationFeedbackTone) => void,
) {
  if (!output) return false;
  try {
    await copyImagePath(output);
    notify(language === "en" ? "Copied successfully" : "复制成功");
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    notify(language === "en" ? `Copy failed: ${detail}` : `复制失败：${detail}`, "error");
    return false;
  }
}
