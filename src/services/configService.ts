import * as vscode from "vscode";

const DEFAULT_COLOURS =
    "#89CFF0:black, #FF6961:black, #77DD77:black, #C3A8FF:black, #FDFD96:black, #A0E7E5:black, #FFB7CE:black, #CCFF90:black, #B19CD9:black, #FF82A9:black, #A8BFFF:black, #FFDAB9:black, #A8D0FF:black, #FFE680:black, #A8E0FF:black, #FFCBA4:black, #E6A8D7:black, #FFCCD2:black, #ACE1AF:black, #FF99FF:black";

function getConfig<T>(key: string, defaultValue?: T): T {
    const config = vscode.workspace.getConfiguration("chainGrep");
    return config.get<T>(key, defaultValue as T);
}

export function loadConfiguredPalette(): string {
    const userPalette = getConfig<string>("highlights.palette", "");
    return userPalette?.trim() ? userPalette : DEFAULT_COLOURS;
}

export function areRandomColorsEnabled(): boolean {
    return getConfig<boolean>("highlights.randomOrder", false);
}

export function isDetailedChainDocEnabled(): boolean {
    return getConfig<boolean>("chainedDocuments.showDetailedInfo", true);
}

export function getMaxBaseNameLength(): number {
    return getConfig<number>("chainedDocuments.maxBaseNameLength", 70);
}

export function getMaxChainDescriptorLength(): number {
    return getConfig<number>("chainedDocuments.maxChainDescriptorLength", 30);
}

export function getCleanupInterval(): number {
    const minutes = getConfig<number>("system.cleanupInterval", 5);
    return minutes * 60 * 1000;
}

export function areScrollbarIndicatorsEnabled(): boolean {
    return getConfig<boolean>("highlights.showScrollbarIndicators", true);
}

export function isCleanupLoggingEnabled(): boolean {
    return getConfig<boolean>("system.cleanupLogging", false);
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

let statusBarItem: vscode.StatusBarItem | undefined;

export function getStatusBar(): vscode.StatusBarItem {
    if (!statusBarItem) {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.name = "Chain Grep";
    }
    return statusBarItem;
}

export function showStatusMessage(message: string, timeout: number = 5000): void {
    const statusBar = getStatusBar();
    statusBar.text = `$(sync) ${message}`;
    statusBar.show();

    setTimeout(() => {
        if (statusBar.text === `$(sync) ${message}`) {
            statusBar.hide();
        }
    }, timeout);
}

export function getBookmarkColor(): string {
    const config = vscode.workspace.getConfiguration("chainGrep");
    return config.get<string>("bookmarks.color") || "#3794FF";
}

export function areBookmarkSymbolsEnabled(): boolean {
    return getConfig<boolean>("bookmarks.showSymbols", true);
}

export function areBookmarkLabelsEnabled(): boolean {
    return vscode.workspace.getConfiguration("chainGrep").get<boolean>("bookmarks.showLabels", true);
}

export function isStateSavingInProjectEnabled(): boolean {
    return vscode.workspace.getConfiguration("chainGrep").get<boolean>("system.saveStateInProject", false);
}

export function handleConfigChange(
    e: vscode.ConfigurationChangeEvent,
    params: {
        cleanupInterval?: NodeJS.Timeout;
        chainGrepMap: Map<string, any>;
        bookmarkProvider: any;
        cleanupUnusedResources: (force: boolean) => void;
        highlightService?: {
            resetAllHighlightDecorations: (map: Map<string, any>, reset?: boolean) => void;
            applyHighlightsToOpenEditors: (map: Map<string, any>) => void;
        };
        savePersistentState?: () => void;
    }
): { cleanupInterval?: NodeJS.Timeout; configUpdated?: boolean } {
    const result: {
        cleanupInterval?: NodeJS.Timeout;
        configUpdated?: boolean;
    } = {};

    const highlightService = params.highlightService || {
        resetAllHighlightDecorations: require("./highlightService").resetAllHighlightDecorations,
        applyHighlightsToOpenEditors: require("./highlightService").applyHighlightsToOpenEditors,
    };

    const savePersistentState = params.savePersistentState || require("./stateService").savePersistentState;

    if (e.affectsConfiguration("chainGrep.system.cleanupInterval")) {
        const intervalMs = getCleanupInterval();
        if (params.cleanupInterval) {
            clearInterval(params.cleanupInterval);
            result.cleanupInterval = undefined;
        }

        if (intervalMs > 0) {
            result.cleanupInterval = setInterval(() => params.cleanupUnusedResources(false), intervalMs);
            showStatusMessage(`ChainGrep: Cleanup interval changed to ${intervalMs / 60000} minutes`);
        } else {
            showStatusMessage(`ChainGrep: Automatic cleanup disabled`);
        }
    }

    if (e.affectsConfiguration("chainGrep.highlights.showScrollbarIndicators")) {
        highlightService.resetAllHighlightDecorations(params.chainGrepMap);
        highlightService.applyHighlightsToOpenEditors(params.chainGrepMap);
    }

    if (e.affectsConfiguration("chainGrep.highlights.palette")) {
        console.log("ChainGrep: Color palette changed, resetting all highlights");
        highlightService.resetAllHighlightDecorations(params.chainGrepMap, true);
    }

    if (e.affectsConfiguration("chainGrep.highlights.randomOrder")) {
        highlightService.resetAllHighlightDecorations(params.chainGrepMap, true);
    }

    if (e.affectsConfiguration("chainGrep.bookmarks.color")) {
        params.bookmarkProvider.updateDecorationStyle();
    }

    if (
        e.affectsConfiguration("chainGrep.bookmarks.showSymbols") ||
        e.affectsConfiguration("chainGrep.bookmarks.showLabels")
    ) {
        params.bookmarkProvider.updateDecorationStyle();
    }

    if (e.affectsConfiguration("chainGrep.system.saveStateInProject") && savePersistentState) {
        const saveInProject = isStateSavingInProjectEnabled();

        savePersistentState();

        if (saveInProject) {
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                vscode.window.showInformationMessage(
                    "Chain Grep: Extension state will now be saved in your project folder, making it available in remote environments."
                );
            }
        } else {
            vscode.window.showInformationMessage(
                "Chain Grep: Extension state will now be saved in VS Code settings, independent of your project folder."
            );
        }

        result.configUpdated = true;
    }

    if (
        e.affectsConfiguration("chainGrep.highlights.palette") ||
        e.affectsConfiguration("chainGrep.highlights.showScrollbarIndicators") ||
        e.affectsConfiguration("chainGrep.highlights.randomOrder") ||
        e.affectsConfiguration("chainGrep.bookmarks.color") ||
        e.affectsConfiguration("chainGrep.bookmarks.showSymbols") ||
        e.affectsConfiguration("chainGrep.bookmarks.showLabels")
    ) {
        savePersistentState();
    }

    return result;
}
