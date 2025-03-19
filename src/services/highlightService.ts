import * as vscode from "vscode";
import { LocalHighlightState } from "../models/interfaces";
import { ColorQueue } from "./colorQueue";
import {
    loadConfiguredPalette,
    areRandomColorsEnabled,
    areScrollbarIndicatorsEnabled,
} from "./configService";
import { escapeRegExp } from "../utils/utils";

let highlightDecorations: vscode.TextEditorDecorationType[] = [];

let globalHighlightWords: (string | undefined)[] = [];
let globalHighlightColorMap: Map<string, number> = new Map();
let globalColorIndexes: number[] = [];
let globalColorQueue: ColorQueue;

const localHighlightMap = new Map<string, LocalHighlightState>();
const localHighlightColorMaps: Map<string, Map<string, number>> = new Map();
const localColorIndexMaps: Map<string, number[]> = new Map();
const localColorQueues = new Map<string, ColorQueue>();

function darkenColor(color: string): string {
    if (!color.startsWith("#")) {
        return color;
    }

    let r = parseInt(color.slice(1, 3), 16);
    let g = parseInt(color.slice(3, 5), 16);
    let b = parseInt(color.slice(5, 7), 16);

    r = Math.floor(r * 0.5);
    b = Math.floor(b * 0.5);
    g = Math.floor(g * 0.5);

    r = Math.max(0, r);
    g = Math.max(0, g);
    b = Math.max(0, b);

    return `#${r.toString(16).padStart(2, "0")}${g
        .toString(16)
        .padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

export function initHighlightDecorations() {
    let palette = loadConfiguredPalette();
    let globalColoursArr = palette.split(",").map((pair) =>
        pair
            .trim()
            .split(":")
            .map((c) => c.trim())
    );

    highlightDecorations.forEach((decoration) => decoration.dispose());

    highlightDecorations = [];

    if (globalHighlightWords.length === 0) {
        globalHighlightWords = [];
    }

    globalColorQueue = new ColorQueue(
        globalColoursArr.length,
        areRandomColorsEnabled(),
        true
    );

    const showScrollbarIndicators = areScrollbarIndicatorsEnabled();

    globalColoursArr.forEach(([bg, fg]) => {
        const borderColor = darkenColor(bg);

        const decorationOptions: vscode.DecorationRenderOptions = {
            backgroundColor: bg,
            color: fg,
            borderRadius: "4px",
            isWholeLine: false,
            border: `1px solid ${borderColor}`,
            fontWeight: "bold",
        };

        if (showScrollbarIndicators) {
            decorationOptions.overviewRulerColor = bg;
            decorationOptions.overviewRulerLane =
                vscode.OverviewRulerLane.Right;
        }

        highlightDecorations.push(
            vscode.window.createTextEditorDecorationType(decorationOptions)
        );
        if (globalHighlightWords.length < highlightDecorations.length) {
            globalHighlightWords.push(undefined);
        }
    });

    console.log(
        `Chain Grep: Initialized ${highlightDecorations.length} global highlight decorations`
    );
}

// Alias for compatibility with both versions
export const initGlobalHighlightDecorations = initHighlightDecorations;

function chooseNextGlobalHighlight(): number {
    return globalColorQueue.getNextIndex();
}

export function addHighlightGlobal(editor: vscode.TextEditor, text: string) {
    removeHighlightForTextGlobal(text);

    const idx = chooseNextGlobalHighlight();

    globalHighlightWords[idx] = text;
    globalHighlightColorMap.set(text, idx);
    applyHighlightForTextGlobal(editor, text, idx);
}

function applyHighlightForTextGlobal(
    editor: vscode.TextEditor,
    text: string,
    idx: number
) {
    if (idx >= highlightDecorations.length) {
        console.error(
            `Chain Grep: Invalid highlight index ${idx}, max is ${
                highlightDecorations.length - 1
            }`
        );
        return;
    }

    const fullText = editor.document.getText();
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

export function removeHighlightForTextGlobal(text: string) {
    const idx = globalHighlightWords.findIndex((w) => w === text);
    if (idx === -1) {
        return;
    }
    for (const ed of vscode.window.visibleTextEditors) {
        ed.setDecorations(highlightDecorations[idx], []);
    }
    globalHighlightWords[idx] = undefined;

    if (globalColorQueue) {
        globalColorQueue.releaseIndex(idx);
    }
}

export function toggleHighlightGlobal(
    editor: vscode.TextEditor,
    selectionText: string | undefined,
    chainGrepMap: Map<string, any>
) {
    if (!selectionText) {
        return;
    }

    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getLocalHighlightState(groupKey);
    const localIdx = state.words.findIndex((w) => w === selectionText);

    if (localIdx !== -1) {
        removeHighlightForTextLocal(docUri, selectionText, chainGrepMap);
    }

    const idx = globalHighlightWords.findIndex((w) => w === selectionText);
    if (idx === -1) {
        addHighlightGlobal(editor, selectionText);
    } else {
        removeHighlightForTextGlobal(selectionText);
    }
    reapplyAllGlobalHighlights();
}

export function clearHighlightsGlobal(showMessage = true): boolean {
    if (globalHighlightWords.every((w) => w === undefined)) {
        if (showMessage) {
            vscode.window.showInformationMessage(
                "Chain Grep: No global highlights to clear"
            );
        }
        return false;
    }

    for (const ed of vscode.window.visibleTextEditors) {
        highlightDecorations.forEach((dec) => {
            ed.setDecorations(dec, []);
        });
    }
    globalHighlightWords.fill(undefined);
    globalHighlightColorMap.clear();

    if (globalColorQueue) {
        globalColorQueue = new ColorQueue(
            highlightDecorations.length,
            areRandomColorsEnabled(),
            true
        );
    }

    if (showMessage) {
        vscode.window.showInformationMessage(
            "Chain Grep: Cleared all global highlights"
        );
    }

    return true;
}

export function reapplyAllGlobalHighlights() {
    for (const ed of vscode.window.visibleTextEditors) {
        reapplyHighlightsGlobal(ed);
    }
}

export function reapplyHighlightsGlobal(editor: vscode.TextEditor) {
    const wordsWithIndex = globalHighlightWords
        .map((word, idx) => ({ word, idx }))
        .filter((item) => item.word !== undefined);

    if (!wordsWithIndex.length) {
        return;
    }

    for (const { word, idx } of wordsWithIndex) {
        if (word && idx < highlightDecorations.length) {
            applyHighlightForTextGlobal(editor, word, idx);
        }
    }
}

export function getLocalHighlightKey(
    docUri: string,
    chainGrepMap: Map<string, any>
): string {
    if (chainGrepMap.has(docUri)) {
        const chainInfo = chainGrepMap.get(docUri)!;
        return chainInfo.sourceUri.toString();
    }
    return docUri;
}

export function getLocalHighlightState(groupKey: string): LocalHighlightState {
    let existing = localHighlightMap.get(groupKey);
    if (!existing) {
        const newDecs = createHighlightDecorationsFromColours(groupKey);
        existing = {
            decorations: newDecs,
            words: new Array(newDecs.length).fill(undefined),
            next: 0,
        };
        localHighlightMap.set(groupKey, existing);
    }
    return existing;
}

function createHighlightDecorationsFromColours(
    groupKey: string
): vscode.TextEditorDecorationType[] {
    let palette = loadConfiguredPalette();
    let coloursArr = palette.split(",").map((pair) =>
        pair
            .trim()
            .split(":")
            .map((c) => c.trim())
    );

    localColorQueues.set(
        groupKey,
        new ColorQueue(coloursArr.length, areRandomColorsEnabled(), false)
    );

    const showScrollbarIndicators = areScrollbarIndicatorsEnabled();

    return coloursArr.map(([bg, fg]) => {
        const decorationOptions: vscode.DecorationRenderOptions = {
            backgroundColor: bg,
            color: fg,
            borderRadius: "4px",
            isWholeLine: false,
        };

        if (showScrollbarIndicators) {
            decorationOptions.overviewRulerColor = bg;
            decorationOptions.overviewRulerLane =
                vscode.OverviewRulerLane.Right;
        }

        return vscode.window.createTextEditorDecorationType(decorationOptions);
    });
}

function chooseNextLocalHighlight(groupKey: string): number {
    if (!localColorQueues.has(groupKey)) {
        const state = getLocalHighlightState(groupKey);
        localColorQueues.set(
            groupKey,
            new ColorQueue(state.decorations.length, areRandomColorsEnabled())
        );
    }

    return localColorQueues.get(groupKey)!.getNextIndex();
}

export function addHighlightLocal(
    editor: vscode.TextEditor,
    text: string,
    chainGrepMap: Map<string, any>
) {
    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getLocalHighlightState(groupKey);

    removeHighlightForTextLocal(docUri, text, chainGrepMap);

    const idx = chooseNextLocalHighlight(groupKey);

    state.words[idx] = text;

    if (!localHighlightColorMaps.has(groupKey)) {
        localHighlightColorMaps.set(groupKey, new Map<string, number>());
    }
    localHighlightColorMaps.get(groupKey)!.set(text, idx);

    applyHighlightForTextLocal(editor, text, idx, chainGrepMap);
}

function applyHighlightForTextLocal(
    editor: vscode.TextEditor,
    text: string,
    idx: number,
    chainGrepMap: Map<string, any>
) {
    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getLocalHighlightState(groupKey);

    if (idx >= state.decorations.length) {
        console.error(
            `Chain Grep: Invalid local highlight index ${idx} for group ${groupKey}, max is ${
                state.decorations.length - 1
            }`
        );
        return;
    }

    function decorateSingle(ed: vscode.TextEditor) {
        if (
            getLocalHighlightKey(ed.document.uri.toString(), chainGrepMap) !==
            groupKey
        ) {
            return;
        }
        const fullText = ed.document.getText();
        const regex = new RegExp(escapeRegExp(text), "g");
        const decoOpts: vscode.DecorationOptions[] = [];
        let match: RegExpExecArray | null;
        while ((match = regex.exec(fullText)) !== null) {
            const startPos = ed.document.positionAt(match.index);
            const endPos = ed.document.positionAt(match.index + text.length);
            decoOpts.push({ range: new vscode.Range(startPos, endPos) });
        }
        ed.setDecorations(state.decorations[idx], decoOpts);
    }

    decorateSingle(editor);

    for (const ed of vscode.window.visibleTextEditors) {
        if (ed === editor) {
            continue;
        }
        if (
            getLocalHighlightKey(ed.document.uri.toString(), chainGrepMap) ===
            groupKey
        ) {
            decorateSingle(ed);
        }
    }
}

export function removeHighlightForTextLocal(
    docUri: string,
    text: string,
    chainGrepMap: Map<string, any>
) {
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getLocalHighlightState(groupKey);
    const idx = state.words.findIndex((w) => w === text);
    if (idx === -1) {
        return;
    }

    for (const ed of vscode.window.visibleTextEditors) {
        if (
            getLocalHighlightKey(ed.document.uri.toString(), chainGrepMap) ===
            groupKey
        ) {
            ed.setDecorations(state.decorations[idx], []);
        }
    }
    state.words[idx] = undefined;

    if (localColorQueues.has(groupKey)) {
        localColorQueues.get(groupKey)!.releaseIndex(idx);
    }
}

export function toggleHighlightLocal(
    editor: vscode.TextEditor,
    text: string | undefined,
    chainGrepMap: Map<string, any>
) {
    if (!text) {
        return;
    }

    const globalHighlightIndex = globalHighlightWords.findIndex(
        (w) => w === text
    );
    if (globalHighlightIndex !== -1) {
        removeHighlightForTextGlobal(text);
    }

    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getLocalHighlightState(groupKey);
    const idx = state.words.findIndex((w) => w === text);
    if (idx === -1) {
        addHighlightLocal(editor, text, chainGrepMap);
    } else {
        removeHighlightForTextLocal(docUri, text, chainGrepMap);
    }
}

export function clearHighlightsLocal(
    editor: vscode.TextEditor,
    chainGrepMap: Map<string, any>
) {
    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getLocalHighlightState(groupKey);

    for (const ed of vscode.window.visibleTextEditors) {
        if (
            getLocalHighlightKey(ed.document.uri.toString(), chainGrepMap) ===
            groupKey
        ) {
            state.decorations.forEach((dec) => {
                ed.setDecorations(dec, []);
            });
        }
    }

    if (localHighlightColorMaps.has(groupKey)) {
        localHighlightColorMaps.get(groupKey)!.clear();
    }

    if (localColorQueues.has(groupKey)) {
        localColorQueues.set(
            groupKey,
            new ColorQueue(
                state.decorations.length,
                areRandomColorsEnabled(),
                false
            )
        );
    }

    state.words.fill(undefined);
    state.next = 0;
}

export function reapplyHighlightsLocal(
    editor: vscode.TextEditor,
    chainGrepMap: Map<string, any>
) {
    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getLocalHighlightState(groupKey);

    for (let i = 0; i < state.words.length; i++) {
        const word = state.words[i];
        if (word && i < state.decorations.length) {
            applyHighlightForTextLocal(editor, word, i, chainGrepMap);
        }
    }
}

export function applyHighlightsToOpenEditors(chainGrepMap: Map<string, any>) {
    try {
        if (highlightDecorations.length === 0) {
            console.log(
                "Chain Grep: Initializing global highlights before applying"
            );
            initHighlightDecorations();
        }

        reapplyAllGlobalHighlights();

        for (const editor of vscode.window.visibleTextEditors) {
            reapplyHighlightsLocal(editor, chainGrepMap);
        }

        console.log(
            "Chain Grep: Successfully applied highlights to all open editors"
        );
        return true;
    } catch (error) {
        console.error(
            "Chain Grep: Error applying highlights to editors",
            error
        );
        return false;
    }
}

export function clearAllLocalHighlights(
    chainGrepMap: Map<string, any>
): number {
    if (localHighlightMap.size === 0) {
        vscode.window.showInformationMessage(
            "Chain Grep: No chained highlights to clear"
        );
        return 0;
    }

    let clearedCount = 0;

    for (const [groupKey, state] of localHighlightMap.entries()) {
        if (state.words.some((w) => w !== undefined)) {
            clearedCount++;

            for (const ed of vscode.window.visibleTextEditors) {
                if (
                    getLocalHighlightKey(
                        ed.document.uri.toString(),
                        chainGrepMap
                    ) === groupKey
                ) {
                    state.decorations.forEach((dec) => {
                        ed.setDecorations(dec, []);
                    });
                }
            }

            if (localHighlightColorMaps.has(groupKey)) {
                localHighlightColorMaps.get(groupKey)!.clear();
            }

            if (localColorQueues.has(groupKey)) {
                localColorQueues.set(
                    groupKey,
                    new ColorQueue(
                        state.decorations.length,
                        areRandomColorsEnabled(),
                        false
                    )
                );
            }

            state.words.fill(undefined);
            state.next = 0;
        }
    }

    if (clearedCount > 0) {
        vscode.window.showInformationMessage(
            `Chain Grep: Cleared chained highlights for ${clearedCount} document(s)`
        );
    } else {
        vscode.window.showInformationMessage(
            "Chain Grep: No chained highlights found to clear"
        );
    }

    return clearedCount;
}

export function getHighlightState() {
    const state = {
        globalHighlightWords,
        globalHighlightColorMap: Array.from(globalHighlightColorMap.entries()),
        globalColorIndexes,
        localHighlights: Array.from(localHighlightMap.entries()).map(
            ([key, state]) => [key, { words: state.words, next: state.next }]
        ),
        localHighlightColorMaps: Array.from(
            localHighlightColorMaps.entries()
        ).map(([key, map]) => [key, Array.from(map.entries())]),
        localColorIndexMaps: Array.from(localColorIndexMaps.entries()),
        globalColorQueue: globalColorQueue ? globalColorQueue.getIndexes() : [],
        localColorQueues: Array.from(localColorQueues.entries()).map(
            ([key, queue]) => [key, queue.getIndexes()]
        ),
    };

    console.log(
        `Chain Grep: Saved highlight state with ${
            globalHighlightWords.filter((w) => w !== undefined).length
        } global highlights`
    );
    return state;
}

export function restoreHighlightState(state: any) {
    try {
        if (!state) {
            console.log("Chain Grep: No highlight state to restore");
            return;
        }

        if (highlightDecorations.length === 0) {
            console.log(
                "Chain Grep: Creating decorations before restoring state"
            );
            initHighlightDecorations();
        }

        if (state.globalHighlightWords) {
            const words = state.globalHighlightWords.slice(
                0,
                highlightDecorations.length
            );
            while (globalHighlightWords.length < words.length) {
                globalHighlightWords.push(undefined);
            }
            for (let i = 0; i < words.length; i++) {
                if (words[i] && words[i].trim() !== "") {
                    globalHighlightWords[i] = words[i];
                } else {
                    globalHighlightWords[i] = undefined;
                }
            }

            const definedWords = words.filter(
                (w: string | undefined): w is string =>
                    w !== undefined && w !== null && w.trim() !== ""
            );

            if (definedWords.length > 0) {
                console.log(
                    `Chain Grep: Restored ${definedWords.length} global highlight words`
                );
            }
        }

        if (state.localHighlights) {
            let restoredGroupCount = 0;
            for (const [key, stateObj] of state.localHighlights) {
                const hasActiveHighlights =
                    Array.isArray(stateObj.words) &&
                    stateObj.words.some(
                        (word: string | undefined) =>
                            word !== undefined &&
                            word !== null &&
                            word.trim() !== ""
                    );

                if (hasActiveHighlights) {
                    const localState = getLocalHighlightState(key);
                    localState.words = stateObj.words;
                    localState.next = stateObj.next;
                    restoredGroupCount++;
                } else {
                    console.log(
                        `Chain Grep: Skipping empty local highlight group for ${key}`
                    );
                }
            }
            console.log(
                `Chain Grep: Restored local highlights for ${restoredGroupCount} groups`
            );
        }

        if (state.globalHighlightColorMap) {
            globalHighlightColorMap = new Map(state.globalHighlightColorMap);
        }

        if (state.localHighlightColorMaps) {
            for (const [key, mapData] of state.localHighlightColorMaps) {
                if (localHighlightMap.has(key)) {
                    localHighlightColorMaps.set(key, new Map(mapData));
                }
            }
        }

        if (state.globalColorIndexes) {
            globalColorIndexes = state.globalColorIndexes;
        }

        if (state.localColorIndexMaps) {
            for (const [key, indexes] of state.localColorIndexMaps) {
                if (localHighlightMap.has(key)) {
                    localColorIndexMaps.set(key, indexes);
                }
            }
        }

        if (state.globalColorQueue) {
            if (!globalColorQueue) {
                globalColorQueue = new ColorQueue(
                    highlightDecorations.length,
                    areRandomColorsEnabled()
                );
            }
            globalColorQueue.setIndexes(state.globalColorQueue);
        }

        if (state.localColorQueues) {
            for (const [key, indexes] of state.localColorQueues) {
                if (localHighlightMap.has(key)) {
                    const queue =
                        localColorQueues.get(key) ||
                        new ColorQueue(
                            indexes.length,
                            areRandomColorsEnabled()
                        );
                    queue.setIndexes(indexes);
                    localColorQueues.set(key, queue);
                }
            }
        }

        console.log("Chain Grep: Successfully restored highlight state");
    } catch (error) {
        console.error("Chain Grep: Error restoring highlight state", error);
    }
}

export function resetAllHighlightDecorations(
    chainGrepMap: Map<string, any>,
    clearHighlights: boolean = false
): void {
    console.log(
        `Chain Grep: Resetting all highlight decorations (clearHighlights: ${clearHighlights})`
    );

    try {
        highlightDecorations.forEach((decoration) => decoration.dispose());

        for (const [groupKey, state] of localHighlightMap.entries()) {
            state.decorations.forEach((decoration) => decoration.dispose());
        }

        if (clearHighlights) {
            const savedGlobalWords = [...globalHighlightWords];
            const savedLocalStates = new Map<
                string,
                { words: (string | undefined)[]; next: number }
            >();

            for (const [groupKey, state] of localHighlightMap.entries()) {
                savedLocalStates.set(groupKey, {
                    words: [...state.words],
                    next: state.next,
                });
            }

            globalHighlightWords = [];
            globalHighlightColorMap.clear();

            localHighlightMap.clear();
            localHighlightColorMaps.clear();
            localColorIndexMaps.clear();
            localColorQueues.clear();

            initHighlightDecorations();

            if (!clearHighlights) {
                for (
                    let i = 0;
                    i <
                    Math.min(
                        savedGlobalWords.length,
                        globalHighlightWords.length
                    );
                    i++
                ) {
                    globalHighlightWords[i] = savedGlobalWords[i];

                    const word = savedGlobalWords[i];
                    if (word !== undefined) {
                        globalHighlightColorMap.set(word, i);
                    }
                }

                for (const [
                    groupKey,
                    savedState,
                ] of savedLocalStates.entries()) {
                    const state = getLocalHighlightState(groupKey);
                    for (
                        let i = 0;
                        i <
                        Math.min(savedState.words.length, state.words.length);
                        i++
                    ) {
                        state.words[i] = savedState.words[i];
                    }
                    state.next = savedState.next;

                    if (!localHighlightColorMaps.has(groupKey)) {
                        localHighlightColorMaps.set(
                            groupKey,
                            new Map<string, number>()
                        );
                    }
                    for (let i = 0; i < savedState.words.length; i++) {
                        const word = savedState.words[i];
                        if (word) {
                            localHighlightColorMaps.get(groupKey)!.set(word, i);
                        }
                    }
                }
            }
        } else {
            initHighlightDecorations();

            for (const [groupKey, state] of localHighlightMap.entries()) {
                const newDecs = createHighlightDecorationsFromColours(groupKey);
                state.decorations = newDecs;
            }
        }

        applyHighlightsToOpenEditors(chainGrepMap);
        console.log(
            "Chain Grep: Successfully reset and reapplied all highlight decorations"
        );
    } catch (error) {
        console.error(
            "Chain Grep: Error resetting highlight decorations",
            error
        );
    }
}
