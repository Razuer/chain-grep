import * as vscode from "vscode";
import { isRegexValid } from "./configService";

export async function showQueryAndOptionsQuickInput(
    defaultQuery?: string,
    searchType: "text" | "regex" = "text"
) {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title =
        searchType === "text"
            ? "Chain Grep | Text Search"
            : "Chain Grep | Regex Search";

    quickPick.placeholder =
        searchType === "text"
            ? "Enter search query here..."
            : "Enter regex pattern (e.g. foo|bar, \\bword\\b)...";

    quickPick.ignoreFocusOut = true;

    if (defaultQuery) {
        quickPick.value = defaultQuery;
    }

    let invertSelected = false;
    let caseSensitiveSelected = false;

    quickPick.buttons = [
        {
            iconPath: new vscode.ThemeIcon("arrow-swap"),
            tooltip: "Invert (Off)",
        },
        {
            iconPath: new vscode.ThemeIcon("case-sensitive"),
            tooltip: "Case Sensitive (Off)",
        },
    ];

    quickPick.onDidTriggerButton((button) => {
        if (button.tooltip?.startsWith("Invert")) {
            invertSelected = !invertSelected;
        } else if (button.tooltip?.startsWith("Case Sensitive")) {
            caseSensitiveSelected = !caseSensitiveSelected;
        }

        quickPick.buttons = [
            {
                iconPath: new vscode.ThemeIcon(
                    invertSelected ? "check" : "arrow-swap"
                ),
                tooltip: `Invert (${invertSelected ? "On" : "Off"})`,
            },
            {
                iconPath: new vscode.ThemeIcon(
                    caseSensitiveSelected ? "check" : "case-sensitive"
                ),
                tooltip: `Case Sensitive (${
                    caseSensitiveSelected ? "On" : "Off"
                })`,
            },
        ];
    });

    return new Promise<{ query: string; options: string[] } | undefined>(
        (resolve) => {
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
        }
    );
}

export function processRegexInput(
    input: string
): { pattern: string; flags: string } | null {
    if (!isRegexValid(input)) {
        vscode.window.showInformationMessage(
            "Invalid regular expression input (illegal single slash)."
        );
        return null;
    }

    let pattern: string;
    let flags = "";

    if (input.startsWith("/") && input.lastIndexOf("/") > 0) {
        const lastSlash = input.lastIndexOf("/");
        pattern = input.substring(1, lastSlash);
        flags = input.substring(lastSlash + 1);
    } else {
        pattern = input;
    }

    return { pattern: pattern.replace(/\/\//g, "/"), flags };
}
