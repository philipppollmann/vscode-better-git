# Better Git

JetBrains-style Git tool window for VS Code — staged/unstaged changes, commit, push, pull, and branch switching directly in the sidebar.

## Installation (Development)

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or newer)
- [VS Code](https://code.visualstudio.com/)

### Steps

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-username/vscode-better-git.git
   cd vscode-better-git
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Compile the extension**
   ```bash
   npm run compile
   ```

4. **Launch in VS Code**

   Open the project in VS Code and press `F5`. A new window (**Extension Development Host**) will open with the extension loaded.

   Alternatively: **Run → Start Debugging**

5. **Click the Git icon in the activity bar**

   In the Extension Development Host a new Git icon appears in the left sidebar. Click it to open the Better Git panel.

## Install as VSIX (optional)

To install the extension permanently without pressing F5 every time:

1. **Install `vsce`**
   ```bash
   npm install -g @vscode/vsce
   ```

2. **Build the VSIX package**
   ```bash
   vsce package
   ```
   This creates a file like `vscode-better-git-0.0.1.vsix`.

3. **Install in VS Code**
   ```bash
   code --install-extension vscode-better-git-0.0.1.vsix
   ```
   Or in VS Code: **Extensions → ··· → Install from VSIX…** → select the file.

## Development

Use watch mode during development so TypeScript recompiles automatically on every save:

```bash
npm run watch
```

After making changes, press `Ctrl+R` in the Extension Development Host to reload the extension.
