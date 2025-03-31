# Chain Grep

<div align="center">
  <img src="icons/Logo.png" alt="Chain Grep Logo" width="120" />
</div>

<br>

> Chain searches, bookmark findings, and highlight patterns in VS Code

Chain Grep enhances VS Code's search capabilities with progressive refinement, intelligent bookmarking, and powerful highlighting - making it ideal for logs, debugging, and code exploration.

## Features

### 🔍 Chained Text Searches

Build sequences of text/regex searches with each step filtering the results of the previous.

-   Create progressive search chains with text or regex patterns
-   Filter results with case-sensitivity and inversion options
-   View results in separate documents that update when sources change
-   Organize chains in a dedicated Activity Bar view

### 🔖 Smart Bookmarks

Track important lines across source and result documents with automatic synchronization.

-   Bookmark lines in source and chain grep results
-   Automatic synchronization of bookmarks between related documents
-   Custom labels and visual indicators for bookmarked lines
-   Intelligent position tracking when files change
-   Quick navigation via the bookmarks sidebar

### 🎨 Flexible Highlighting

Highlight important terms with both local and global scope options.

-   Two highlight modes:
    -   **Local**: Highlights visible only in the current chain
    -   **Global**: Highlights visible across your entire workspace
-   Automatic restoration of highlights when switching files
-   Customizable colors with background/foreground pairs
-   Quick toggle buttons and keyboard shortcuts
-   Comprehensive management via the highlights sidebar

## Getting Started

### Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=rejzerek.chain-grep) or download from [GitHub](https://github.com/Razuer/chain-grep/releases).

### Basic Usage

1. Open any file in VS Code
2. Use one of these approaches to start:
    - Command Palette (`Ctrl+Shift+P`): Search for "Chain Grep"
    - Right-click context menu: Select "Chain Grep"
    - Keyboard shortcuts (see below)
3. Enter your search pattern and options
4. Chain additional searches from the results document
5. Add bookmarks and highlights to mark important information

### Keyboard Shortcuts

| Command                 | Shortcut           | Description                           |
| ----------------------- | ------------------ | ------------------------------------- |
| Grep Selection          | `Ctrl+Alt+G`       | Search for selected text              |
| Toggle Highlight        | `Ctrl+Alt+M`       | Toggle local highlight for selection  |
| Toggle Global Highlight | `Ctrl+Alt+Shift+M` | Toggle global highlight for selection |
| Add Bookmark            | `Ctrl+Alt+B`       | Add bookmark at current line          |

## Configuration

Customize Chain Grep through VS Code settings:

```json
{
    // Bookmark appearance
    "chainGrep.bookmarks.color": "#3794FF",
    "chainGrep.bookmarks.showSymbols": true,
    "chainGrep.bookmarks.showLabels": true,

    // Highlight colors
    "chainGrep.highlights.palette": "#89CFF0:black, #FF6961:black, #77DD77:black",
    "chainGrep.highlights.randomOrder": false,
    "chainGrep.highlights.showScrollbarIndicators": true,

    // Result documents
    "chainGrep.chainedDocuments.showDetailedInfo": true,

    // System settings
    "chainGrep.system.saveStateInProject": false
}
```

## Remote Development Support

When working with remote environments (SSH, Containers, WSL), enable `chainGrep.system.saveStateInProject` to store extension state in your project's `.vscode` folder. This ensures bookmarks, highlights, and chains are available in both local and remote contexts.

---

## Support and Feedback

-   [GitHub Repository](https://github.com/Razuer/chain-grep)
-   [Issue Tracker](https://github.com/Razuer/chain-grep/issues)

## License

[MIT](LICENSE)
