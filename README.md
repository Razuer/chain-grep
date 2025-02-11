# Chain Grep

**Chain Grep** is a Visual Studio Code extension that allows you to build and execute a series of chained text or regex searches on your source file. You can progressively refine your search results and then refresh them when the source file changes. The extension includes a minimal popup that accepts your query along with toggle options for "Invert" and "Case Sensitive" search. Additionally, you can quickly grep your currently selected text using a custom keybinding.

## Features

-   **Chained Searches:**  
    Build a series of search queries (text or regex) that are applied sequentially to your file.

-   **Custom Popup Input:**  
    A minimal popup (using VS Code's built-in QuickPick) provides a text input along with two toggle buttons:

    -   **Invert:** Exclude matching lines.
    -   **Case Sensitive:** Perform case-sensitive search (off by default; meaning searches are case-insensitive).

-   **Grep Selection Shortcut:**  
    Use the `CTRL+ALT+G` shortcut (or your custom keybinding) to automatically pre-fill the popup with your selected text in the editor.

-   **Refresh Results:**  
    Easily re-run the entire chain on the updated source file and refresh the output document.

-   **Result Output:**  
    The results are displayed in a new unsaved document with a concise summary (used as the tab title) and a detailed header that shows each step of the chain.

## Installation

### 2. Use my built package

#### Prerequisites

-   [Visual Studio Code](https://code.visualstudio.com/)

#### Steps
1. **Download `.vsix` file which you can find in Releases tab**
2. **Install in VS Code:**

-   Open VS Code.
-   Open the Command Palette (`Ctrl+Shift+P`).
-   Run **Extensions: Install from VSIX...** and select the generated `.vsix` file.
-   Reload or restart VS Code if necessary.

### 2. Or build it yourself

#### Prerequisites

-   [Node.js](https://nodejs.org/)
-   [Visual Studio Code](https://code.visualstudio.com/)

#### Steps

1. **Clone the Repository:**

    ```bash
    git clone https://github.com/yourusername/chain-grep.git
    cd chain-grep
    ```

2. **Install Dependencies:**

    ```bash
    npm install
    ```

3. **Compile the Extension:**

    ```bash
    npm run compile
    ```

4. **Package the Extension (Optional):**
   Install `vsce` if you haven't already:

    ```bash
    npm install -g vsce
    ```

    Then package:

    ```bash
    vsce package
    ```

    This will create a `.vsix` file which you can install in VS Code.

5. **Install in VS Code:**
    - Open VS Code.
    - Open the Command Palette (`Ctrl+Shift+P`).
    - Run **Extensions: Install from VSIX...** and select the generated `.vsix` file.
    - Reload or restart VS Code if necessary.

## Usage

### Commands

-   **Chain Grep: Find Text**  
    Opens the popup for a text search. Enter your query and toggle the options ("Invert" and "Case Sensitive") as needed.

-   **Chain Grep: Find Regex**  
    Opens the popup for a regex search. Enter your regex query (optionally in `/pattern/flags` format) and toggle the options.

-   **Chain Grep: Grep Selection**  
    If you have text selected in your editor, use this command (or press `CTRL+ALT+G`) to open the popup pre-filled with the selected text.

-   **Chain Grep: Refresh**  
    Re-runs the entire chain on the source file to update your results.

### Workflow

1. Open a file in VS Code.
2. Use one of the commands (via Command Palette or keybinding) to open the custom popup.
3. Enter your query (or use the pre-filled text from your selection) and toggle the options.
4. The extension will execute the chain of queries and open a new unsaved document with the results.
5. If the source file is updated, use the **Refresh** command to re-run the chain and update the output.

## Keybindings

The extension provides a default keybinding for grepping the selected text:

```json
{
    "command": "chainGrep.grepSelection",
    "key": "ctrl+alt+g",
    "when": "editorTextFocus"
}
```

You can modify this in your `package.json` under the `"contributes.keybindings"` section or in your user keybindings.

## Contributing

Contributions, issues, and feature requests are welcome!  
Feel free to fork the repository and open a pull request.

## License

This project is licensed under the [MIT License](LICENSE).
