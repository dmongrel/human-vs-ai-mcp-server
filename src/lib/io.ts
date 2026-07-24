import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface TextSourceInput {
  text?: string;
  filePath?: string;
}

export async function resolveInputText(input: TextSourceInput): Promise<string> {
  if (input.filePath) {
    const resolved = resolve(input.filePath);
    return readFile(resolved, "utf8");
  }
  if (input.text !== undefined) {
    return input.text;
  }
  throw new Error("Either 'text' or 'filePath' must be provided.");
}

export async function deliverOutput(content: string, reportPath?: string): Promise<string> {
  if (!reportPath) {
    return content;
  }
  const resolved = resolve(reportPath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, "utf8");
  return `Report written to ${resolved}`;
}
