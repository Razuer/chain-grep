import * as vscode from "vscode";
import * as path from "path";
import { ChainGrepQuery } from "../models/interfaces";
import { buildChainPath } from "../utils/utils";
import { getMaxBaseNameLength, getMaxChainDescriptorLength } from "./configService";

export async function validateChain(queries: ChainGrepQuery[]): Promise<string[]> {
    const errors: string[] = [];
    for (let index = 0; index < queries.length; index++) {
        const q = queries[index];
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
    }
    return errors;
}

export function applyChainQuery(lines: string[], query: ChainGrepQuery): string[] {
    if (query.type === "text") {
        const isInverted = query.inverted;
        if (query.caseSensitive) {
            const textQuery = query.query;
            return lines.filter((line) => {
                const match = line.includes(textQuery);
                return isInverted ? !match : match;
            });
        } else {
            const textQuery = query.query.toLowerCase();
            return lines.filter((line) => {
                const match = line.toLowerCase().includes(textQuery);
                return isInverted ? !match : match;
            });
        }
    } else {
        let flags = query.flags || "";
        if (!query.caseSensitive && !flags.includes("i")) {
            flags += "i";
        }

        try {
            const regex = new RegExp(query.query, flags);
            const isInverted = query.inverted;
            return lines.filter((line) => isInverted !== regex.test(line));
        } catch {
            vscode.window.showInformationMessage("Invalid regular expression in chain.");
            return lines;
        }
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

    const lines: string[] = Array(sourceDoc.lineCount);
    for (let i = 0; i < sourceDoc.lineCount; i++) {
        lines[i] = sourceDoc.lineAt(i).text;
    }

    let filtered = lines;
    const stats = {
        totalLines: lines.length,
        steps: [] as { step: number; query: string; matchCount: number }[],
    };

    for (let i = 0; i < chain.length; i++) {
        const query = chain[i];
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

    for (let i = 0; i < chain.length; i++) {
        const q = chain[i];
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

        if (stats?.steps?.[i]) {
            step += ` → ${stats.steps[i].matchCount} matches`;
        }

        lines.push(step);
    }

    if (stats?.steps?.length > 0) {
        const finalCount = stats.steps[stats.steps.length - 1].matchCount;
        const percentage = ((finalCount / stats.totalLines) * 100).toFixed(1);
        lines.push(`--- Results: ${finalCount} matches (${percentage}% of source) ---`);
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
            ? "..." + baseName.slice(-maxBaseNameLength)
            : baseName;

    const truncatedChainDescriptor =
        maxChainDescriptorLength > 0 && chainDescriptor.length > maxChainDescriptorLength
            ? "..." + chainDescriptor.slice(-maxChainDescriptorLength)
            : chainDescriptor;

    const docName = `[${truncatedBaseName}] : ${truncatedChainDescriptor}${extension}`;

    const docUri = vscode.Uri.joinPath(sourceUri, "..", docName).with({ scheme: "chaingrep" });

    return docUri;
}
