import * as vscode from "vscode";

// Chain query type: text or regex search with options.
interface ChainGrepQuery {
    type: "text" | "regex";
    query: string;
    flags?: string;
    inverted: boolean;
    caseSensitive?: boolean; // false by default: case-insensitive search
}

// Chain info: list of queries and the source file URI.
interface ChainGrepChain {
    chain: ChainGrepQuery[];
    sourceUri: vscode.Uri;
}

// Map storing chain info per output document (key: document URI as string)
const chainGrepMap: Map<string, ChainGrepChain> = new Map();

/**
 * Displays a custom QuickPick popup that contains a text input and two toggle buttons.
 * The buttons act as toggles for "Invert" and "Case Sensitive".
 *
 * @param defaultQuery Optional string to prefill the query input.
 * @returns A promise that resolves to the entered query and selected options, or undefined if canceled.
 */
async function showQueryAndOptionsQuickInput(
    defaultQuery?: string
): Promise<{ query: string; options: string[] } | undefined> {
    const quickPick = vscode.window.createQuickPick();
    // Set a title that explains the toggle buttons.
    quickPick.title = "Toggle options: • Invert • Case Sensitive    -->";
    quickPick.placeholder = "Enter search query here...";
    quickPick.ignoreFocusOut = true;

    // Pre-fill with default query if provided.
    if (defaultQuery) {
        quickPick.value = defaultQuery;
    }

    // Option states.
    let invertSelected = false;
    let caseSensitiveSelected = false; // false by default means case-insensitive

    // Initialize buttons using ThemeIcons ("circle-outline" for off, "check" for on).
    quickPick.buttons = [
        {
            iconPath: new vscode.ThemeIcon("circle-outline"),
            tooltip: "Invert (Off)",
        },
        {
            iconPath: new vscode.ThemeIcon("circle-outline"),
            tooltip: "Case Sensitive (Off)",
        },
    ];

    // When a button is triggered, toggle its state and update the buttons array.
    quickPick.onDidTriggerButton((button: vscode.QuickInputButton) => {
        if (button.tooltip && button.tooltip.startsWith("Invert")) {
            invertSelected = !invertSelected;
        } else if (
            button.tooltip &&
            button.tooltip.startsWith("Case Sensitive")
        ) {
            caseSensitiveSelected = !caseSensitiveSelected;
        }
        // Reassign buttons with updated icons and tooltips.
        quickPick.buttons = [
            {
                iconPath: new vscode.ThemeIcon(
                    invertSelected ? "check" : "circle-outline"
                ),
                tooltip: `Invert (${invertSelected ? "On" : "Off"})`,
            },
            {
                iconPath: new vscode.ThemeIcon(
                    caseSensitiveSelected ? "check" : "circle-outline"
                ),
                tooltip: `Case Sensitive (${
                    caseSensitiveSelected ? "On" : "Off"
                })`,
            },
        ];
    });

    return new Promise((resolve) => {
        quickPick.onDidAccept(() => {
            const query = quickPick.value;
            const options: string[] = [];
            if (invertSelected) {
                options.push("Invert");
            }
            if (caseSensitiveSelected) {
                options.push("Case Sensitive");
            }
            quickPick.hide();
            resolve({ query, options });
        });
        quickPick.onDidHide(() => {
            resolve(undefined);
        });
        quickPick.show();
    });
}

