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
    if (typeof uri === "string") {
        return uri.startsWith(`chaingrep:/`);
    } else {
        return uri.scheme === "chaingrep";
    }
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
    return chain
        .map((q) => {
            const prefix = q.type === "text" ? "T" : "R";
            const invertMark = q.inverted ? "!" : "";
            const caseMark = q.caseSensitive ? "C" : "";
            let shortQuery = q.query;
            if (shortQuery.length > 15) {
                shortQuery = shortQuery.substring(0, 15) + "...";
            }
            return `${prefix}${invertMark}${caseMark}[${shortQuery}]`;
        })
        .join("->");
}

export function isRegexValid(str: string): boolean {
    if (/^\/.*\/?[igm]{0,3}$/.test(str)) {
        return true;
    }
    let slashCount = 0;
    for (let i = 0; i < str.length; i++) {
        if (str.charAt(i) === "/") {
            slashCount++;
        } else {
            if (slashCount === 1) {
                return false;
            }
            slashCount = 0;
        }
    }
    return slashCount !== 1;
}
