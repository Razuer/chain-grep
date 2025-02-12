import * as vscode from "vscode";

// --------------------- Chain Grep Types ---------------------------
interface ChainGrepQuery {
    type: "text" | "regex";
    query: string;
    flags?: string;
    inverted: boolean;
    caseSensitive?: boolean; // false by default: case-insensitive search
}

interface ChainGrepChain {
    chain: ChainGrepQuery[];
    sourceUri: vscode.Uri;
}

const chainGrepMap: Map<string, ChainGrepChain> = new Map();

// --------------------- Highlight Globals --------------------------
// Increased number of pastel colors, more variety.
const DEFAULT_COLOURS =
    "#89CFF0:black, #FF6961:black, #77DD77:black, #C3A8FF:black, #FDFD96:black, #A0E7E5:black, #FFB7CE:black, #CCFF90:black, #B19CD9:black, #FF82A9:black, #A8BFFF:black, #FFDAB9:black, #A8D0FF:black, #FFE680:black, #A8E0FF:black, #FFCBA4:black, #E6A8D7:black, #FFCCD2:black, #ACE1AF:black, #FF99FF:black";

let highlightDecorations: vscode.TextEditorDecorationType[] = [];
let highlightWords: (string | undefined)[] = [];
let nextHighlight = 0;

// --------------------- Utility Functions --------------------------
function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSelectedTextOrWord(editor: vscode.TextEditor): string | undefined {
    const selection = editor.selection;
    if (!selection.isEmpty) {
        return editor.document.getText(selection);
    }
    const wordRange = editor.document.getWordRangeAtPosition(selection.start);
    return wordRange ? editor.document.getText(wordRange) : undefined;
}

// --------------------- Highlight Functions --------------------------
function chooseNextHighlight(): number {
    const start = nextHighlight;
    let idx = nextHighlight;
    do {
        if (!highlightWords[idx]) {
            return idx;
        }
        idx = (idx + 1) % highlightDecorations.length;
    } while (idx !== start);
    return idx;
}

function addHighlight(editor: vscode.TextEditor, text: string) {
    removeHighlightForText(editor, text);
    const idx = chooseNextHighlight();
    highlightWords[idx] = text;
    nextHighlight = (idx + 1) % highlightDecorations.length;
    applyHighlightForText(editor, text, idx);
}

function applyHighlightForText(
    editor: vscode.TextEditor,
    text: string,
    idx: number
) {
    const fullText = editor.document.getText();
    // Removed word boundaries (\b) so that special characters like --> can be matched.
    const regex = new RegExp(escapeRegExp(text), "g");
    const decorationOptions: vscode.DecorationOptions[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(fullText)) !== null) {
        const startPos = editor.document.positionAt(match.index);
        const endPos = editor.document.positionAt(match.index + text.length);
        decorationOptions.push({ range: new vscode.Range(startPos, endPos) });
    }
    editor.setDecorations(highlightDecorations[idx], decorationOptions);
}

function removeHighlightForText(editor: vscode.TextEditor, text: string) {
    const idx = highlightWords.findIndex((w) => w === text);
    if (idx === -1) {
        return;
    }
    editor.setDecorations(highlightDecorations[idx], []);
    highlightWords[idx] = undefined;
    nextHighlight = idx;
}

function toggleHighlight() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    const text = getSelectedTextOrWord(editor);
    if (!text) {
        return;
    }
    const idx = highlightWords.findIndex((w) => w === text);
    if (idx === -1) {
        addHighlight(editor, text);
    } else {
        removeHighlightForText(editor, text);
    }
}

function clearHighlights() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    highlightDecorations.forEach((decoration) =>
        editor.setDecorations(decoration, [])
    );
    highlightWords.fill(undefined);
    nextHighlight = 0;
}

function reapplyHighlights(editor: vscode.TextEditor) {
    const fullText = editor.document.getText();
    const wordsWithIndex = highlightWords
        .map((word, idx) => ({ word, idx }))
        .filter((item) => item.word);
    if (wordsWithIndex.length === 0) {
        return;
    }
    const pattern =
        "(" +
        wordsWithIndex.map((item) => escapeRegExp(item.word!)).join("|") +
        ")";
    const regex = new RegExp(pattern, "g");
    const decorationOptions: { [idx: number]: vscode.DecorationOptions[] } = {};
    for (const item of wordsWithIndex) {
        decorationOptions[item.idx] = [];
    }
    let match: RegExpExecArray | null;
    while ((match = regex.exec(fullText)) !== null) {
        const matchedText = match[0];
        const idx = highlightWords.findIndex((w) => w === matchedText);
        if (idx !== -1) {
            const startPos = editor.document.positionAt(match.index);
            const endPos = editor.document.positionAt(
                match.index + matchedText.length
            );
            decorationOptions[idx].push({
                range: new vscode.Range(startPos, endPos),
            });
        }
    }
    for (const idxStr in decorationOptions) {
        const idx = Number(idxStr);
        editor.setDecorations(
            highlightDecorations[idx],
            decorationOptions[idx]
        );
    }
}

// --------------------- Chain Grep Functions -------------------------
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

