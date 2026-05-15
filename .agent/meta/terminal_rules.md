# Rule: Node and Terminal Environment

This rule defines the environment configuration for executing development commands in this project.

### 1. Execution Path
Due to shell path restrictions, always use the absolute path for Node and NPM:
- **Node**: `C:\Users\murad\AppData\Roaming\fnm\aliases\default\node.exe`
- **NPM**: `C:\Users\murad\AppData\Roaming\fnm\aliases\default\npm.cmd`
- **NPX**: `C:\Users\murad\AppData\Roaming\fnm\aliases\default\npx.cmd`

### 2. Shell Environment
- **Shell**: PowerShell
- **Execution Policy**: Ensure commands are compatible with PowerShell syntax.
- **Background Tasks**: When starting long-running processes (like `npm run dev`), use the `run_command` tool with the appropriate `WaitMsBeforeAsync` and the absolute paths mentioned above.

### 3. Usage Example
To start the server:
```powershell
& "C:\Users\murad\AppData\Roaming\fnm\aliases\default\npm.cmd" run dev
```
