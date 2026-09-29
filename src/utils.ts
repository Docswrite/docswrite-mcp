/**
 * Parse `--key=value`, `--key value` and bare `--flag` arguments.
 * A bare flag (no value, or followed by another `--option`) is stored as "true".
 */
export function parseArgs(argv: string[] = process.argv.slice(2)): Record<string, string> {
    const options: Record<string, string> = {};

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('-')) continue;

        const stripped = arg.replace(/^--?/, '');
        const eq = stripped.indexOf('=');
        if (eq !== -1) {
            const key = stripped.slice(0, eq);
            if (key) options[key] = stripped.slice(eq + 1);
            continue;
        }

        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
            options[stripped] = next;
            i++;
        } else {
            options[stripped] = 'true';
        }
    }

    return options;
}

export interface ContentResponse {
    [key: string]: unknown;
    type: "text";
    text: string;
}

export interface ToolResult {
    [key: string]: unknown;
    content: ContentResponse[];
    isError?: boolean;
}

export function textResult(text: string, isError = false): ToolResult {
    return isError
        ? { content: [{ type: "text", text }], isError: true }
        : { content: [{ type: "text", text }] };
}