function applyChainQuery(lines: string[], query: ChainGrepQuery): string[] {
    if (query.type === "text") {
        return lines.filter((line) => {
            let match: boolean;
            if (!query.caseSensitive) {
                match = line.toLowerCase().includes(query.query.toLowerCase());
            } else {
                match = line.includes(query.query);
            }
            return query.inverted ? !match : match;
        });
    } else {
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

function buildChainSummary(chain: ChainGrepQuery[]): string {
    const parts = chain.map((query) => {
        let prefix = query.type === "text" ? "T:" : "R:";
        if (query.inverted) {
            prefix += "!";
        }
        if (query.caseSensitive) {
            prefix += "C";
        }
        let queryStr = `'${query.query}'`;
        if (query.type === "regex" && query.flags) {
            queryStr += ` (${query.flags})`;
        }
        return `${prefix}${queryStr}`;
    });
    return "Chain Grep: " + parts.join(" -> ");
}

function buildChainDetailedHeader(chain: ChainGrepQuery[]): string {
    const headerLines: string[] = [];
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
        step += query.caseSensitive
            ? " (Case Sensitive)"
            : " (Case Insensitive)";
        headerLines.push(step);
    });
    headerLines.push("-------------------------");
    return headerLines.join("\n");
}

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
        reapplyHighlights(editor);
    }
}

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
    reapplyHighlights(editor);
}

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
    quickPick.title = "Toggle options:\t• Invert\t• Case Sensitive\t\t -->";
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

// --------------------- Extension Activation -------------------------
export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration("multi-highlight");
    const coloursStr = config.get<string>("colours") || DEFAULT_COLOURS;
    const colours = coloursStr.split(",").map((pair) =>
        pair
            .trim()
            .split(":")
            .map((c) => c.trim())
    );
    highlightDecorations = [];
    highlightWords = [];
    colours.forEach((colourPair) => {
        highlightDecorations.push(
            vscode.window.createTextEditorDecorationType({
                backgroundColor: colourPair[0],
                color: colourPair[1],
                borderRadius: "4px",
            })
        );
        highlightWords.push(undefined);
    });
    nextHighlight = 0;

    // Commands for chain grep
    const findTextCommand = vscode.commands.registerTextEditorCommand(
        "chainGrep.findText",
        async (editor) => {
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
            const caseSensitive = options.includes("Case Sensitive");

            const { chain, sourceUri } = getChainForEditor(editor);
            const newQuery: ChainGrepQuery = {
                type: "text",
                query: queryText,
                inverted,
                caseSensitive,
            };
            const newChain = [...chain, newQuery];
            await executeChainSearchAndDisplayResults(sourceUri, newChain);
        }
    );

    const findRegexCommand = vscode.commands.registerTextEditorCommand(
        "chainGrep.findRegex",
        async (editor) => {
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
            if (!isRegexValid(regexInput)) {
                vscode.window.showInformationMessage(
                    "Invalid regular expression input (illegal single slash)."
                );
                return;
            }
            let pattern: string;
            let flags: string = "";
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
            await executeChainSearchAndDisplayResults(sourceUri, newChain);
        }
    );

    const grepSelectionCommand = vscode.commands.registerTextEditorCommand(
        "chainGrep.grepSelection",
        async (editor) => {
            const selection = editor.selection;
            let selectedText = editor.document.getText(selection).trim();
            if (!selectedText) {
                selectedText = "";
            }
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
            await executeChainSearchAndDisplayResults(sourceUri, newChain);
        }
    );

    const refreshChainCommand = vscode.commands.registerTextEditorCommand(
        "chainGrep.refresh",
        async (chainEditor) => {
            // chainEditor is the one containing chain grep results.
            const chainDocUri = chainEditor.document.uri;
            const docUri = chainDocUri.toString();
            if (!chainGrepMap.has(docUri)) {
                vscode.window.showInformationMessage(
                    "No chain grep found for this document."
                );
                return;
            }
            const chainInfo = chainGrepMap.get(docUri)!;
            const sourceUri = chainInfo.sourceUri;
            try {
                // 1) Open the source file.
                const sourceDoc = await vscode.workspace.openTextDocument(
                    sourceUri
                );
                await vscode.window.showTextDocument(sourceDoc, {
                    preview: false,
                });

                // 2) Revert external changes.
                await vscode.commands.executeCommand(
                    "workbench.action.files.revert"
                );

                // 3) Wait a bit to ensure revert is finished.
                setTimeout(async () => {
                    // 4) Return to chain grep doc.
                    const chainDoc = await vscode.workspace.openTextDocument(
                        chainDocUri
                    );
                    const newChainEditor = await vscode.window.showTextDocument(
                        chainDoc,
                        {
                            preview: false,
                        }
                    );

                    // 5) Execute chain refresh with updated source file.
                    await executeChainSearchAndUpdateEditor(
                        sourceUri,
                        chainInfo.chain,
                        newChainEditor
                    );
                }, 250);
            } catch {
                vscode.window.showInformationMessage(
                    "Unable to refresh the source document."
                );
            }
        }
    );

    // Commands for highlight
    const toggleHighlightCommand = vscode.commands.registerTextEditorCommand(
        "chainGrep.toggleHighlight",
        () => {
            toggleHighlight();
        }
    );

    const clearHighlightsCommand = vscode.commands.registerTextEditorCommand(
        "chainGrep.clearHighlights",
        () => {
            clearHighlights();
        }
    );

    // Always re-apply highlights for any open file when it becomes active
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                reapplyHighlights(editor);
            }
        })
    );

    // Register all commands
    context.subscriptions.push(
        findTextCommand,
        findRegexCommand,
        grepSelectionCommand,
        refreshChainCommand,
        toggleHighlightCommand,
        clearHighlightsCommand
    );
}

export function deactivate() {}
