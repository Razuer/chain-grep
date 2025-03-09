import * as vscode from "vscode";

export function toStat(content: string): vscode.FileStat {
    return {
        type: vscode.FileType.File,
        ctime: Date.now(),
        mtime: Date.now(),
        size: Buffer.byteLength(content, "utf8"),
    };
}

export function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isChainGrepUri(uri: string | vscode.Uri): boolean {
    return typeof uri === "string" ? uri.startsWith(`chaingrep:/`) : uri.scheme === "chaingrep";
}

export function getSelectedTextOrWord(editor: vscode.TextEditor): string | undefined {
    const selection = editor.selection;

    if (!selection.isEmpty) {
        return editor.document.getText(selection);
    }

    const wordRange = editor.document.getWordRangeAtPosition(selection.start);
    return wordRange ? editor.document.getText(wordRange) : undefined;
}

export function debounce<F extends (...args: any[]) => any>(
    func: F,
    waitFor: number
): (...args: Parameters<F>) => void {
    let timeout: NodeJS.Timeout | null = null;

    return function (...args: Parameters<F>): void {
        if (timeout !== null) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => func(...args), waitFor);
    };
}

export function buildChainPath(chain: any[]): string {
    if (!chain.length) {
        return "";
    }

    return chain
        .map((q) => {
            const prefix = q.type === "text" ? "T" : "R";
            const invertMark = q.inverted ? "!" : "";
            const caseMark = q.caseSensitive ? "C" : "";

            const shortQuery = q.query.length > 15 ? q.query.substring(0, 15) + "..." : q.query;

            return `${prefix}${invertMark}${caseMark}[${shortQuery}]`;
        })
        .join("->");
}

export function isRegexValid(str: string): boolean {
    if (/^\/.*\/[igm]*$/.test(str)) {
        return true;
    }

    let slashCount = 0;
    for (let i = 0; i < str.length; i++) {
        if (str[i] === "/") {
            slashCount++;
        } else if (slashCount === 1) {
            return false;
        }
    }

    return slashCount !== 1;
}