export function activate(context: vscode.ExtensionContext) {
    // Command for text search.
    let findTextCommand = vscode.commands.registerTextEditorCommand(
        "chainGrep.findText",
        async (editor, edit) => {
            const input = await showQueryAndOptionsQuickInput();
            if (!input) {
                return;
            }
            const queryText = input.query;
            if (!queryText) {
                return;
            }
            const options = input.options;
            const inverted = options.includes("Invert");
            const caseSensitive = options.includes("Case Sensitive"); // default false → case-insensitive

            const { chain, sourceUri } = getChainForEditor(editor);
            const newQuery: ChainGrepQuery = {
                type: "text",
                query: queryText,
                inverted,
                caseSensitive,
            };
            const newChain = [...chain, newQuery];

            executeChainSearchAndDisplayResults(sourceUri, newChain);
        }
    );

    // Command for regex search.
    let findRegexCommand = vscode.commands.registerTextEditorCommand(
        "chainGrep.findRegex",
        async (editor, edit) => {
            const input = await showQueryAndOptionsQuickInput();
            if (!input) {
                return;
            }
            const regexInput = input.query;
            if (!regexInput) {
                return;
            }
            const options = input.options;
            const inverted = options.includes("Invert");
            const caseSensitive = options.includes("Case Sensitive");

            // Validate regex input.
            if (!isRegexValid(regexInput)) {
                vscode.window.showInformationMessage(
                    "Invalid regular expression input (illegal single slash)."
                );
                return;
            }

            let pattern: string;
            let flags: string = "";
            // If input is in /pattern/flags format, extract pattern and flags.
            if (regexInput.startsWith("/") && regexInput.lastIndexOf("/") > 0) {
                const lastSlash = regexInput.lastIndexOf("/");
                pattern = regexInput.substring(1, lastSlash);
                flags = regexInput.substring(lastSlash + 1);
            } else {
                pattern = regexInput;
            }
            pattern = pattern.replace(/\/\//g, "/");

            const { chain, sourceUri } = getChainForEditor(editor);
            const newQuery: ChainGrepQuery = {
                type: "regex",
                query: pattern,
                flags,
                inverted,
                caseSensitive,
            };
            const newChain = [...chain, newQuery];

            executeChainSearchAndDisplayResults(sourceUri, newChain);
        }
    );

    // New command for grepping the selected text.
    let grepSelectionCommand = vscode.commands.registerTextEditorCommand(
        "chainGrep.grepSelection",
        async (editor, edit) => {
            // Get the currently selected text.
            const selection = editor.selection;
            let selectedText = editor.document.getText(selection).trim();
            // If nothing is selected, use an empty string.
            if (!selectedText) {
                selectedText = "";
            }
            // Open the popup with the selected text prefilled.
            const input = await showQueryAndOptionsQuickInput(selectedText);
            if (!input) {
                return;
            }
            const queryText = input.query;
            if (!queryText) {
                return;
            }
            const options = input.options;
            const inverted = options.includes("Invert");
            const caseSensitive = options.includes("Case Sensitive");

            const { chain, sourceUri } = getChainForEditor(editor);
            const newQuery: ChainGrepQuery = {
                type: "text",
                query: queryText,
                inverted,
                caseSensitive,
            };
            const newChain = [...chain, newQuery];

            executeChainSearchAndDisplayResults(sourceUri, newChain);
        }
    );

    // Command for refresh.
    let refreshChainCommand = vscode.commands.registerTextEditorCommand(
        "chainGrep.refresh",
        async (editor, edit) => {
            const docUri = editor.document.uri.toString();
            if (!chainGrepMap.has(docUri)) {
                vscode.window.showInformationMessage(
                    "No chain grep found for this document."
                );
                return;
            }
            const chainInfo = chainGrepMap.get(docUri)!;
            executeChainSearchAndUpdateEditor(
                chainInfo.sourceUri,
                chainInfo.chain,
                editor
            );
        }
    );

    context.subscriptions.push(
        findTextCommand,
        findRegexCommand,
        grepSelectionCommand,
        refreshChainCommand
    );
}

export function deactivate() {}

// Retrieve existing chain for an editor or create a new one using the current document as source.
function getChainForEditor(editor: vscode.TextEditor): {
    chain: ChainGrepQuery[];
    sourceUri: vscode.Uri;
} {
    const docUri = editor.document.uri.toString();
    if (chainGrepMap.has(docUri)) {
        return chainGrepMap.get(docUri)!;
    } else {
        return { chain: [], sourceUri: editor.document.uri };
    }
}

// Apply a single query (text or regex) to an array of lines.
function applyChainQuery(lines: string[], query: ChainGrepQuery): string[] {
    if (query.type === "text") {
        return lines.filter((line) => {
            let match: boolean;
            // If caseSensitive is false (or undefined) then perform case-insensitive search.
            if (!query.caseSensitive) {
                match = line.toLowerCase().includes(query.query.toLowerCase());
            } else {
                match = line.includes(query.query);
            }
            return query.inverted ? !match : match;
        });
    } else {
        // For regex, add ignore-case flag if not caseSensitive.
        let regexFlags = query.flags || "";
        if (!query.caseSensitive && !regexFlags.includes("i")) {
            regexFlags += "i";
        }
        let regex: RegExp;
        try {
            regex = new RegExp(query.query, regexFlags);
        } catch (err) {
            vscode.window.showInformationMessage(
                "Invalid regular expression in chain."
            );
            return lines;
        }
        return lines.filter((line) =>
            query.inverted ? !regex.test(line) : regex.test(line)
        );
    }
}

// Perform sequential search: open source file and filter lines using the query chain.
async function executeChainSearch(
    sourceUri: vscode.Uri,
    chain: ChainGrepQuery[]
): Promise<string[]> {
    let sourceDoc: vscode.TextDocument;
    try {
        sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
    } catch (err) {
        vscode.window.showInformationMessage("Unable to open source document.");
        return [];
    }
    const allLines: string[] = [];
    for (let i = 0; i < sourceDoc.lineCount; i++) {
        allLines.push(sourceDoc.lineAt(i).text);
    }
    let filteredLines = allLines;
    for (const query of chain) {
        filteredLines = applyChainQuery(filteredLines, query);
    }
    return filteredLines;
}

// Build a concise summary of the chain for the file's first line (used as the tab title).
function buildChainSummary(chain: ChainGrepQuery[]): string {
    const parts = chain.map((query) => {
        let prefix = query.type === "text" ? "T:" : "R:";
        if (query.inverted) {
            prefix += "!";
        }
        if (query.caseSensitive) {
            prefix += "C"; // C means case sensitive
        }
        let queryStr = `'${query.query}'`;
        if (query.type === "regex" && query.flags) {
            queryStr += ` (${query.flags})`;
        }
        return `${prefix}${queryStr}`;
    });
    return "Chain Grep: " + parts.join(" -> ");
}

// Build a detailed header with all chain steps.
function buildChainDetailedHeader(chain: ChainGrepQuery[]): string {
    let headerLines: string[] = [];
    headerLines.push("--- Chain Grep Steps ---");
    chain.forEach((query, index) => {
        let step = `${index + 1}. `;
        if (query.type === "text") {
            step += `[Text] Search for: "${query.query}"`;
        } else {
            step += `[Regex] Search for: "${query.query}"`;
            if (query.flags) {
                step += ` with flags: "${query.flags}"`;
            }
        }
        if (query.inverted) {
            step += " (Inverted)";
        }
        if (query.caseSensitive) {
            step += " (Case Sensitive)";
        } else {
            step += " (Case Insensitive)";
        }
        headerLines.push(step);
    });
    headerLines.push("-------------------------");
    return headerLines.join("\n");
}

// Run the search chain, open a new document, and display results with headers.
// The first line (summary) is used as the tab title.
async function executeChainSearchAndDisplayResults(
    sourceUri: vscode.Uri,
    chain: ChainGrepQuery[]
) {
    const results = await executeChainSearch(sourceUri, chain);
    if (results.length === 0) {
        vscode.window.showInformationMessage("No matches found.");
        return;
    }
    const summary = buildChainSummary(chain);
    const detailedHeader = buildChainDetailedHeader(chain);
    const content =
        summary + "\n" + detailedHeader + "\n\n" + results.join("\n");

    await vscode.commands.executeCommand(
        "workbench.action.files.newUntitledFile"
    );
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        await editor.edit((editBuilder) => {
            editBuilder.insert(new vscode.Position(0, 0), content);
        });
        chainGrepMap.set(editor.document.uri.toString(), { chain, sourceUri });
    }
}

