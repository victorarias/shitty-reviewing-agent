export interface CommandInvocation {
  command: string;
  args: string;
  argv: string[];
  mention?: string;
}

export function parseCommandInvocation(body: string): CommandInvocation | null {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("!")) {
      const match = trimmed.match(/^!(\S+)(?:\s+(.*))?$/);
      if (!match) continue;
      const command = match[1];
      const args = (match[2] ?? "").trim();
      return { command, args, argv: splitArgs(args) };
    }
    if (trimmed.startsWith("@")) {
      const match = trimmed.match(/^@(\S+)\s+(\S+)(?:\s+(.*))?$/);
      if (!match) continue;
      const mention = match[1];
      const command = match[2];
      const args = (match[3] ?? "").trim();
      return { command, args, argv: splitArgs(args), mention };
    }
  }
  return null;
}

export function splitArgs(input: string): string[] {
  if (!input) return [];
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === "\\" && i + 1 < input.length) {
        i += 1;
        current += input[i];
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "\\" && i + 1 < input.length) {
      i += 1;
      current += input[i];
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    args.push(current);
  }
  return args;
}
