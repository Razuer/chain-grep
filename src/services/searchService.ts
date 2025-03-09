import * as vscode from "vscode";
import * as path from "path";
import { ChainGrepQuery } from "../models/interfaces";
import { buildChainPath } from "../utils/utils";
import { getMaxBaseNameLength, getMaxChainDescriptorLength } from "./configService";

export async function validateChain(queries: ChainGrepQuery[]): Promise<string[]> {
    const errors: string[] = [];
    queries.forEach((q, index) => {
        if (q.type === "regex") {
            let flags = q.flags || "";
            if (!flags.includes("s")) {
                flags += "s";
                q.flags = flags;
            }
            try {
                new RegExp(q.query, flags);
            } catch {
                errors.push(`Step ${index + 1}: Invalid regex '${q.query}' with flags '${flags}'`);
            }
        }
    });
    return errors;
}

export function applyChainQuery(lines: string[], query: ChainGrepQuery): string[] {
    if (query.type === "text") {
        return lines.filter((line) => {
            const textLine = query.caseSensitive ? line : line.toLowerCase();
            const textQuery = query.caseSensitive ? query.query : query.query.toLowerCase();
            const match = textLine.includes(textQuery);
            return query.inverted ? !match : match;
        });
    } else {
        let flags = query.flags || "";
        if (!query.caseSensitive && !flags.includes("i")) {
            flags += "i";
        }
        let regex: RegExp;
        try {
            regex = new RegExp(query.query, flags);
        } catch {
            vscode.window.showInformationMessage("Invalid regular expression in chain.");
            return lines;
        }
        return lines.filter((line) => (query.inverted ? !regex.test(line) : regex.test(line)));
    }
}

export async function executeChainSearch(
    sourceUri: vscode.Uri,
    chain: ChainGrepQuery[]
): Promise<{ lines: string[]; stats: any }> {
    const validationErrors = await validateChain(chain);
    if (validationErrors.length) {
        vscode.window.showInformationMessage("Validation errors found: " + validationErrors.join("; "));
        return { lines: [], stats: {} };
    }

    let sourceDoc: vscode.TextDocument;
    try {
        sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
    } catch {
        vscode.window.showInformationMessage("Unable to open source document.");
        return { lines: [], stats: {} };
    }

    const lines: string[] = [];
    for (let i = 0; i < sourceDoc.lineCount; i++) {
        lines.push(sourceDoc.lineAt(i).text);
    }

    let filtered = lines;
    const stats = {
        totalLines: lines.length,
        steps: [] as { step: number; query: string; matchCount: number }[],
    };

    for (let i = 0; i < chain.length; i++) {
        const query = chain[i];
        const before = filtered.length;
        filtered = applyChainQuery(filtered, query);
        stats.steps.push({
            step: i + 1,
            query: query.query,
            matchCount: filtered.length,
        });
    }

    return { lines: filtered, stats };
}

export function buildChainDetailedHeader(chain: ChainGrepQuery[], stats?: any): string {
    const lines: string[] = ["--- Chain Grep Steps ---"];
    chain.forEach((q, i) => {
        let step = `${i + 1}. `;
        if (q.type === "text") {
            step += `[Text] Search for: "${q.query}"`;
        } else {
            step += `[Regex] Search for: "${q.query}"`;
            if (q.flags) {
                step += ` with flags: "${q.flags}"`;
            }
        }
        if (q.inverted) {
            step += " (Inverted)";
        }
        step += q.caseSensitive ? " (Case Sensitive)" : " (Case Insensitive)";

        if (stats && stats.steps && stats.steps[i]) {
            step += ` → ${stats.steps[i].matchCount} matches`;
        }

        lines.push(step);
    });

    if (stats) {
        const finalCount = stats.steps.length > 0 ? stats.steps[stats.steps.length - 1].matchCount : 0;
        lines.push(
            `--- Results: ${finalCount} matches (${((finalCount / stats.totalLines) * 100).toFixed(1)}% of source) ---`
        );
    } else {
        lines.push("-------------------------");
    }

    return lines.join("\n");
}

export function generateChainGrepDocUri(sourceUri: vscode.Uri, chain: ChainGrepQuery[]): vscode.Uri {
    const sourceFilename = path.basename(sourceUri.fsPath);
    const extension = path.extname(sourceFilename);
    const baseName = path.basename(sourceFilename, extension);

    const chainDescriptor = buildChainPath(chain);

    const maxBaseNameLength = getMaxBaseNameLength();
    const maxChainDescriptorLength = getMaxChainDescriptorLength();

    const truncatedBaseName =
        maxBaseNameLength > 0 && baseName.length > maxBaseNameLength
            ? "..." + baseName.slice(baseName.length - maxBaseNameLength)
            : baseName;

    const truncatedChainDescriptor =
        maxChainDescriptorLength > 0 && chainDescriptor.length > maxChainDescriptorLength
            ? "..." + chainDescriptor.slice(chainDescriptor.length - maxChainDescriptorLength)
            : chainDescriptor;

    let docName = `[${truncatedBaseName}] : ${truncatedChainDescriptor}${extension}`;

    let safePath = docName.replace(/\\/g, "/");
    if (!safePath.startsWith("/")) {
        safePath = "/" + safePath;
    }

    return vscode.Uri.from({
        scheme: "chaingrep",
        path: safePath,
    });
}