// Run the search chain and update the current document (refresh) with headers.
async function executeChainSearchAndUpdateEditor(
    sourceUri: vscode.Uri,
    chain: ChainGrepQuery[],
    editor: vscode.TextEditor
) {
    const results = await executeChainSearch(sourceUri, chain);
    if (results.length === 0) {
        vscode.window.showInformationMessage("No matches found after refresh.");
        return;
    }
    const summary = buildChainSummary(chain);
    const detailedHeader = buildChainDetailedHeader(chain);
    const content =
        summary + "\n" + detailedHeader + "\n\n" + results.join("\n");
    const fullRange = new vscode.Range(
        editor.document.positionAt(0),
        editor.document.positionAt(editor.document.getText().length)
    );
    await editor.edit((editBuilder) => {
        editBuilder.replace(fullRange, content);
    });
}

// Validate regex input: detect illegal single slash.
function isRegexValid(str: string): boolean {
    if (/^\/.*\/?[igm]{0,3}$/.test(str)) {
        return true;
    }
    let slashCount = 0;
    for (let i = 0; i < str.length; i++) {
        if (str.charAt(i) === "/") {
            ++slashCount;
        } else {
            if (slashCount === 1) {
                return false;
            }
            slashCount = 0;
        }
    }
    return slashCount !== 1;
}
