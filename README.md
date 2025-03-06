# CHAIN GREP

![Chain Grep Icon](icons/icon.png)

**Chain Grep** is a Visual Studio Code extension that lets you build and execute a sequence of chained text or regex searches on any source file. You can progressively refine your search results, refresh them when the file changes, and highlight text or other snippets. This makes it perfect for searching logs, debugging output, or any other text files. The extension provides an intuitive search interface with clear visual indication of search modes and options. In addition, you can quickly grep selected text using a custom keybinding.

## Key Features

-   **Chained Searches**: Combine multiple searches (text or regex) in a chain, each refining the results of the previous step.
-   **Custom Popup**: A minimal QuickPick-based interface for entering your query and toggling "Invert" or "Case Sensitive".
-   **Selection Shortcut**: Press `CTRL+ALT+G` (or your custom keybinding) to grep any currently selected text.
-   **Results in a Separate Document**: Each chain's results appear in a new document, which can show just the matches or include a more detailed log, depending on your settings.
-   **Activity Bar Tree**: The extension displays a tree in the Activity Bar, showing each file's chain entries. You can expand, open, or close nodes, making it easy to navigate multiple chain results.
-   **Highlighting System**:
    -   Toggle highlights for any string or special character
    -   Persistent highlights across file switches
    -   Local (chained) highlights specific to related files
    -   Global highlights visible across your entire workspace
    -   Quick clear buttons for all highlight types
    -   Optional scrollbar indicators for all highlights
-   **Intelligent Color Management**:
    -   Configurable color palette with background/foreground pairs
    -   Optional random color assignment from palette
    -   Automatic color recycling when highlighting many terms
-   **Results Management**: Easily manage all search results with one-click options to close all results or clear all highlights.
-   **Automatic Re-Highlighting**: Whenever you return to a file, any highlights you had before are restored.
-   **Easy Refresh**: The "Chain Grep: Refresh" command reverts the source file from disk (pulling in external changes, if any) and reapplies the entire chain.
-   **Smart Memory Management**: Automatic cleanup of unused resources with configurable intervals.
-   **Theme-Aware Icons**: All icons adapt automatically to light and dark themes for a consistent look.
-   **Optional Multiline Regex**: When using regex, the extension can optionally apply `s` (dotall) flag automatically.

## Usage

### Commands

-   **Chain Grep: Grep Text**: Opens the popup for a plain-text query with clear interface indicators.
-   **Chain Grep: Grep Regex**: Opens the popup for a regex query with syntax hints and pattern examples.
-   **Chain Grep: Grep Selection**: Prefills the popup with your selection and executes a text search.
-   **Chain Grep: Refresh**: Re-runs the search chain on the updated source file.
-   **Chain Grep: Toggle Chained Highlight**: Toggles highlighting for the selection or word under the cursor for chained files.
-   **Chain Grep: Clear Chained Highlights**: Removes all chained highlights for the current file.
-   **Chain Grep: Toggle Global Highlight**: Toggles highlighting for the selection or word under the cursor globally.
-   **Chain Grep: Clear Global Highlights**: Removes all global highlights.
-   **Chain Grep: Clear Chained Highlights (All Files)**: Removes all chained highlights across all files at once.
-   **Chain Grep: Close All Results**: Closes all search result documents and cleans up the tree view.
-   **Chain Grep: Force Memory Cleanup**: Manually triggers cleanup of unused resources when needed.

### Typical Workflow

1. Open a file in VS Code.
2. Use a Chain Grep command (e.g., "Grep Text" or "Grep Regex") to open the context-aware QuickPick.
3. Enter your query and toggle options using the visual indicators.
4. A new document displays the results.
5. Check the Activity Bar to see a list of chain entries per file.
6. If the source file changes, use **Chain Grep: Refresh**.
7. Use **Toggle Highlight** to mark strings. Return to the file anytime, and highlights remain.

## Installation Options

### 1. Extensions Marketplace

1. Search for "chain-grep" in the Extensions panel.
2. Click **Install**.

### 2. Using a Built Package

1. Download the `.vsix` file from the Releases tab.
2. In VS Code, open the Command Palette (`Ctrl+Shift+P`).
3. Run **Extensions: Install from VSIX...** and select the `.vsix` file.
4. Reload or restart VS Code if needed.

### 3. Build from Source

1. Clone this repository:
    ```bash
    git clone https://github.com/yourusername/chain-grep.git
    cd chain-grep
    ```
2. Install dependencies:
    ```bash
    npm install
    ```
3. Compile:
    ```bash
    npm run compile
    ```
4. Package (optional):
    ```bash
    npm install -g vsce
    vsce package
    ```
    This creates a `.vsix` you can install in VS Code.

## Keybindings

The extension provides default keybindings. Make sure they are not overridden by other user or system keybindings. If they are, you can edit them manually in your keybindings configuration:

```jsonc
{
    "command": "chainGrep.grepSelection",
    "key": "ctrl+alt+g",
    "when": "editorTextFocus"
},
{
    "command": "chainGrep.toggleHighlight",
    "key": "ctrl+alt+m",
    "when": "editorTextFocus"
},
{
    "command": "chainGrep.toggleHighlightGlobal",
    "key": "ctrl+alt+shift+m",
    "when": "editorTextFocus"
}
```

## Settings in `settings.json`

Below are some optional configuration keys that can be added to your user or workspace settings:

```json
{
    "chainGrep.randomColors": false,
    "chainGrep.colours": "#89CFF0:black, #FF6961:black",
    "chainGrep.detailedChainDoc": true,
    "chainGrep.showScrollbarIndicators": true,
    "chainGrep.cleanupInterval": 5,
    "chainGrep.maxBaseNameLength": 70,
    "chainGrep.maxChainDescriptorLength": 30
}
```

-   **`chainGrep.randomColors` (boolean)**

    -   `true` => Shuffles the highlight color palette randomly.
    -   `false` => Uses the palette in the given order.
    -   Default is `false`.

-   **`chainGrep.colours` (string)**

    -   A comma-separated list of color pairs in the format `background:foreground`, e.g. `#89CFF0:black, #FF6961:black`.
    -   If not set, the extension uses a default palette.

-   **`chainGrep.detailedChainDoc` (boolean)**

    -   `true` => Displays detailed chain steps (header, queries, flags) in the results doc.
    -   `false` => Shows only the raw matched lines.
    -   Default is `true`.

-   **`chainGrep.showScrollbarIndicators` (boolean)**

    -   `true` => Shows highlight indicators in the scrollbar (overview ruler).
    -   `false` => Hides highlight indicators in the scrollbar.
    -   Default is `true`.

-   **`chainGrep.cleanupInterval` (number)**

    -   Time in minutes between automatic cleanups of unused resources.
    -   Set to 0 to disable automatic cleanup.
    -   Default is 5 minutes.

-   **`chainGrep.maxBaseNameLength` (number)**

    -   Maximum length of source filename in result documents filenames.
    -   Set to 0 to disable truncation.
    -   Default is 70 characters.

-   **`chainGrep.maxChainDescriptorLength` (number)**
    -   Maximum length of chain descriptor in result documents filenames.
    -   Set to 0 to disable truncation.
    -   Default is 30 characters.

## Contributing

Contributions, issues, and feature requests are welcome! Please feel free to fork the repository and open a pull request.

## License

This project is licensed under the [MIT License](LICENSE).
